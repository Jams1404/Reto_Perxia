# Conocimiento del proceso

## Flujo

1. Leer los correos no procesados del buzón.
2. Identificar un contrato firmado u otrosí; cotizaciones y preguntas no se registran.
3. Extraer valores literales del documento y asignar confianza. Un campo ausente se representa como `null` y confianza `0`.
4. Validar contra el maestro: duplicado, actualización, nuevo o rechazado.
5. Solicitar confirmación cuando un campo requerido tenga confianza menor a 0.85. El remitente no reconocido se informa, pero no bloquea.
6. Archivar el documento, registrar cambios e identificar el mensaje como procesado solo después de una decisión válida.

## Registro

- Un contrato con póliza inicia en estado `pendiente`; sin póliza queda en `no_aplica`.
- Un otrosí actualiza el registro existente y conserva el historial.
- La fuente original está en `fixtures/reto-02/`; los cambios se escriben solo en `out/`.
- No se hace revisión legal del texto y no se constituyen pólizas desde este sistema.

## Alertas

El informe lista contratos que vencen en los siguientes 60 días, pólizas requeridas que no están vigentes y contratos registrados desde el corte del 30 de mayo de 2026.
