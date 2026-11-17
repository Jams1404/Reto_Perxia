import { copyFile, mkdir, readFile, writeFile, appendFile, access } from "node:fs/promises";
import path from "node:path";

export const FIXTURES = path.join("fixtures", "reto-02");
export const OUTPUT = "out";
export const SHAREPOINT = path.join(OUTPUT, "sharepoint");
export const MASTER = path.join(SHAREPOINT, "maestro-contratos.csv");
export const HEADERS = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
] as const;

export type MasterRow = Record<(typeof HEADERS)[number], string>;

export interface Context {
  directory: string;
  sessionId: string;
}

export interface Mail {
  id: string;
  de: string;
  para: string;
  asunto: string;
  fecha: string;
  cuerpo: string;
  adjuntos: string[];
}

export interface Contract {
  id_contrato: string | null;
  cliente: string | null;
  nit_cliente: string | null;
  pais: string | null;
  objeto: string | null;
  valor: number | null;
  moneda: string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  requiere_poliza: boolean | null;
  tipo_poliza: string[];
  comercial: string | null;
  fecha_registro: string;
  fuente: string;
  valor_indeterminado: boolean;
  confianza: Record<string, number>;
}

export function resolve(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("La ruta solicitada está fuera del directorio del proyecto.");
  }
  return resolved;
}

export async function readText(root: string, ...segments: string[]): Promise<string> {
  return readFile(resolve(root, ...segments), "utf8");
}

export async function ensureOutput(root: string): Promise<void> {
  await mkdir(resolve(root, SHAREPOINT), { recursive: true });
  const processedPath = resolve(root, OUTPUT, "procesados.json");
  try {
    await access(processedPath);
  } catch {
    await writeFile(processedPath, "[]\n", "utf8");
  }
}

export async function ensureMaster(root: string): Promise<void> {
  await ensureOutput(root);
  try {
    await access(resolve(root, MASTER));
  } catch {
    await copyFile(
      resolve(root, FIXTURES, "maestro-contratos.csv"),
      resolve(root, MASTER),
    );
  }
}

export function parseCsv(csv: string): MasterRow[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      records.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    records.push(row);
  }
  const header = records.shift() ?? [];
  return records
    .filter((record) => record.some((value) => value.length > 0))
    .map((record) => {
      const output = {} as MasterRow;
      for (const name of HEADERS) {
        output[name] = record[header.indexOf(name)] ?? "";
      }
      return output;
    });
}

export function writeCsv(rows: MasterRow[]): string {
  const escape = (value: string): string =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return `${HEADERS.join(",")}\n${rows
    .map((row) => HEADERS.map((name) => escape(row[name] ?? "")).join(","))
    .join("\n")}\n`;
}

export async function readMaster(root: string): Promise<MasterRow[]> {
  await ensureMaster(root);
  return parseCsv(await readText(root, MASTER));
}

export async function writeMaster(root: string, rows: MasterRow[]): Promise<void> {
  await writeFile(resolve(root, MASTER), writeCsv(rows), "utf8");
}

export async function readProcessed(root: string): Promise<string[]> {
  await ensureOutput(root);
  const data: unknown = JSON.parse(await readText(root, OUTPUT, "procesados.json"));
  if (!Array.isArray(data) || !data.every((item) => typeof item === "string")) {
    throw new Error("out/procesados.json debe contener una lista de IDs.");
  }
  return data;
}

export async function markProcessed(root: string, messageId: string): Promise<void> {
  const processed = await readProcessed(root);
  if (!processed.includes(messageId)) {
    processed.push(messageId);
    await writeFile(
      resolve(root, OUTPUT, "procesados.json"),
      `${JSON.stringify(processed, null, 2)}\n`,
      "utf8",
    );
  }
}

export async function appendHistory(
  root: string,
  entry: { ts: string; id_contrato: string; accion: string; cambios: Record<string, unknown>; mensaje_id: string },
): Promise<void> {
  await appendFile(
    resolve(root, OUTPUT, "sharepoint", "historial.jsonl"),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

export async function logTool(
  root: string,
  entry: { ts: string; herramienta: string; mensaje_id: string; ok: boolean; resumen: string },
): Promise<void> {
  await mkdir(resolve(root, OUTPUT), { recursive: true });
  await appendFile(resolve(root, OUTPUT, "log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

export function toMasterRow(contract: Contract, route: string): MasterRow {
  return {
    id_contrato: contract.id_contrato ?? "",
    cliente: contract.cliente ?? "",
    nit_cliente: contract.nit_cliente ?? "",
    pais: contract.pais ?? "",
    objeto: contract.objeto ?? "",
    valor: contract.valor === null ? "" : String(contract.valor),
    moneda: contract.moneda ?? "",
    fecha_inicio: contract.fecha_inicio ?? "",
    fecha_fin: contract.fecha_fin ?? "",
    requiere_poliza: contract.requiere_poliza === null ? "" : String(contract.requiere_poliza),
    tipo_poliza: contract.tipo_poliza.join(";"),
    estado_poliza:
      contract.requiere_poliza === false
        ? "no_aplica"
        : contract.requiere_poliza === true
          ? "pendiente"
          : "",
    comercial: contract.comercial ?? "",
    ruta_sharepoint: route,
    fecha_registro: contract.fecha_registro,
    fuente: contract.fuente,
  };
}

export function contractFromRow(row: MasterRow): Contract {
  return {
    id_contrato: row.id_contrato || null,
    cliente: row.cliente || null,
    nit_cliente: row.nit_cliente || null,
    pais: row.pais || null,
    objeto: row.objeto || null,
    valor: row.valor ? Number(row.valor) : null,
    moneda: row.moneda || null,
    fecha_inicio: row.fecha_inicio || null,
    fecha_fin: row.fecha_fin || null,
    requiere_poliza: row.requiere_poliza ? row.requiere_poliza === "true" : null,
    tipo_poliza: row.tipo_poliza ? row.tipo_poliza.split(";") : [],
    comercial: row.comercial || null,
    fecha_registro: row.fecha_registro,
    fuente: row.fuente,
    valor_indeterminado: row.valor === "0",
    confianza: {},
  };
}
