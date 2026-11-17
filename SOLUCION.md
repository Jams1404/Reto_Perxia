# Solución — Registro de contratos vigentes

## 1. Problema en una frase

La analista administrativa necesita un punto único y trazable para registrar contratos, detectar duplicados y anticipar vencimientos sin depender de correos dispersos ni de una persona específica.

## 2. Arquitectura

```text
Navegador (web/)
      │ HTTP
      ▼
Backend TypeScript (src/server.ts)
  ├─ ciclo de tool use independiente del proveedor
  ├─ sesiones en memoria con intent y estado explícitos
  └─ validación de argumentos con Zod
      │
      ▼
Herramientas deterministas (src/tools/contratos.ts)
  ├─ fixtures/reto-02/ (solo lectura)
  └─ out/ (maestro, documentos, historial, alertas y logs)
```

- **Comportamiento:** `agent/prompt.md`.
- **Conocimiento del proceso:** `src/knowledge/registro-contratos.md`.
- **Ejecución:** `src/tools/contratos.ts` y persistencia auxiliar en `src/tools/storage.ts`.
- **Interfaz:** HTML, CSS y JavaScript en `web/`.
- **Adaptador de modelo:** contrato en `src/llm/adapter.ts` e implementación Gemini en `src/llm/gemini.ts`; la clave vive únicamente en `GEMINI_API_KEY`.

## 3. Ciclo del agente y confirmación

El backend envía el historial, el prompt y las herramientas a Gemini mediante el adaptador. Valida con Zod cada entrada propuesta, ejecuta la herramienta en TypeScript y devuelve el resultado al modelo. El ciclo se limita con `MAX_TOOL_ITERATIONS`. El límite de sesión es configurable mediante `MAX_SESSION_TOKENS` y se estima por caracteres; para producción conviene usar el conteo real de tokens.

El servidor clasifica cada mensaje en una intención (`procesar_buzon`, `consultar_alertas`, `procesar_y_alertar`, `confirmar_registro` o `conversacion`) y actualiza el estado de sesión (`inactivo`, `procesando` o `esperando_confirmacion`). La interfaz muestra intención y estado en la respuesta del agente.

Una validación con campos de baja confianza o una inconsistencia deja una acción pendiente en la sesión. La siguiente respuesta del usuario solo se considera aprobación si comienza con una expresión explícita como «sí», «confirmo» o «autorizo». El servidor ejecuta entonces la acción pendiente; la aprobación no puede anticiparse dentro del primer turno ni ser inventada por el modelo. Si el usuario proporciona fecha o valor, el backend solo aplica las correcciones explícitas que reconoce.

El servidor conserva por sesión las extracciones y validaciones efectuadas y exige que cada etapa reutilice exactamente el objeto de la etapa anterior. Las herramientas también comparan la validación con una nueva extracción del adjunto; si el modelo altera un valor o confianza, se rechaza y registra el intento. Los contratos sin número explícito reciben un ID `AUTO-<año>-<secuencia>` al registrarse.

## 4. Elección del modelo y costo

- **Proveedor/modelo:** Google Gemini API, `gemini-3.8-flash` por defecto. Se configura con `GEMINI_MODEL`.
- **Motivo:** permite function calling y dispone de una cuota gratuita para pruebas; la extracción y las escrituras críticas siguen estando en código determinista.
- **Costo de referencia:** USD 0 dentro de la cuota gratuita disponible para ese modelo. La cuota y disponibilidad pueden cambiar; verifica los límites actuales antes de desplegar y no habilites facturación si necesitas evitar cargos. El nivel gratuito puede usar las solicitudes para mejorar productos de Google.

## 5. Estrategia de extracción

La extracción P0 usa texto del adjunto, regex y reglas deterministas: número del contrato, primera contraparte, identificador fiscal, objeto, moneda/valor, fechas expresas y pólizas mencionadas. El país se infiere primero del identificador y luego del texto. Campos que no aparecen permanecen como `null` con confianza `0`; no se completa el texto usando el modelo.

Los valores literales bien identificados reciben confianza alta; condiciones de póliza indirectas o ambiguas reciben confianza menor. Se usa el umbral **0,85** de las diapositivas de evaluación, más estricto que el **0,80** del PRD. Un remitente desconocido se informa pero no bloquea. Toda extracción pasa por `contratos_validar` antes del registro.

Limitaciones actuales: los formatos de fechas y correcciones humanas reconocidos son acotados, no hay OCR, y la extracción de NIT/RUC debe ampliarse y probarse con documentos de producción.

## 6. Regla de gobierno

