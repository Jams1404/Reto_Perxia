# Agente conversacional de registro de contratos

Aplicación para recibir los contratos del buzón de prueba, extraer sus datos, validar duplicados y actualizaciones, archivar documentos y generar alertas. El backend usa TypeScript, Zod y Gemini; la interfaz es HTML/CSS/JavaScript sin framework.

## Requisitos

- Node.js 22 o posterior.
- Una clave de Gemini API para usar el chat. La demo determinista no necesita clave.

## Inicio rápido

```powershell
npm ci
Copy-Item .env.example .env
```

Completa `GEMINI_API_KEY` en `.env` y ejecuta:

```powershell
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000). No se ha desplegado una URL pública; la aplicación debe ejecutarse localmente durante la presentación.

## Demo sin modelo

```powershell
npm run demo
```

La demo limpia solo `out/`, recorre los seis fixtures, valida los resultados esperados y simula una confirmación humana explícita para `msg-006`. No requiere una clave de API. Repetirla genera los mismos registros y resultados, excepto los timestamps del historial y los logs.

## Configuración

| Variable | Descripción |
|---|---|
| `GEMINI_API_KEY` | Clave privada de Gemini API, solo en el backend. |
| `GEMINI_MODEL` | Modelo de Gemini; por defecto `gemini-3.8-flash`. |
| `PORT` | Puerto HTTP; por defecto `3000`. |
| `MAX_TOOL_ITERATIONS` | Límite de ciclos de llamadas a herramientas por turno; por defecto `25`. |
| `MAX_SESSION_TOKENS` | Límite aproximado por sesión; por defecto `30000`. |

No agregues `.env` al repositorio. `.gitignore` ya lo excluye.

El nivel gratuito de Gemini tiene cuotas y modelos disponibles limitados, y Google indica que puede usar las solicitudes gratuitas para mejorar sus productos. Usa solo los fixtures ficticios; no ingreses contratos reales ni información confidencial.

## Despliegue en Render

El repositorio incluye `render.yaml` como Blueprint. Después de subir el proyecto a GitHub:

1. En Render, crea un **Blueprint** y conecta el repositorio.
2. Render leerá `render.yaml` y solicitará `GEMINI_API_KEY`; ingrésala en el panel de Render, no en Git ni en el chat.
3. Espera el despliegue y verifica `/api/health` y el chat con los fixtures.
4. Añade la URL asignada por Render a este README y a `SOLUCION.md` antes de entregar.

El plan Free usa almacenamiento efímero: `out/` puede perderse cuando el servicio se reinicia. Úsalo solo para la demostración con fixtures ficticios; no cargues contratos reales.

## API

- `POST /api/chat` — `{ "sessionId": "opcional", "message": "..." }`. Devuelve `{ sessionId, reply, toolCalls, needsConfirmation }`.
- `GET /api/sessions/:id` — historial en memoria de la sesión.
- `GET /api/health` — proveedor y modelo, sin exponer claves.

Las sesiones viven en memoria y se pierden al reiniciar el servidor. Los registros generados están en `out/`; los fixtures originales están en `fixtures/reto-02/` y no se modifican.

## Verificación

```powershell
npm run typecheck
npm test
npm run demo
npm audit
```
