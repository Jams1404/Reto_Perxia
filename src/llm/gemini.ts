import {
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import type {
  LlmAdapter,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolResult,
} from "./adapter.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeminiContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    Array.isArray(value.parts)
  );
}

export function toGeminiContent(message: LlmMessage): Content {
  if (message.role === "assistant" && isGeminiContent(message.providerData)) {
    return message.providerData;
  }

  const parts: Part[] = [];
  if (message.text) parts.push({ text: message.text });
  for (const call of message.toolCalls ?? []) {
    const args = isRecord(call.args) ? call.args : {};
    parts.push({
      functionCall: {
        name: call.name,
        args,
        ...(call.id ? { id: call.id } : {}),
      },
    });
  }
  for (const result of message.toolResults ?? []) {
    parts.push({
      functionResponse: {
        name: result.name,
        response: result.response,
        ...(result.id ? { id: result.id } : {}),
      },
    });
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts,
  };
}

function toGeminiTool(tool: LlmToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: normalizeFunctionSchema(tool.parameters),
  };
}

export function normalizeFunctionSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeFunctionSchema);
  if (!isRecord(schema)) return schema;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "propertyNames") continue;
    if (
      key === "type" &&
      Array.isArray(value) &&
      value.includes("null") &&
      value.filter((type) => type !== "null").length === 1
    ) {
      normalized.type = value.find((type) => type !== "null");
      normalized.nullable = true;
    } else {
      normalized[key] = normalizeFunctionSchema(value);
    }
  }
  return normalized;
}

function normalizeToolCall(call: {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}): LlmToolCall {
  return {
    name: call.name ?? "",
    args: call.args ?? {},
    ...(call.id ? { id: call.id } : {}),
  };
}

export class GeminiAdapter implements LlmAdapter {
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async enviar(input: {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    maxOutputTokens: number;
  }): Promise<LlmResponse> {
    const response = await this.client.models.generateContent({
      model: input.model,
      contents: input.messages.map(toGeminiContent),
      config: {
        systemInstruction: input.systemPrompt,
        maxOutputTokens: input.maxOutputTokens,
        httpOptions: { timeout: 30_000 },
        tools: [
          {
            functionDeclarations: input.tools.map(toGeminiTool),
          },
        ],
      },
    });
    const content = response.candidates?.[0]?.content;
    if (!content) {
      const reason = response.promptFeedback?.blockReason;
      throw new Error(
        reason
          ? `Gemini no generó respuesta porque bloqueó el contenido (${reason}).`
          : "Gemini no devolvió una respuesta.",
      );
    }

    const toolCalls = (content.parts ?? [])
      .filter((part) => part.functionCall !== undefined)
      .map((part) => normalizeToolCall(part.functionCall ?? {}));
    const text = (content.parts ?? [])
      .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
      .join("\n");
    const message: LlmMessage = {
      role: "assistant",
      text,
      toolCalls,
      providerData: content,
    };
    return { message, text, toolCalls };
  }
}

export function toolResultMessage(
  results: LlmToolResult[],
  text?: string,
): LlmMessage {
  return {
    role: "user",
    ...(text ? { text } : {}),
    ...(results.length ? { toolResults: results } : {}),
  };
}
