import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Contract, Context, Mail, MasterRow } from "./storage.js";
import {
  appendHistory,
  contractFromRow,
  ensureMaster,
  FIXTURES,
  logTool,
  markProcessed,
  MASTER,
  OUTPUT,
  parseCsv,
  readMaster,
  readProcessed,
  readText,
  resolve,
  SHAREPOINT,
  toMasterRow,
  writeMaster,
} from "./storage.js";

const confidenceSchema = z.record(z.string(), z.number().min(0).max(1));
const contractSchema = z.object({
  id_contrato: z.string().nullable(),
  cliente: z.string().nullable(),
  nit_cliente: z.string().nullable(),
  pais: z.string().nullable(),
  objeto: z.string().nullable(),
  valor: z.number().nullable(),
  moneda: z.string().nullable(),
  fecha_inicio: z.string().nullable(),
  fecha_fin: z.string().nullable(),
  requiere_poliza: z.boolean().nullable(),
  tipo_poliza: z.array(z.string()),
  comercial: z.string().nullable(),
  fecha_registro: z.string(),
  fuente: z.string(),
  valor_indeterminado: z.boolean(),
  confianza: confidenceSchema,
});

const messageId = z.string().regex(/^[a-zA-Z0-9_-]+$/);

type ToolArgs = Record<string, z.ZodTypeAny>;
type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };
type Tool<T extends ToolArgs> = {
  description: string;
  args: T;
  execute(args: z.infer<z.ZodObject<T>>, ctx: Context): Promise<string>;
};

const monthNumbers: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

const requiredFields = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "tipo_poliza",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
] as const;
const REVIEW_THRESHOLD = 0.85;
const supportedCurrencies = new Set(["COP", "USD", "PEN", "PAB", "HNL"]);

async function loadMail(root: string, id: string): Promise<Mail> {
  const raw = await readText(root, FIXTURES, "buzon", id, "correo.json");
  const mail: unknown = JSON.parse(raw);
  return z
    .object({
      id: z.string(),
      de: z.string(),
      para: z.string(),
      asunto: z.string(),
      fecha: z.string(),
      cuerpo: z.string(),
      adjuntos: z.array(z.string()),
    })
    .parse(mail);
}

async function loadAttachment(
  root: string,
  id: string,
  attachments: string[],
): Promise<{ name: string; text: string } | null> {
  for (const { name, text } of await readAttachments(root, id, attachments)) {
    if (/^\s*(?:CONTRATO\b|OTROS[IÍ])/i.test(text)) return { name, text };
  }
  return null;
}

async function readAttachments(
  root: string,
  id: string,
  attachments: string[],
): Promise<Array<{ name: string; text: string }>> {
  const contents: Array<{ name: string; text: string }> = [];
  for (const name of attachments) {
    if (path.basename(name) !== name) continue;
    contents.push({
      name,
      text: await readText(root, FIXTURES, "buzon", id, name),
    });
  }
  return contents;
}

function decodeDateMatches(text: string): Array<{ date: string; index: number }> {
  const expression = new RegExp(
    `(?:\\bde\\s+|\\bdel\\s+mes\\s+de\\s+)(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\\s+de\\s+(\\d{4})`,
    "gi",
  );
  const matches: Array<{ date: string; index: number }> = [];
  for (const match of text.matchAll(expression)) {
    const before = text.slice(0, match.index).match(/(?:\((\d{1,2})\)|\b(\d{1,2}))\s*$/);
    if (!before) continue;
    const day = Number(before[1] ?? before[2]);
    const month = monthNumbers[(match[1] ?? "").toLowerCase()];
    const year = match[2];
    if (day >= 0 && day <= 99 && month) {
      matches.push({
        date: `${year}-${month}-${String(day).padStart(2, "0")}`,
        index: match.index ?? 0,
      });
    }
  }
  return matches;
}

function isValidDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseMoney(text: string): { value: number; currency: string } | null {
  const match = text.match(/\b(COP|USD|PEN|PAB|HNL)\s*\$?\s*([\d][\d.,]*)/i);
  const valueClause =
    text.match(/SEGUNDA\.\s*VALOR\.\s*([\s\S]*?)(?=\n\s*(?:TERCERA|CUARTA)\.)/i)?.[1] ??
    text.match(/(?:valor|monto)[\s\S]{0,300}/i)?.[0] ??
    "";
  const unknownCurrency = valueClause.match(/\b([A-Z]{3})\s*\$?\s*([\d][\d.,]*)/i);
  if (!match && unknownCurrency) {
    throw new Error(`Moneda desconocida: ${unknownCurrency[1].toUpperCase()}.`);
  }
  if (!match) return null;
  const raw = match[2];
  const decimalMatch = raw.match(/[,.](\d{2})$/);
  const normalized = decimalMatch
    ? `${raw.slice(0, -3).replace(/[,.]/g, "")}.${decimalMatch[1]}`
    : raw.replace(/[,.]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value)
    ? { value, currency: match[1].toUpperCase() }
    : null;
}

function inferCountry(nit: string | null, text: string): string | null {
  const digits = nit?.replace(/\D/g, "") ?? "";
  if (digits.length === 13) return "EC";
  if (digits.length === 14) return "HN";
  if (digits.length === 11) return "PE";
  if (/panam[aá]|ciudad de panam[aá]|lima,?\s*per[uú]|quito,?\s*ecuador|honduras/i.test(text)) {
    if (/panam[aá]/i.test(text)) return "PA";
    if (/per[uú]/i.test(text)) return "PE";
    if (/ecuador/i.test(text)) return "EC";
    if (/honduras/i.test(text)) return "HN";
  }
  if (digits.length === 9) return "CO";
  if (/colombia|bogot[aá]|medell[ií]n|barranquilla/i.test(text)) return "CO";
  return null;
}

