import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFunctionSchema, toGeminiContent } from "./gemini.js";

test("preserves Gemini model content for subsequent tool turns", () => {
  const providerContent = {
    role: "model",
    parts: [
      {
        functionCall: { name: "contratos_leer_buzon", args: {}, id: "call-1" },
        thoughtSignature: "opaque-signature",
      },
    ],
  };
  const content = toGeminiContent({
    role: "assistant",
    providerData: providerContent,
  });
  assert.equal(content, providerContent);
});

test("converts tool outputs into Gemini function responses", () => {
  const content = toGeminiContent({
    role: "user",
    text: "Resultado de la herramienta.",
    toolResults: [
      {
        id: "call-1",
        name: "contratos_leer_buzon",
        response: { ok: true, data: { mensajes: [] } },
      },
    ],
  });
  assert.deepEqual(content, {
    role: "user",
    parts: [
      { text: "Resultado de la herramienta." },
      {
        functionResponse: {
          name: "contratos_leer_buzon",
          response: { ok: true, data: { mensajes: [] } },
          id: "call-1",
        },
      },
    ],
  });
});

test("normalizes Zod JSON schemas for Gemini function declarations", () => {
  const schema = normalizeFunctionSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      id_contrato: { type: ["string", "null"] },
      confianza: {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: { type: "number", minimum: 0, maximum: 1 },
      },
    },
  });
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      id_contrato: { type: "string", nullable: true },
      confianza: {
        type: "object",
        additionalProperties: { type: "number", minimum: 0, maximum: 1 },
      },
    },
  });
});
