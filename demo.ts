import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  alertas,
  extraer,
  leer_buzon,
  registrar,
  validar,
} from "./src/tools/contratos.js";
import {
  readMaster,
  readProcessed,
  readText,
  SHAREPOINT,
} from "./src/tools/storage.js";
import type { Contract, Context } from "./src/tools/storage.js";

const ctx: Context = { directory: process.cwd(), sessionId: "demo" };

function readResult<T>(serialized: string): T {
  const result = JSON.parse(serialized) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function main(): Promise<void> {
  await rm("out", { recursive: true, force: true });
  const { mensajes } = readResult<{ mensajes: Array<{ id: string }> }>(
    await leer_buzon.execute({}, ctx),
  );
  const expected: Record<string, string> = {
    "msg-001": "nuevo",
    "msg-002": "nuevo",
    "msg-003": "actualizacion",
    "msg-004": "duplicado",
    "msg-005": "rechazado",
    "msg-006": "nuevo",
  };
  assert.equal(mensajes.length, 6, "El buzón de prueba debe contener seis mensajes.");
  for (const { id } of mensajes) {
    const contract = readResult<Contract>(
      await extraer.execute({ mensaje_id: id }, ctx),
    );
    const validation = readResult<{
      clasificacion: string;
      requiere_revision: string[];
      motivo?: string;
    }>(
      await validar.execute({ mensaje_id: id, contrato: contract }, ctx),
    );
    console.log(`\n${id}: ${validation.clasificacion}`);
    assert.equal(
      validation.clasificacion,
      expected[id],
      `${id} debe clasificarse como ${expected[id]}.`,
    );
    console.log(
      `  Campos en revisión: ${validation.requiere_revision.join(", ") || "ninguno"}`,
    );
    if (validation.motivo) console.log(`  Motivo: ${validation.motivo}`);

    const firstRegistration = await registrar.execute(
      { mensaje_id: id, contrato: contract },
      ctx,
    );
    const firstResult = JSON.parse(firstRegistration) as
      | { ok: true; data: { accion?: string; clasificacion?: string; motivo?: string } }
      | { ok: false; error: string };
    if (!firstResult.ok) {
      console.log(`  Primera llamada: no registrado (${firstResult.error})`);
      if (id === "msg-006" && validation.requiere_revision.length > 0) {
        assert.match(firstResult.error, /^requiere revisión:/);
        const humanConfirmed: Contract = {
          ...contract,
          fecha_inicio: "2026-08-31",
          fecha_fin: "2027-08-31",
          valor: 0,
          requiere_poliza: true,
          confianza: {
            ...contract.confianza,
            fecha_inicio: 1,
            fecha_fin: 1,
            valor: 1,
            requiere_poliza: 1,
          },
        };
        const secondResult = readResult<{ accion: string }>(
          await registrar.execute(
            { mensaje_id: id, contrato: humanConfirmed, confirmado: true },
            ctx,
          ),
        );
        console.log(
          `  Confirmación humana de demo (fecha inicio/fin y valor): ${secondResult.accion}`,
        );
        assert.equal(secondResult.accion, "nuevo");
      }
    } else {
      console.log(
        `  Acción: ${firstResult.data.accion ?? firstResult.data.clasificacion ?? "sin acción"}`,
      );
      if (firstResult.data.motivo) console.log(`  Motivo: ${firstResult.data.motivo}`);
      if (id !== "msg-005") {
        assert.equal(
          firstResult.data.accion ?? firstResult.data.clasificacion,
          expected[id],
          `${id} debe terminar con la acción esperada.`,
        );
      }
    }
  }
  const report = readResult<{ ruta: string; vencen: unknown[]; polizas_pendientes: unknown[] }>(
    await alertas.execute({ hoy: "2026-09-03" }, ctx),
  );
  console.log(
    `\nAlertas en ${report.ruta}: ${report.vencen.length} vencimientos, ${report.polizas_pendientes.length} pólizas pendientes.`,
  );
  assert.equal(report.polizas_pendientes.length, 3);
  const rows = await readMaster(ctx.directory);
  const ids = rows.map((row) => row.id_contrato);
  assert.equal(rows.length, 11);
  assert.equal(new Set(ids).size, ids.length, "El maestro no debe contener duplicados.");
  assert.deepEqual(
    rows.find((row) => row.id_contrato === "CT-2026-011")?.tipo_poliza,
    "cumplimiento;responsabilidad_civil",
  );
  assert.equal((await readProcessed(ctx.directory)).length, 6);
  const history = (await readText(ctx.directory, SHAREPOINT, "historial.jsonl"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { mensaje_id: string; accion: string });
  assert.equal(
    history.filter((entry) => entry.mensaje_id === "msg-003" && entry.accion === "actualizacion")
      .length,
    1,
  );
  assert.equal(history.some((entry) => entry.mensaje_id === "msg-004"), false);
  console.log("\n[PASS] Validación determinista completada.");
}

main().catch((error: unknown) => {
  console.error("La demo no pudo completar su ejecución:", error);
  process.exitCode = 1;
});