function simplify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function similarity(left: string, right: string): number {
  const a = new Set(simplify(left).split(/\s+/).filter(Boolean));
  const b = new Set(simplify(right).split(/\s+/).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  const common = [...a].filter((word) => b.has(word)).length;
  return (2 * common) / (a.size + b.size);
}

async function extractContract(root: string, id: string): Promise<Contract> {
  const mail = await loadMail(root, id);
  const attachments = await readAttachments(root, id, mail.adjuntos);
  if (attachments.length > 0 && attachments.every(({ text }) => text.trim().length === 0)) {
    throw new Error("El texto del adjunto está vacío.");
  }
  const attachment =
    attachments.find(({ text }) => /^\s*(?:CONTRATO\b|OTROS[IÍ])/i.test(text)) ?? null;
  const text = `${mail.asunto}\n${mail.cuerpo}\n${attachment?.text ?? ""}`;
  const confidence: Record<string, number> = {};
  const assignConfidence = (field: string, value: unknown, score = 0.95): void => {
    confidence[field] = value === null || value === undefined ? 0 : score;
  };
  const contractNumber = text.match(/\b(?:No\.?|N[úu]mero)\s*([A-Z]{1,5}-\d{4}-\d{1,})/i)?.[1] ?? null;
  const party = attachment?.text.match(
    /Entre(?:\s+los\s+suscritos,)?\s*(.+?),\s*(?:identificad[oa]\s+(?:con\s+(?:NIT|RUC)|por)|NIT|RUC)/i,
  )?.[1];
  const client = party?.replace(/^\s+|\s+$/g, "").replace(/,$/, "") ?? null;
  const taxIdMatch = attachment?.text.match(/\b(?:NIT|RUC)\s*([\d.]+)(?:-(\d))?/i);
  const nit = taxIdMatch ? taxIdMatch[1].replace(/\D/g, "") : null;
  const country = inferCountry(nit, text);
  const objectMatch = attachment?.text.match(
    /PRIMERA\.\s*OBJETO\.\s*([\s\S]*?)(?=\n\s*SEGUNDA\.|\n\s*TERCERA\.)/i,
  );
  const object = objectMatch?.[1].replace(/\s+/g, " ").trim().slice(0, 200) ?? null;
  const dates = attachment ? decodeDateMatches(attachment.text) : [];
  const invalidDate = dates.find(({ date }) => !isValidDate(date));
  if (invalidDate) throw new Error(`Fecha inválida encontrada en el contrato: ${invalidDate.date}.`);
  const isAmendment = /^\s*OTROS[IÍ]/i.test(attachment?.text ?? "");
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (isAmendment) {
    const extensionIndex = attachment?.text.search(/se extiende hasta|plazo.{0,80}hasta/i) ?? -1;
    endDate = dates.find((item) => item.index >= extensionIndex && extensionIndex >= 0)?.date ?? null;
  } else {
    startDate = dates[0]?.date ?? null;
    endDate = dates[1]?.date ?? null;
  }

  const isIndeterminate =
    /no tiene un valor determinado|valor\s+(?:es\s+)?indeterminado|sin valor determinado/i.test(text);
  const money = parseMoney(attachment?.text ?? "");
  const value = isIndeterminate ? 0 : money?.value ?? null;
  const currency = money?.currency ?? (isIndeterminate ? "COP" : null);
  const explicitNoPolicy = /no (?:requiere|pide|exige) p[oó]liza|no solicita p[oó]liza/i.test(text);
  const policyTypes = [
    ["cumplimiento", /cumplimiento/i],
    ["calidad", /p[oó]liza\s+de\s+calidad/i],
    ["salarios_prestaciones", /salarios\s+y\s+prestaciones|p[oó]liza\s+de\s+salarios/i],
    ["responsabilidad_civil", /responsabilidad\s+civil/i],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(text))
    .map(([name]) => name as string);
  const conditionalPolicy = /para cada orden de servicio.{0,250}p[oó]liza/i.test(text);
  const requiresPolicy =
    explicitNoPolicy ? false : policyTypes.length > 0 || conditionalPolicy ? true : null;
  const emailDate = new Date(mail.fecha);
  if (Number.isNaN(emailDate.valueOf())) throw new Error(`Fecha inválida en el correo ${id}.`);
  const commercialData: unknown = JSON.parse(
    await readText(root, FIXTURES, "comerciales.json"),
  );
  const commercials = z
    .array(z.object({ email: z.string(), nombre: z.string(), region: z.string() }))
    .parse(commercialData);
  const sender = commercials.find((entry) => entry.email.toLowerCase() === mail.de.toLowerCase());
  const result: Contract = {
    id_contrato: contractNumber,
    cliente: client,
    nit_cliente: nit,
    pais: country,
    objeto: object,
    valor: value,
    moneda: currency,
    fecha_inicio: startDate,
    fecha_fin: endDate,
    requiere_poliza: requiresPolicy,
    tipo_poliza: policyTypes,
    comercial: sender?.nombre ?? null,
    fecha_registro: emailDate.toISOString().slice(0, 10),
    fuente: "buzon",
    valor_indeterminado: isIndeterminate,
    confianza: confidence,
  };

  assignConfidence("id_contrato", result.id_contrato);
  assignConfidence("cliente", result.cliente);
  assignConfidence("nit_cliente", result.nit_cliente);
  assignConfidence("pais", result.pais);
  assignConfidence("objeto", result.objeto);
  assignConfidence("valor", result.valor, isIndeterminate ? 0.98 : 0.95);
  assignConfidence("moneda", result.moneda);
  assignConfidence("fecha_inicio", result.fecha_inicio);
  assignConfidence("fecha_fin", result.fecha_fin);
  assignConfidence(
    "requiere_poliza",
    result.requiere_poliza,
    conditionalPolicy ? 0.65 : 0.95,
  );
  confidence.tipo_poliza = requiresPolicy === false || policyTypes.length > 0 ? 0.95 : 0;
  confidence.comercial = sender ? 0.98 : 0;
  return result;
}

function mergeWithExisting(contract: Contract, existing?: MasterRow): Contract {
  if (!existing) return contract;
  const old = contractFromRow(existing);
  const merged: Contract = {
    ...old,
    ...contract,
    confianza: { ...contract.confianza },
  };
  for (const field of requiredFields) {
    if (contract[field] === null) {
      Reflect.set(merged, field, old[field]);
      merged.confianza[field] = 0.99;
    }
  }
  if (contract.tipo_poliza.length === 0) {
    merged.tipo_poliza = old.tipo_poliza;
    merged.confianza.tipo_poliza = 0.99;
  }
  if (!contract.comercial) merged.comercial = old.comercial;
  return merged;
}

function changesBetween(before: MasterRow, after: MasterRow): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(after) as Array<keyof MasterRow>) {
    if (before[key] !== after[key]) changes[key] = { antes: before[key], despues: after[key] };
  }
  return changes;
}

