import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extraer, registrar, validar } from "./contratos.js";
import { HEADERS } from "./storage.js";
import type { Contract, Context } from "./storage.js";

let root = "";
let ctx: Context;

const validContract = (currency = "COP"): string => `CONTRATO DE SERVICIOS No. CT-2026-101

Entre CLIENTE DE PRUEBA S.A., identificada con NIT 800.123.456-7, con domicilio en Bogotá, Colombia, y PERIFERIA IT GROUP S.A.S.

PRIMERA. OBJETO. Prestación de servicios de prueba.

SEGUNDA. VALOR. El valor total del contrato es (${currency} 1000).

TERCERA. PLAZO. Desde el primero (1) de enero de 2026 hasta el treinta (30) de enero de 2026.
`;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "registro-contratos-"));
  const fixtureRoot = path.join(root, "fixtures", "reto-02");
  await mkdir(path.join(fixtureRoot, "buzon"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "comerciales.json"), "[]\n", "utf8");
  await writeFile(
    path.join(fixtureRoot, "maestro-contratos.csv"),
    `${HEADERS.join(",")}\n`,
    "utf8",
  );
  ctx = { directory: root, sessionId: "test" };
  await addMessage("test-valid", validContract());
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function addMessage(id: string, text: string): Promise<void> {
  const messageRoot = path.join(root, "fixtures", "reto-02", "buzon", id);
  await mkdir(messageRoot, { recursive: true });
  await writeFile(
    path.join(messageRoot, "correo.json"),
    JSON.stringify({
      id,
      de: "desconocido@example.test",
      para: "contratos@example.test",
      asunto: `Contrato de prueba ${id}`,
      fecha: "2026-01-01T10:00:00Z",
      cuerpo: "El contrato no requiere póliza.",
      adjuntos: ["contrato.txt"],
    }),
    "utf8",
  );
  await writeFile(path.join(messageRoot, "contrato.txt"), text, "utf8");
}

function assertToolError(serialized: string, expected: RegExp): void {
  const result = JSON.parse(serialized) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", expected);
}

test("texto de contrato vacío devuelve error y el buzón continúa procesable", async () => {
  await addMessage("test-empty", "");
  assertToolError(
    await extraer.execute({ mensaje_id: "test-empty" }, ctx),
    /texto del adjunto está vacío/i,
  );
  const next = JSON.parse(
    await extraer.execute({ mensaje_id: "test-valid" }, ctx),
  ) as { ok: boolean; data?: Contract };
  assert.equal(next.ok, true);
  assert.equal(next.data?.id_contrato, "CT-2026-101");
});

test("fecha calendario inválida devuelve error legible", async () => {
  await addMessage(
    "test-invalid-date",
    validContract().replace(
      "treinta (30) de enero de 2026",
      "treinta y uno (31) de febrero de 2026",
    ),
  );
  assertToolError(
    await extraer.execute({ mensaje_id: "test-invalid-date" }, ctx),
    /fecha inválida/i,
  );
});

test("moneda no soportada devuelve error en extracción y validación", async () => {
  await addMessage("test-unknown-currency", validContract("XYZ"));
  assertToolError(
    await extraer.execute({ mensaje_id: "test-unknown-currency" }, ctx),
    /moneda desconocida: XYZ/i,
  );

  const extraction = JSON.parse(
    await extraer.execute({ mensaje_id: "test-valid" }, ctx),
  ) as { ok: true; data: Contract };
  extraction.data.moneda = "XYZ";
  assertToolError(
    await validar.execute(
      { mensaje_id: "test-valid", contrato: extraction.data },
      ctx,
    ),
    /no coincide con los datos extraídos/i,
  );
});

test("no se aceptan valores alterados por el modelo antes de validar", async () => {
  const extraction = JSON.parse(
    await extraer.execute({ mensaje_id: "test-valid" }, ctx),
  ) as { ok: true; data: Contract };
  extraction.data.valor = 99_999;
  assertToolError(
    await validar.execute(
      { mensaje_id: "test-valid", contrato: extraction.data },
      ctx,
    ),
    /no coincide con los datos extraídos/i,
  );
  assertToolError(
    await registrar.execute(
      { mensaje_id: "test-valid", contrato: extraction.data },
      ctx,
    ),
    /no coincide con los datos extraídos/i,
  );
});

test("genera un identificador AUTO para un contrato sin número explícito", async () => {
  await addMessage(
    "test-auto-id",
    validContract().replace(" No. CT-2026-101", ""),
  );
  const extraction = JSON.parse(
    await extraer.execute({ mensaje_id: "test-auto-id" }, ctx),
  ) as { ok: true; data: Contract };
  assert.equal(extraction.data.id_contrato, null);

  const validation = JSON.parse(
    await validar.execute(
      { mensaje_id: "test-auto-id", contrato: extraction.data },
      ctx,
    ),
  ) as { ok: true; data: { clasificacion: string; requiere_revision: string[] } };
  assert.equal(validation.data.clasificacion, "nuevo");
  assert.equal(validation.data.requiere_revision.includes("id_contrato"), false);

  const registration = JSON.parse(
    await registrar.execute(
      { mensaje_id: "test-auto-id", contrato: extraction.data },
      ctx,
    ),
  ) as {
    ok: true;
    data: { id_contrato: string; accion: string };
  };
  assert.equal(registration.data.id_contrato, "AUTO-2026-001");
  assert.equal(registration.data.accion, "nuevo");
});

test("fechas contradictorias piden revisión y bloquean el registro", async () => {
  await addMessage(
    "test-reversed-dates",
    validContract().replace(
      "primero (1) de enero de 2026",
      "primero (1) de noviembre de 2026",
    ),
  );
  const extraction = JSON.parse(
    await extraer.execute({ mensaje_id: "test-reversed-dates" }, ctx),
  ) as { ok: true; data: Contract };
  const contract = extraction.data;
  const validation = JSON.parse(
    await validar.execute(
      { mensaje_id: "test-reversed-dates", contrato: contract },
      ctx,
    ),
  ) as {
    ok: true;
    data: { requiere_revision: string[]; conflictos: string[] };
  };
  assert.ok(validation.data.requiere_revision.includes("fecha_inicio"));
  assert.ok(validation.data.requiere_revision.includes("fecha_fin"));
  assert.match(validation.data.conflictos[0] ?? "", /posterior/i);

  assertToolError(
    await registrar.execute(
      { mensaje_id: "test-reversed-dates", contrato: contract },
      ctx,
    ),
    /requiere revisión/i,
  );
  assertToolError(
    await registrar.execute(
      { mensaje_id: "test-reversed-dates", contrato: contract, confirmado: true },
      ctx,
    ),
    /no puede ser posterior/i,
  );
});
