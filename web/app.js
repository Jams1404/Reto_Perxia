const conversation = document.querySelector("#conversation");
const form = document.querySelector("#chat-form");
const input = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const thinking = document.querySelector("#thinking");
const health = document.querySelector("#health");
const newSessionButton = document.querySelector("#new-session");
const intentLabels = {
  procesar_buzon: "procesar buzón",
  consultar_alertas: "consultar alertas",
  procesar_y_alertar: "procesar y alertar",
  confirmar_registro: "confirmar registro",
  conversacion: "conversación",
};
const stateLabels = {
  inactivo: "inactivo",
  procesando: "procesando",
  esperando_confirmacion: "esperando confirmación",
};

let sessionId = localStorage.getItem("contract-agent-session") || crypto.randomUUID();
localStorage.setItem("contract-agent-session", sessionId);

function renderEmpty() {
  conversation.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent =
    "Puedo revisar los mensajes pendientes, extraer los datos, validar duplicados y generar alertas. Describe lo que necesitas; antes de registrar datos dudosos te pediré confirmación.";
  conversation.append(empty);
}

function addToolCalls(container, calls) {
  if (!calls?.length) return;
  const list = document.createElement("div");
  list.className = "tool-list";
  for (const call of calls) {
    const card = document.createElement("details");
    card.className = "tool-card";
    const summary = document.createElement("summary");
    summary.textContent = `${call.nombre} · ${call.resultado}`;
    const args = document.createElement("pre");
    args.textContent = `Argumentos\n${JSON.stringify(call.argumentos, null, 2)}`;
    const result = document.createElement("pre");
    result.textContent = `Resultado\n${call.resultado}`;
    card.append(summary, args, result);
    list.append(card);
  }
  container.append(list);
}

function addMessage(entry) {
  if (conversation.querySelector(".empty-state")) conversation.replaceChildren();
  const wrapper = document.createElement("article");
  wrapper.className = `message ${entry.role}`;
  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = entry.role === "user" ? "Tú" : "Agente";
  if (entry.intent) {
    const context = document.createElement("span");
    context.className = "message-context";
    context.textContent = ` · ${intentLabels[entry.intent] || entry.intent} · ${stateLabels[entry.state] || entry.state || ""}`;
    label.append(context);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = entry.content;
  wrapper.append(label, bubble);
  if (entry.role === "assistant") {
    addToolCalls(wrapper, entry.toolCalls);
    if (entry.needsConfirmation) {
      const notice = document.createElement("div");
      notice.className = "confirmation";
      notice.textContent =
        "Se requiere tu confirmación. Responde explícitamente; si corriges fechas o valor, indícalos en el mensaje.";
      wrapper.append(notice);
    }
  }
  conversation.append(wrapper);
  conversation.scrollTop = conversation.scrollHeight;
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    health.textContent = data.ok ? `Proveedor: ${data.provider} · ${data.model}` : "Servicio no disponible";
    health.className = `health ${data.ok ? "ok" : "error"}`;
  } catch {
    health.textContent = "Backend no disponible";
    health.className = "health error";
  }
}

async function loadSession() {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
      renderEmpty();
      return;
    }
    const data = await response.json();
    conversation.replaceChildren();
    for (const entry of data.history) addMessage(entry);
    if (data.history.length === 0) renderEmpty();
  } catch {
    renderEmpty();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  addMessage({ role: "user", content: message });
  input.value = "";
  sendButton.disabled = true;
  thinking.hidden = false;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });
    const data = await response.json();
    if (!response.ok) {
      addMessage({ role: "assistant", content: data.error || "No se pudo procesar el mensaje." });
      return;
    }
    sessionId = data.sessionId;
    localStorage.setItem("contract-agent-session", sessionId);
    addMessage({
      role: "assistant",
      content: data.reply,
      toolCalls: data.toolCalls,
      needsConfirmation: data.needsConfirmation,
      intent: data.intent,
      state: data.state,
    });
  } catch {
    addMessage({ role: "assistant", content: "No fue posible contactar al backend. Intenta de nuevo." });
  } finally {
    thinking.hidden = true;
    sendButton.disabled = false;
    input.focus();
  }
});

newSessionButton.addEventListener("click", () => {
  sessionId = crypto.randomUUID();
  localStorage.setItem("contract-agent-session", sessionId);
  renderEmpty();
  input.focus();
});

renderEmpty();
loadHealth();
loadSession();