function validateContractValues(contract: Contract): void {
  for (const [field, value] of [
    ["fecha_inicio", contract.fecha_inicio],
    ["fecha_fin", contract.fecha_fin],
  ] as const) {
    if (value !== null && !isValidDate(value)) {
      throw new Error(`La fecha ${field} no es válida; use YYYY-MM-DD.`);
    }
  }
  if (contract.moneda !== null && !supportedCurrencies.has(contract.moneda)) {
    throw new Error(`Moneda desconocida: ${contract.moneda}.`);
  }
  if (contract.valor !== null && contract.valor < 0) {
    throw new Error("El valor del contrato no puede ser negativo.");
  }
}

async function classify(root: string, id: string, contract: Contract) {
  validateContractValues(contract);
  const mail = await loadMail(root, id);
  const attachment = await loadAttachment(root, id, mail.adjuntos);
  if (!attachment) {
    return {
      clasificacion: "rechazado" as const,
      motivo: "No se encontró un adjunto identificable como contrato u otrosí.",
      requiere_revision: [] as string[],
      diferencias: {},
    };
  }
  const rows = await readMaster(root);
  const existing =
    rows.find((row) => row.id_contrato === contract.id_contrato) ??
    rows.find(
      (row) =>
        Boolean(contract.nit_cliente) &&
        row.nit_cliente === contract.nit_cliente &&
        similarity(row.objeto, contract.objeto ?? "") >= 0.9,
    );
  const merged = mergeWithExisting(contract, existing);
  if (!merged.cliente || !merged.objeto) {
    return {
      clasificacion: "rechazado" as const,
      motivo: "El documento no contiene contraparte y objeto identificables.",
      requiere_revision: [] as string[],
      diferencias: {},
    };
  }
  const candidateRow = toMasterRow(merged, existing?.ruta_sharepoint ?? "");
  const differences = existing ? changesBetween(existing, candidateRow) : {};
  const needsReview = new Set(
    requiredFields.filter(
      (field) =>
        field !== "id_contrato" &&
        (merged.confianza[field] ?? 0) < REVIEW_THRESHOLD,
    ),
  );
  const conflicts: string[] = [];
  if (existing && contract.nit_cliente && existing.nit_cliente !== contract.nit_cliente) {
    conflicts.push("El NIT/RUC del documento difiere del contrato existente.");
    needsReview.add("nit_cliente");
  }
  if (existing && contract.cliente && similarity(existing.cliente, contract.cliente) < 0.9) {
    conflicts.push("La contraparte del documento difiere del contrato existente.");
    needsReview.add("cliente");
  }
  if (
    merged.fecha_inicio &&
    merged.fecha_fin &&
    merged.fecha_inicio > merged.fecha_fin
  ) {
    conflicts.push("La fecha de inicio es posterior a la fecha de fin.");
    needsReview.add("fecha_inicio");
    needsReview.add("fecha_fin");
  }
  const duplicate =
    existing &&
    existing.valor === candidateRow.valor &&
    existing.fecha_inicio === candidateRow.fecha_inicio &&
    existing.fecha_fin === candidateRow.fecha_fin;
  return {
    clasificacion: duplicate ? ("duplicado" as const) : existing ? ("actualizacion" as const) : ("nuevo" as const),
    ...(existing ? { id_contrato_existente: existing.id_contrato } : {}),
    requiere_revision: [...needsReview],
    diferencias: differences,
    conflictos: conflicts,
    ...(merged.comercial === null ? { remitente_desconocido: mail.de } : {}),
  };
}

