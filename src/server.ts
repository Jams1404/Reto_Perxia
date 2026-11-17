import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { GeminiAdapter, toolResultMessage } from "./llm/gemini.js";
import type {
  LlmAdapter,
  LlmMessage,
  LlmResponse,
  LlmToolDefinition,
  LlmToolResult,
} from "./llm/adapter.js";
import {
  herramientas,
  registrar,
  type ToolName,
} from "./tools/contratos.js";
import { logTool } from "./tools/storage.js";
import type { Contract, Context } from "./tools/storage.js";

const root = process.cwd();
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const port = Number(process.env.PORT ?? 3000);
const maxToolIterations = Number(process.env.MAX_TOOL_ITERATIONS ?? 25);
const maxSessionTokens = Number(process.env.MAX_SESSION_TOKENS ?? 30_000);
const requestSchema = z.object({
  sessionId: z.string().min(1).max(100).optional(),
  message: z.string().trim().min(1).max(20_000),
});

type ToolCallRecord = {
  nombre: string;
  argumentos: unknown;
  resultado: string;
};
type ChatEntry = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallRecord[];
  needsConfirmation?: boolean;
  intent?: AgentIntent;
  state?: AgentState;
};
type AgentIntent =
  | "procesar_buzon"
  | "consultar_alertas"
  | "procesar_y_alertar"
  | "confirmar_registro"
  | "conversacion";
type AgentState = "inactivo" | "procesando" | "esperando_confirmacion";
type PendingAction = { mensaje_id: string; contrato: Contract };
type SessionState = {
  messages: LlmMessage[];
  history: ChatEntry[];
  pending: PendingAction | null;
  estimatedTokens: number;
  intent: AgentIntent;
  state: AgentState;
  extractedContracts: Map<string, Contract>;
  validatedContracts: Map<string, Contract>;
};

const sessions = new Map<string, SessionState>();
const apiKey = process.env.GEMINI_API_KEY;
const llm: LlmAdapter | null = apiKey ? new GeminiAdapter(apiKey) : null;

const toolDefinitions: LlmToolDefinition[] = Object.entries(herramientas).map(
  ([name, tool]) => {
    const { $schema: _schemaVersion, ...parameters } = z.toJSONSchema(
      z.object(tool.args),
    );
    return { name, description: tool.description, parameters };
  },
);

function jsonResponse(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("El cuerpo de la solicitud supera 1 MB.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("El cuerpo de la solicitud no contiene JSON válido.");
  }
}

function summarizeToolResult(serialized: string): string {
  try {
    const result = JSON.parse(serialized) as {
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    };
    if (!result.ok) return result.error ?? "La herramienta reportó un error.";
    const data = result.data ?? {};
    if (Array.isArray(data.mensajes)) return `${data.mensajes.length} mensajes pendientes.`;
    if (typeof data.clasificacion === "string") {
      return `Clasificación: ${data.clasificacion}; revisión: ${Array.isArray(data.requiere_revision) ? data.requiere_revision.join(", ") || "no" : "no"}.`;
    }
    if (typeof data.accion === "string") {
      return `Acción: ${data.accion}${typeof data.id_contrato === "string" ? ` (${data.id_contrato})` : ""}.`;
    }
    if (typeof data.ruta === "string") return `Reporte generado: ${data.ruta}.`;
    return JSON.stringify(data).slice(0, 400);
  } catch {
    return "La herramienta devolvió una respuesta que no se pudo resumir.";
  }
}