1. **Canal único:** `contratos@periferia-ficticia.com`, administrado por la analista administrativa dueña del maestro, con una persona suplente.
2. **Obligación del comercial:** enviar el PDF firmado, sus otrosíes y actas de terminación dentro de los dos días hábiles siguientes a la firma. Asunto: `[CONTRATO|OTROSÍ|TERMINACIÓN] · ID · Cliente · fecha de firma`. Si el contrato no tiene valor fijo, indicarlo como «por demanda» y adjuntar la orden de servicio cuando exista.
3. **Acuse automático:** confirmar recepción en un máximo de cinco minutos, devolver el ID del mensaje y avisar si faltan campos. El acuse no equivale al registro ni a aprobación jurídica.
4. **Excepciones y escalamiento:** un documento sin firma queda en espera; valor o fechas ambiguas se devuelven al comercial para aclaración. Si no responde en dos días hábiles, se escala al gerente comercial y a la dueña administrativa. El agente no inventa términos.
5. **Cierre del gap junio–agosto de 2026:** hacer una campaña de tres semanas con Finanzas, Ventas y líderes de cuenta: extraer contratos de facturas/órdenes del periodo, solicitar PDF firmado y otrosíes a cada comercial, cruzar por NIT/ID contra el maestro, registrar con fuente `migracion` y documentar excepciones.
6. **Indicador mensual:** contratos facturados que están en el maestro / total de contratos facturados, con meta ≥ 98%; revisar diferencias con Finanzas cada mes.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Extracción determinista para P0 | Dejar que el LLM escriba directamente el maestro | Reduce invenciones y permite una demo sin clave ni variabilidad. |
| Gemini API con cuota gratuita para la demo | Anthropic de pago | Evita requerir una clave de pago para la presentación; los fixtures son ficticios y no se envía información confidencial. |
| CSV y archivos JSONL en `out/` | Base de datos | El reto pide un almacenamiento local simple y sin base de datos. |
| Interfaz web sin framework | React u otro framework | El chat requerido es acotado y así se evitan dependencias de interfaz. |
| Umbral de revisión 0,85 | Aplicar 0,80 literal del PRD | Sigue el criterio más estricto de la rúbrica adjunta. |

## 8. Supuestos

- Los adjuntos de los fixtures contienen texto UTF-8 y representan contratos legibles.
- El año y los importes se extraen solo cuando aparecen explícitamente; las fechas faltantes no se calculan a partir de duraciones imprecisas.
- Los documentos de ejemplo son `.txt`; se archivan conservando la extensión. Los PDF nativos/OCR quedan fuera de P0.
- En la demo, la analista confirma explícitamente para `msg-006` fechas y valor de ejemplo. Esa entrada determinista simula la respuesta humana, no un dato extraído del fixture.

## 9. Cobertura

| Historia | Estado | Pendiente para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | Integración real con Exchange. |
| HU-2 Extraer datos | Hecho para fixtures | OCR, más formatos de contrato y evaluación por campo. |
| HU-3 Validar y clasificar | Hecho | Revisión del algoritmo de similitud con casos reales. |
| HU-4 Registrar y archivar | Hecho en filesystem local | SharePoint real, permisos, bloqueo ante escrituras concurrentes. |
| HU-5 Alertas | Hecho | Envío programado y canales de notificación. |
| HU-6 Errores | Parcial | Las herramientas reportan texto vacío, fechas inválidas, monedas no soportadas y fechas contradictorias; falta ampliar las pruebas de recuperación del proveedor. |
| Chat, sesiones y tool use | Hecho | Sesiones persistentes, autenticación y controles de costo por usuario. |

El Blueprint de Render está preparado en `render.yaml`, pero el enlace público todavía debe crearse desde una cuenta de Render y documentarse aquí antes de la entrega. El plan Free tiene almacenamiento efímero y se limita a la demostración con fixtures ficticios.

## 10. Uso de IA

Se usó **Copilot (Copilot SDK en VS Code)** para apoyar la estructura inicial del código, revisar errores de TypeScript y preparar documentación. La extracción, clasificación y registro se implementaron como código determinista; no se delega al modelo la escritura del maestro. El responsable de la entrega debe revisar y poder explicar el código antes de presentarlo.

## 11. Riesgos y mitigaciones

- **Extracción errónea:** detener el registro con baja confianza y pedir confirmación; agregar pruebas con contratos reales anonimizados.
- **Duplicados por similitud:** priorizar ID y NIT, registrar cambios y revisar falsos positivos antes de ampliar coincidencias difusas.
- **Filtración de credenciales:** variable de entorno solo en el backend, `.env` ignorado y nunca incluido en respuestas ni logs.
- **Acceso público o gasto excesivo:** el prototipo no implementa autenticación; limitar el acceso durante la defensa, controlar cuotas y monitorear consumo. El plan Free de Render puede reiniciar el servicio y perder `out/`.
- **Pérdida o corrupción de archivos:** respaldos, permisos mínimos, escritura atómica y persistencia transaccional antes de producción.
- **Decisiones contractuales incorrectas:** el agente no firma ni da asesoría legal; las decisiones siguen a cargo de personas responsables.