async function assertMatchesExtractedValues(
  root: string,
  messageId: string,
  contract: Contract,
): Promise<void> {
  const extracted = await extractContract(root, messageId);
  if (!isDeepStrictEqual(contract, extracted)) {
    throw new Error(
      "El contrato enviado no coincide con los datos extraídos del adjunto; vuelve a extraer antes de validar.",
    );
  }
}

async function runTool<T>(
  name: string,
  id: string,
  ctx: Context,
  action: () => Promise<T>,
): Promise<string> {
  try {
    const data = await action();
    await logTool(ctx.directory, {
      ts: new Date().toISOString(),
      herramienta: `contratos_${name}`,
      mensaje_id: id,
      ok: true,
      resumen: `Ejecución correcta: ${name}.`,
    });
    return JSON.stringify({ ok: true, data } satisfies ToolResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado.";
    try {
      await logTool(ctx.directory, {
        ts: new Date().toISOString(),
        herramienta: `contratos_${name}`,
        mensaje_id: id,
        ok: false,
        resumen: message,
      });
    } catch (logError) {
      console.error("No se pudo escribir out/log.jsonl:", logError);
    }
    return JSON.stringify({ ok: false, error: message } satisfies ToolResult);
  }
}

export const leer_buzon: Tool<Record<string, z.ZodTypeAny>> = {
  description: "Lista los correos del buzón aún no procesados e indica si tienen contrato adjunto.",
  args: {},
  async execute(_args, ctx) {
    return runTool("leer_buzon", "", ctx, async () => {
      const processed = new Set(await readProcessed(ctx.directory));
      const root = resolve(ctx.directory, FIXTURES, "buzon");
      const { readdir } = await import("node:fs/promises");
      const ids = (await readdir(root, { withFileTypes: true }))
        .filter((item) => item.isDirectory())
        .map((item) => item.name)
        .sort();
      const mensajes = [];
      for (const id of ids) {
        if (processed.has(id)) continue;
        const mail = await loadMail(ctx.directory, id);
        const attachment = await loadAttachment(ctx.directory, id, mail.adjuntos);
        mensajes.push({
          id: mail.id,
          de: mail.de,
          asunto: mail.asunto,
          fecha: mail.fecha,
          adjuntos: mail.adjuntos,
          tiene_contrato: attachment !== null,
        });
      }
      return { mensajes };
    });
  },
};

export const extraer: Tool<{ mensaje_id: z.ZodString }> = {
  description: "Extrae los campos del contrato y asigna confianza a cada dato encontrado.",
  args: { mensaje_id: messageId.describe("Identificador del correo del buzón.") },
  async execute(args, ctx) {
    return runTool("extraer", args.mensaje_id, ctx, () => extractContract(ctx.directory, args.mensaje_id));
  },
};

export const validar: Tool<{
  mensaje_id: z.ZodString;
  contrato: typeof contractSchema;
}> = {
  description: "Valida y clasifica el contrato, compara el maestro y lista campos que requieren revisión.",
  args: {
    mensaje_id: messageId.describe("Identificador del correo del buzón."),
    contrato: contractSchema.describe("Datos extraídos del contrato, con confianza por campo."),
  },
  async execute(args, ctx) {
    return runTool("validar", args.mensaje_id, ctx, async () => {
      await assertMatchesExtractedValues(ctx.directory, args.mensaje_id, args.contrato);
      return classify(ctx.directory, args.mensaje_id, args.contrato);
    });
  },
};

export const registrar: Tool<{
  mensaje_id: z.ZodString;
  contrato: typeof contractSchema;
  confirmado: z.ZodOptional<z.ZodBoolean>;
}> = {
  description: "Registra o actualiza el maestro solo si no hay campos dudosos o el usuario confirmó explícitamente.",
  args: {
    mensaje_id: messageId.describe("Identificador del correo que se va a registrar."),
    contrato: contractSchema.describe("Datos del contrato y sus niveles de confianza."),
    confirmado: z.boolean().optional().describe("Debe ser true solo después de confirmación humana explícita."),
  },
  async execute(args, ctx) {
    return runTool("registrar", args.mensaje_id, ctx, async () => {
      if (args.confirmado !== true) {
        await assertMatchesExtractedValues(ctx.directory, args.mensaje_id, args.contrato);
      }
      const classification = await classify(ctx.directory, args.mensaje_id, args.contrato);
      if (classification.clasificacion === "rechazado") {
        await markProcessed(ctx.directory, args.mensaje_id);
        return { clasificacion: "rechazado", motivo: classification.motivo };
      }
      if (classification.clasificacion === "duplicado") {
        await markProcessed(ctx.directory, args.mensaje_id);
        return {
          id_contrato: args.contrato.id_contrato,
          accion: "duplicado",
          ruta_archivo: null,
        };
      }
      if (classification.requiere_revision.length > 0 && args.confirmado !== true) {
        throw new Error(`requiere revisión: ${classification.requiere_revision.join(", ")}`);
      }

      const mail = await loadMail(ctx.directory, args.mensaje_id);
      const attachment = await loadAttachment(ctx.directory, args.mensaje_id, mail.adjuntos);
      if (!attachment) throw new Error("No se encontró el archivo de contrato que se debe archivar.");
      const rows = await readMaster(ctx.directory);
      const existingIndex =
        rows.findIndex((row) => row.id_contrato === args.contrato.id_contrato) >= 0
          ? rows.findIndex((row) => row.id_contrato === args.contrato.id_contrato)
          : rows.findIndex(
              (row) =>
                Boolean(args.contrato.nit_cliente) &&
                row.nit_cliente === args.contrato.nit_cliente &&
                similarity(row.objeto, args.contrato.objeto ?? "") >= 0.9,
            );
      const existing = existingIndex >= 0 ? rows[existingIndex] : undefined;
      const contract = mergeWithExisting(args.contrato, existing);
      if (!contract.id_contrato) {
        const year = contract.fecha_inicio?.slice(0, 4) ?? contract.fecha_registro.slice(0, 4);
        const prefix = `AUTO-${year}-`;
        const highestSequence = rows.reduce((highest, row) => {
          if (!row.id_contrato.startsWith(prefix)) return highest;
          const sequence = Number(row.id_contrato.slice(prefix.length));
          return Number.isInteger(sequence) ? Math.max(highest, sequence) : highest;
        }, 0);
        contract.id_contrato = `${prefix}${String(highestSequence + 1).padStart(3, "0")}`;
        contract.confianza.id_contrato = 1;
      }
      if (args.confirmado === true) {
        for (const field of requiredFields) {
          if (contract[field] !== null) contract.confianza[field] = 1;
        }
      }
      if (!contract.id_contrato || !contract.cliente || !contract.objeto) {
        throw new Error("Faltan identificador, contraparte u objeto; no es posible registrar.");
      }
      if (contract.valor === null || !contract.moneda) {
        throw new Error("Faltan valor o moneda confirmados; no es posible registrar.");
      }
      if (contract.requiere_poliza === null) {
        throw new Error("Debe confirmarse si el contrato requiere póliza.");
      }
      if (!contract.fecha_inicio) {
        throw new Error("Falta la fecha de inicio. Indícala explícitamente antes de confirmar.");
      }
      if (!contract.fecha_fin) {
        throw new Error("Falta la fecha de fin. Indícala explícitamente antes de confirmar.");
      }
      if (!isValidDate(contract.fecha_inicio)) {
        throw new Error("La fecha de inicio no es válida; use YYYY-MM-DD.");
      }
      if (!isValidDate(contract.fecha_fin)) {
        throw new Error("La fecha de fin no es válida; use YYYY-MM-DD.");
      }
      if (contract.fecha_inicio > contract.fecha_fin) {
        throw new Error("La fecha de inicio no puede ser posterior a la fecha de fin.");
      }

      const year = contract.fecha_inicio?.slice(0, 4) ?? contract.fecha_registro.slice(0, 4);
      const slug = simplify(contract.cliente).replace(/\s+/g, "-");
      const extension = path.extname(attachment.name) || ".txt";
      const relativePath = `Contratos/${year}/${slug}/${contract.id_contrato}${extension}`;
      const absolutePath = resolve(ctx.directory, SHAREPOINT, ...relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await copyFile(
        resolve(ctx.directory, FIXTURES, "buzon", args.mensaje_id, attachment.name),
        absolutePath,
      );

      const updatedRow = toMasterRow(contract, relativePath);
      if (existing) {
        updatedRow.estado_poliza =
          existing.estado_poliza ||
          (contract.requiere_poliza ? "pendiente" : "no_aplica");
        rows[existingIndex] = updatedRow;
      } else {
        rows.push(updatedRow);
      }
      await writeMaster(ctx.directory, rows);
      await appendHistory(ctx.directory, {
        ts: new Date().toISOString(),
        id_contrato: contract.id_contrato,
        accion: existing ? "actualizacion" : "nuevo",
        cambios: existing ? changesBetween(existing, updatedRow) : { registro: updatedRow },
        mensaje_id: args.mensaje_id,
      });
      await markProcessed(ctx.directory, args.mensaje_id);
      return {
        id_contrato: contract.id_contrato,
        accion: existing ? "actualizacion" : "nuevo",
        ruta_archivo: `out/sharepoint/${relativePath}`,
      };
    });
  },
};

export const alertas: Tool<{ hoy: z.ZodString }> = {
  description: "Genera el informe de vencimientos, pólizas pendientes y contratos posteriores al corte.",
  args: { hoy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha de referencia YYYY-MM-DD.") },
  async execute(args, ctx) {
    return runTool("alertas", "", ctx, async () => {
      if (!isValidDate(args.hoy)) throw new Error("La fecha de referencia no es válida.");
      const rows = await readMaster(ctx.directory);
      const today = new Date(`${args.hoy}T00:00:00.000Z`);
      const vencen = rows.filter((row) => {
        if (!isValidDate(row.fecha_fin)) return false;
        const days = Math.floor(
          (new Date(`${row.fecha_fin}T00:00:00.000Z`).valueOf() - today.valueOf()) /
            86_400_000,
        );
        return days >= 0 && days <= 60;
      });
      const polizas_pendientes = rows.filter(
        (row) => row.requiere_poliza === "true" && row.estado_poliza !== "vigente",
      );
      const registrados_desde_corte = rows.filter((row) => row.fecha_registro >= "2026-05-30");
      const sections = [
        "# Alertas de contratos",
        `Fecha de referencia: ${args.hoy}`,
        "",
        "## Vencen en 60 días o menos",
        ...renderRows(vencen),
        "",
        "## Pólizas pendientes o no vigentes",
        ...renderRows(polizas_pendientes),
        "",
        "## Registrados desde el corte (2026-05-30)",
        ...renderRows(registrados_desde_corte),
        "",
      ];
      const report = sections.join("\n");
      await writeFile(resolve(ctx.directory, OUTPUT, "alertas.md"), report, "utf8");
      return {
        ruta: "out/alertas.md",
        vencen,
        polizas_pendientes,
        registrados_desde_corte,
      };
    });
  },
};

function renderRows(rows: MasterRow[]): string[] {
  return rows.length
    ? rows.map(
        (row) =>
          `- ${row.id_contrato} · ${row.cliente} · vence ${row.fecha_fin} · póliza: ${row.estado_poliza}`,
      )
    : ["- Ninguno."];
}

export const herramientas = {
  contratos_leer_buzon: leer_buzon,
  contratos_extraer: extraer,
  contratos_validar: validar,
  contratos_registrar: registrar,
  contratos_alertas: alertas,
} as const;

export type ToolName = keyof typeof herramientas;
export type AnyTool = (typeof herramientas)[ToolName];
export { contractSchema, ensureMaster, MASTER, parseCsv, readMaster, REVIEW_THRESHOLD };