async function rejectToolCall(
  name: string,
  messageId: string,
  reason: string,
  ctx: Context,
): Promise<string> {
  try {
    await logTool(ctx.directory, {
      ts: new Date().toISOString(),
      herramienta: name,
      mensaje_id: messageId,
      ok: false,
      resumen: reason,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "error desconocido";
    return JSON.stringify({
      ok: false,
      error: `${reason}. No se pudo escribir el log: ${detail}`,
    });
  }
  return JSON.stringify({ ok: false, error: reason });
}

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(herramientas, name);
}

function parseToolResult(serialized: string): Record<string, unknown> {
  const result: unknown = JSON.parse(serialized);
  if (!isRecord(result)) {
    throw new Error("La herramienta devolvió un resultado que no es un objeto JSON.");
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function executeTool(name: ToolName, input: unknown, ctx: Context): Promise<string> {
  const invalid = async (error: z.ZodError): Promise<string> => {
    const message = `Argumentos inválidos: ${error.issues.map((issue) => issue.message).join("; ")}`;
    const id =
      typeof input === "object" &&
      input !== null &&
      "mensaje_id" in input &&
      typeof input.mensaje_id === "string"
        ? input.mensaje_id
        : "";
    try {
      await logTool(ctx.directory, {
        ts: new Date().toISOString(),
        herramienta: name,
        mensaje_id: id,
        ok: false,
        resumen: message,
      });
    } catch (logError) {
      const logMessage = logError instanceof Error ? logError.message : "error desconocido";
      return JSON.stringify({
        ok: false,
        error: `${message}. Además, no se pudo escribir el log: ${logMessage}`,
      });
    }
    return JSON.stringify({ ok: false, error: message });
  };
  switch (name) {
    case "contratos_leer_buzon":
      {
        const parsed = z.object(herramientas.contratos_leer_buzon.args).safeParse(input);
        return parsed.success
          ? herramientas.contratos_leer_buzon.execute(parsed.data, ctx)
          : await invalid(parsed.error);
      }
    case "contratos_extraer":
      {
        const parsed = z.object(herramientas.contratos_extraer.args).safeParse(input);
        return parsed.success
          ? herramientas.contratos_extraer.execute(parsed.data, ctx)
          : await invalid(parsed.error);
      }
    case "contratos_validar":
      {
        const parsed = z.object(herramientas.contratos_validar.args).safeParse(input);
        return parsed.success
          ? herramientas.contratos_validar.execute(parsed.data, ctx)
          : await invalid(parsed.error);
      }
    case "contratos_registrar":
      {
        const parsed = z.object(herramientas.contratos_registrar.args).safeParse(input);
        return parsed.success
          ? herramientas.contratos_registrar.execute(parsed.data, ctx)
          : await invalid(parsed.error);
      }
    case "contratos_alertas":
      {
        const parsed = z.object(herramientas.contratos_alertas.args).safeParse(input);
        return parsed.success
          ? herramientas.contratos_alertas.execute(parsed.data, ctx)
          : await invalid(parsed.error);
      }
  }
}

function isExplicitConfirmation(message: string): boolean {
  return /^(?:s[ií](?=$|[\s.,!?])|confirmo\b|confirmar\b|autorizo\b|de acuerdo\b|proceda\b|adelante\b)[\s.!,:;-]*/i.test(
    message.trim(),
  );
}

function detectIntent(message: string, hasPendingConfirmation: boolean): AgentIntent {
  if (hasPendingConfirmation && isExplicitConfirmation(message)) {
    return "confirmar_registro";
  }
  const asksForAlerts = /alertas?|vencimientos?|p[oó]lizas?\s+pendientes/i.test(message);
  const asksToProcess = /\b(procesa|procesar|buz[oó]n|contratos|registra|registrar)\b/i.test(
    message,
  );
  if (asksForAlerts && asksToProcess) return "procesar_y_alertar";
  if (asksForAlerts) return "consultar_alertas";
  if (asksToProcess) return "procesar_buzon";
  return "conversacion";
}

function amountFromMessage(message: string): number | null {
  const match = message.match(/\bvalor(?:\s+total)?(?:\s+del contrato)?\D{0,20}([\d][\d.,]*)/i);
  if (!match) return null;
  const raw = match[1];
  const decimal = raw.match(/[,.](\d{2})$/);
  const normalized = decimal
    ? `${raw.slice(0, -3).replace(/[,.]/g, "")}.${decimal[1]}`
    : raw.replace(/[,.]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function applyExplicitCorrections(contract: Contract, message: string): Contract {
  const result: Contract = { ...contract, confianza: { ...contract.confianza } };
  const start = message.match(
    /fecha(?:_|\s+(?:de\s+)?)inicio\D{0,30}(\d{4}-\d{2}-\d{2})/i,
  )?.[1];
  const end = message.match(
    /fecha(?:_|\s+(?:de\s+)?)fin\D{0,30}(\d{4}-\d{2}-\d{2})/i,
  )?.[1];
  if (start) {
    result.fecha_inicio = start;
    result.confianza.fecha_inicio = 1;
  }
  if (end) {
    result.fecha_fin = end;
    result.confianza.fecha_fin = 1;
  }
  const value = amountFromMessage(message);
  if (value !== null) {
    result.valor = value;
    result.confianza.valor = 1;
    result.valor_indeterminado = value === 0;
  }
  const currency = message.match(/\b(COP|USD|PEN|PAB|HNL)\b/i)?.[1]?.toUpperCase();
  if (currency && /\bmoneda\b|\bvalor\b/i.test(message)) {
    result.moneda = currency;
    result.confianza.moneda = 1;
  }
  return result;
}

async function loadSystemPrompt(): Promise<string> {
  const [prompt, knowledge] = await Promise.all([
    readFile(path.join(root, "agent", "prompt.md"), "utf8"),
    readFile(path.join(root, "src", "knowledge", "registro-contratos.md"), "utf8"),
  ]);
  return `${prompt}\n\n## Conocimiento del proceso\n\n${knowledge}`;
}

async function handleChat(body: unknown): Promise<{
  sessionId: string;
  reply: string;
  toolCalls: ToolCallRecord[];
  needsConfirmation: boolean;
  intent: AgentIntent;
  state: AgentState;
}> {
  const { sessionId: requestedId, message } = requestSchema.parse(body);
  const sessionId = requestedId ?? randomUUID();
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      messages: [],
      history: [],
      pending: null,
      estimatedTokens: 0,
      intent: "conversacion",
      state: "inactivo",
      extractedContracts: new Map(),
      validatedContracts: new Map(),
    };
    sessions.set(sessionId, session);
  }
  session.intent = detectIntent(message, session.pending !== null);
  session.state = "procesando";
  const inputCost = Math.ceil(message.length / 4);
  if (session.estimatedTokens + inputCost > maxSessionTokens) {
    throw new Error("Se alcanzó el límite de tokens de esta sesión. Inicia una sesión nueva.");
  }
  session.estimatedTokens += inputCost;

  if (session.pending && isExplicitConfirmation(message)) {
    const correctedContract = applyExplicitCorrections(session.pending.contrato, message);
    const pending = session.pending;
    const serialized = await herramientas.contratos_registrar.execute(
      { mensaje_id: pending.mensaje_id, contrato: correctedContract, confirmado: true },
      { directory: root, sessionId },
    );
    const summary = summarizeToolResult(serialized);
    const toolCalls = [
      {
        nombre: "contratos_registrar",
        argumentos: {
          mensaje_id: pending.mensaje_id,
          contrato: correctedContract,
          confirmado: true,
        },
        resultado: summary,
      },
    ];
    const result = JSON.parse(serialized) as { ok: boolean; data?: { accion?: string }; error?: string };
    const reply = result.ok
      ? `Confirmación recibida. ${summary}`
      : `No se completó el registro: ${result.error ?? "error de la herramienta"}. Indica los datos pendientes y confirma de nuevo.`;
    if (result.ok) {
      session.pending = null;
      session.validatedContracts.delete(pending.mensaje_id);
    } else {
      session.pending = { ...pending, contrato: correctedContract };
    }
    session.state = session.pending ? "esperando_confirmacion" : "inactivo";
    session.messages.push({ role: "user", text: message });
    session.messages.push({ role: "assistant", text: reply });
    session.history.push({ role: "user", content: message });
    session.history.push({
      role: "assistant",
      content: reply,
      toolCalls,
      needsConfirmation: session.pending !== null,
      intent: session.intent,
      state: session.state,
    });
    return {
      sessionId,
      reply,
      toolCalls,
      needsConfirmation: session.pending !== null,
      intent: session.intent,
      state: session.state,
    };
  }

  session.messages.push({ role: "user", text: message });
  session.history.push({ role: "user", content: message });
  const system = await loadSystemPrompt();
  const toolCalls: ToolCallRecord[] = [];
  let reply = "";
  let iterations = 0;

  while (iterations < maxToolIterations) {
    if (session.estimatedTokens >= maxSessionTokens) {
      reply = `Se alcanzó el límite aproximado de ${maxSessionTokens} tokens de esta sesión. Las herramientas ejecutadas hasta ahora están en el historial.`;
      break;
    }
    let response: LlmResponse;
    try {
      response = await llm!.enviar({
        model,
        maxOutputTokens: 2048,
        systemPrompt: system,
        messages: session.messages,
        tools: toolDefinitions,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Error de conexión desconocido.";
      reply = `No se pudo completar la solicitud al modelo. ${detail}`;
      session.state = session.pending ? "esperando_confirmacion" : "inactivo";
      session.messages.push({ role: "assistant", text: reply });
      session.history.push({
        role: "assistant",
        content: reply,
        intent: session.intent,
        state: session.state,
        needsConfirmation: session.pending !== null,
      });
      return {
        sessionId,
        reply,
        toolCalls,
        needsConfirmation: session.pending !== null,
        intent: session.intent,
        state: session.state,
      };
    }
    session.messages.push(response.message);
    session.estimatedTokens += Math.ceil(
      (response.text.length + JSON.stringify(response.toolCalls).length) / 4,
    );
    const requestedTools = response.toolCalls;
    if (requestedTools.length === 0) {
      reply = response.text;
      break;
    }
    iterations += 1;
    const results: LlmToolResult[] = [];
    const errors: string[] = [];
    for (const call of requestedTools) {
      const name = call.name;
      if (!isToolName(name)) {
        const explanation = `Herramienta desconocida: ${call.name || "(sin nombre)"}`;
        let invalid = JSON.stringify({ ok: false, error: explanation });
        try {
          await logTool(root, {
            ts: new Date().toISOString(),
            herramienta: call.name,
            mensaje_id: "",
            ok: false,
            resumen: explanation,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "error desconocido";
          invalid = JSON.stringify({
            ok: false,
            error: `${explanation}. No se pudo escribir el log: ${detail}`,
          });
        }
        const record = {
          nombre: call.name,
          argumentos: call.args,
          resultado: summarizeToolResult(invalid),
        };
        toolCalls.push(record);
        errors.push(invalid);
        continue;
      }

      let serialized: string;
      if (name === "contratos_registrar") {
        const parsed = z.object(registrar.args).safeParse(call.args);
        if (!parsed.success) {
          serialized = await executeTool(name, call.args, { directory: root, sessionId });
        } else if (parsed.data.confirmado === true) {
          serialized = await rejectToolCall(
            name,
            parsed.data.mensaje_id,
            "La confirmación solo se acepta en un turno posterior a la solicitud explícita del agente.",
            { directory: root, sessionId },
          );
        } else {
          const validated = session.validatedContracts.get(parsed.data.mensaje_id);
          if (!validated) {
            serialized = await rejectToolCall(
              name,
              parsed.data.mensaje_id,
              "Debes validar el contrato antes de registrarlo.",
              { directory: root, sessionId },
            );
          } else if (!isDeepStrictEqual(validated, parsed.data.contrato)) {
            serialized = await rejectToolCall(
              name,
              parsed.data.mensaje_id,
              "Los datos para registrar no coinciden con los datos validados.",
              { directory: root, sessionId },
            );
          } else {
            serialized = await executeTool(name, call.args, { directory: root, sessionId });
          }
        }
        const result = JSON.parse(serialized) as { ok: boolean; error?: string };
        if (result.ok && parsed.success) {
          session.validatedContracts.delete(parsed.data.mensaje_id);
        } else if (result.error?.startsWith("requiere revisión:") && parsed.success) {
          session.pending = {
            mensaje_id: parsed.data.mensaje_id,
            contrato: parsed.data.contrato,
          };
        }
      } else if (name === "contratos_extraer") {
        const parsed = z.object(herramientas.contratos_extraer.args).safeParse(call.args);
        serialized = await executeTool(name, call.args, { directory: root, sessionId });
        const result = JSON.parse(serialized) as { ok: boolean; data?: Contract };
        if (parsed.success && result.ok && result.data) {
          session.extractedContracts.set(parsed.data.mensaje_id, result.data);
        }
      } else if (name === "contratos_validar") {
        const parsed = z.object(herramientas.contratos_validar.args).safeParse(call.args);
        const extracted = parsed.success
          ? session.extractedContracts.get(parsed.data.mensaje_id)
          : undefined;
        if (!parsed.success) {
          serialized = await executeTool(name, call.args, { directory: root, sessionId });
        } else if (!extracted) {
          serialized = await rejectToolCall(
            name,
            parsed.data.mensaje_id,
            "Debes extraer los datos del mensaje antes de validarlos.",
            { directory: root, sessionId },
          );
        } else if (!isDeepStrictEqual(extracted, parsed.data.contrato)) {
          serialized = await rejectToolCall(
            name,
            parsed.data.mensaje_id,
            "Los datos para validar no coinciden con la extracción del contrato.",
            { directory: root, sessionId },
          );
        } else {
          serialized = await executeTool(name, call.args, { directory: root, sessionId });
        }
        const result = JSON.parse(serialized) as {
          ok: boolean;
          data?: { requiere_revision?: string[] };
        };
        if (parsed.success && result.ok) {
          session.validatedContracts.set(parsed.data.mensaje_id, parsed.data.contrato);
        }
        if (
          parsed.success &&
          result.ok &&
          (result.data?.requiere_revision?.length ?? 0) > 0
        ) {
          session.pending = {
            mensaje_id: parsed.data.mensaje_id,
            contrato: parsed.data.contrato,
          };
        }
      } else {
        serialized = await executeTool(name, call.args, { directory: root, sessionId });
      }
      const record = {
        nombre: name,
        argumentos: call.args,
        resultado: summarizeToolResult(serialized),
      };
      session.estimatedTokens += Math.ceil(
        (JSON.stringify(call.args).length + serialized.length) / 4,
      );
      toolCalls.push(record);
      results.push({
        name,
        response: parseToolResult(serialized),
        ...(call.id ? { id: call.id } : {}),
      });
    }
    session.messages.push(
      toolResultMessage(results, errors.length ? errors.join("\n") : undefined),
    );
    if (session.estimatedTokens >= maxSessionTokens) {
      reply = `Se alcanzó el límite aproximado de ${maxSessionTokens} tokens. Se ejecutaron las llamadas mostradas; revisa sus resultados antes de continuar.`;
      break;
    }
    if (iterations >= maxToolIterations) {
      reply = `Alcancé el límite de ${maxToolIterations} ciclos de herramientas. Se ejecutaron las llamadas mostradas; revisa los resultados y dime cómo continuar.`;
      break;
    }
  }
  if (!reply) reply = "No pude completar la respuesta del modelo. Puedes intentar de nuevo.";
  session.state = session.pending ? "esperando_confirmacion" : "inactivo";
  session.history.push({
    role: "assistant",
    content: reply,
    ...(toolCalls.length ? { toolCalls } : {}),
    needsConfirmation: session.pending !== null,
    intent: session.intent,
    state: session.state,
  });
  return {
    sessionId,
    reply,
    toolCalls,
    needsConfirmation: session.pending !== null,
    intent: session.intent,
    state: session.state,
  };
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const files: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  };
  const resource = files[pathname];
  if (!resource) {
    response.writeHead(404);
    response.end("No encontrado");
    return;
  }
  const content = await readFile(path.join(root, "web", resource.file));
  response.writeHead(200, {
    "content-type": resource.type,
    "cache-control": "no-cache",
  });
  response.end(content);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/health") {
    jsonResponse(response, 200, { ok: true, provider: "gemini", model });
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const session = sessions.get(id);
    if (!session) {
      jsonResponse(response, 404, { error: "No se encontró la sesión." });
      return;
    }
    jsonResponse(response, 200, {
      sessionId: id,
      history: session.history,
      needsConfirmation: session.pending !== null,
      intent: session.intent,
      state: session.state,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    if (!llm) {
      jsonResponse(response, 503, {
        error: "Falta GEMINI_API_KEY. Configúrala en el entorno del backend para usar el chat.",
      });
      return;
    }
    try {
      const body = await readRequestBody(request);
      jsonResponse(response, 200, await handleChat(body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error inesperado.";
      jsonResponse(response, 400, { error: message });
    }
    return;
  }
  if (request.method === "GET") {
    try {
      await serveStatic(url.pathname, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo cargar la interfaz.";
      jsonResponse(response, 500, { error: message });
    }
    return;
  }
  jsonResponse(response, 404, { error: "Ruta no encontrada." });
});

server.listen(port, () => {
  console.log(`Agente de contratos disponible en http://localhost:${port}`);
  if (!llm) {
    console.log("El chat requiere GEMINI_API_KEY; la demo determinista funciona sin ella.");
  }
});
