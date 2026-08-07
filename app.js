import { getAgentResponse } from './llm-helper.js';

// PLANTILLAS DE PROMPTS
const PROMPT_TEMPLATES = {
  ecommerce: `Eres un asistente de ventas de WhatsApp altamente persuasivo y carismático.
Tu meta principal es concretar la venta de nuestros productos.
Reglas:
1. Destaca los beneficios exclusivos de nuestros productos.
2. Crea una sensación de urgencia (ej. "¡Solo nos quedan pocas unidades disponibles!").
3. Simplifica el proceso de compra; guía al usuario paso a paso hacia el pago.
4. Sé conversacional, amigable y mantén los mensajes breves y fáciles de responder.`,
  
  booking: `Eres un asistente virtual enfocado en el agendamiento y reservas de citas.
Tu meta es guiar al usuario para que reserve un horario en nuestra agenda disponible.
Reglas:
1. Explica brevemente los servicios que ofrecemos.
2. Solicita al usuario que indique el día y hora de su preferencia.
3. Una vez propuesto el horario, pídele su nombre completo y correo electrónico para confirmar la reserva.
4. Responde con un tono servicial y extremadamente organizado.`,
  
  faq: `Eres el encargado de resolver dudas frecuentes y dar soporte al cliente.
Tu meta es responder con absoluta precisión y claridad a las consultas sobre la empresa.
Reglas:
1. Utiliza los documentos de entrenamiento de forma rigurosa. No inventes políticas ni precios.
2. Si un dato no está en el entrenamiento, di amablemente: "Esa información no la tengo disponible en este momento, pero puedo tomar sus datos para que un ejecutivo le llame".
3. Sé paciente, amable y mantén una actitud resolutiva.`
};

const TONE_TEMPLATES = {
  friendly: { title: "Cálido y amistoso", text: "Cercano, empático y positivo. Puede usar pocos emojis; nunca promete datos no confirmados." },
  professional: { title: "Formal y profesional", text: "Respetuoso, preciso y ordenado. Prioriza datos verificables y evita lenguaje coloquial." },
  casual: { title: "Casual e informal", text: "Natural y cercano, con mensajes breves. Mantiene respeto y precisión, sin jerga confusa." },
  direct: { title: "Directo y conciso", text: "Responde primero lo preguntado, sin rodeos; frases cortas y una pregunta por vez." },
  persuasive: { title: "Persuasivo / ventas", text: "Conecta beneficios confirmados con la necesidad y propone un siguiente paso; nunca inventa urgencia ni descuentos." }
};

// ESTADO GLOBAL DE LA APLICACIÓN
let state = {
  clients: [],
  activeClientId: ""
};

// ==========================================
// INICIALIZACIÓN Y CARGA DE DATOS (API REST)
// ==========================================
document.addEventListener("DOMContentLoaded", async () => {
  initRouter();
  initEventListeners();
  await initializeApp();
  lucide.createIcons();
});

async function initializeApp() {
  // Cargar clientes desde la API del servidor
  await fetchClients();

  // Seleccionar cliente por defecto
  const lastActive = localStorage.getItem("za_active_client");
  if (lastActive && state.clients.some(c => c.id === lastActive)) {
    state.activeClientId = lastActive;
  } else if (state.clients.length > 0) {
    state.activeClientId = state.clients[0].id;
  }

  syncGlobalUI();
}

async function fetchClients() {
  try {
    const res = await fetch('/api/clients');
    if (!res.ok) throw new Error("No se pudieron cargar los clientes del servidor.");
    state.clients = await res.json();
  } catch (error) {
    console.error("Error al cargar clientes:", error);
    alert("Error de conexión con el backend de SQLite. Por favor verifica que el servidor esté activo.");
  }
}

// Contrato pequeño para módulos locales de Studio (por ejemplo Prospección)
// que crean un proyecto sin duplicar la lógica del portafolio.
window.zeroagentRefreshClients = async () => {
  await fetchClients();
  syncGlobalUI();
};

// ==========================================
// ENRUTADOR (ROUTER) BÁSICO
// ==========================================
function initRouter() {
  const menuItems = document.querySelectorAll(".menu-item");
  const views = document.querySelectorAll(".app-view");
  
  menuItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      
      const targetView = item.getAttribute("data-view");
      
      // Cambiar clase activa en menú
      menuItems.forEach(mi => mi.classList.remove("active"));
      item.classList.add("active");
      
      // Cambiar vista visible
      views.forEach(view => {
        view.classList.remove("active");
        if (view.id === `view-${targetView}`) {
          view.classList.add("active");
        }
      });

      // Actualizar Header
      updateHeaderInfo(targetView);
      
      // Sincronizar contenido de la vista seleccionada
      syncViewContent(targetView);
    });
  });

  // Cargar vista inicial basándose en el hash
  const hash = window.location.hash.replace("#", "");
  if (hash) {
    const activeMenu = document.querySelector(`.menu-item[data-view="${hash}"]`);
    if (activeMenu) activeMenu.click();
  }
}

function updateHeaderInfo(view) {
  document.body.dataset.activeView = view;
  const viewTitle = document.getElementById("view-title");
  const viewSubtitle = document.getElementById("view-subtitle");
  
  const headers = {
    overview: { title: "Portafolio", subtitle: "Clientes, agentes y próximas acciones en un solo lugar" },
    activity: { title: "Actividad", subtitle: "Lo que cambió y requiere una decisión" },
    prospecting: { title: "Prospección", subtitle: "Radar local, pipeline y seguimiento comercial" },
    project: { title: "Resumen del proyecto", subtitle: "Avance, bloqueos, versiones e instalación" },
    editor: { title: "Solución", subtitle: "Identidad, comportamiento y módulos contratados" },
    agenda: { title: "Agenda", subtitle: "Configura la solución de reservas que viajará al cliente" },
    knowledge: { title: "Conocimiento", subtitle: "Hechos trazables, reglas y pruebas contra alucinaciones" },
    sources: { title: "Diagnóstico", subtitle: "Entrevista guiada, documentos y revisión de información" },
    simulator: { title: "Calidad", subtitle: "Prueba, aprueba y corrige el comportamiento antes de publicar" },
    "ai-usage": { title: "Monitoreo", subtitle: "Presupuesto, consumo y salud operativa por cliente" },
    settings: { title: "Configuración de Studio", subtitle: "Preferencias locales, proveedores y respaldos" }
  };

  if (headers[view]) {
    viewTitle.textContent = headers[view].title;
    viewSubtitle.textContent = headers[view].subtitle;
  }
}

// ==========================================
// MANEJADORES DE VISTA & SINCRONIZACIÓN DE UI
// ==========================================
function syncGlobalUI() {
  // 1. Selector global en cabecera
  const globalSelect = document.getElementById("global-client-select");
  globalSelect.innerHTML = '<option value="" disabled>Selecciona un cliente...</option>';
  
  state.clients.forEach(client => {
    const opt = document.createElement("option");
    opt.value = client.id;
    opt.textContent = client.name;
    if (client.id === state.activeClientId) {
      opt.selected = true;
    }
    globalSelect.appendChild(opt);
  });

  // 2. Panel de estadísticas rápidas
  document.getElementById("stat-total-clients").textContent = state.clients.length;
  
  const trainedCount = state.clients.filter(c => c.project?.stage && c.project.stage !== "installed").length;
  document.getElementById("stat-trained-agents").textContent = trainedCount;

  const totalDocs = state.clients.reduce((acc, c) => acc + (c.sources ? c.sources.length : 0), 0);
  document.getElementById("stat-total-docs").textContent = totalDocs;

  const totalChats = state.clients.reduce((acc, c) => acc + (c.intakeJobs ? c.intakeJobs.filter(job => job.status === "pending_ide").length : 0), 0);
  document.getElementById("stat-total-chats").textContent = totalChats;

  // 3. Sincronizar vista activa
  const activeMenuItem = document.querySelector(".menu-item.active");
  if (activeMenuItem) {
    syncViewContent(activeMenuItem.getAttribute("data-view"));
  }
}

function syncViewContent(view) {
  const activeClient = state.clients.find(c => c.id === state.activeClientId);

  switch (view) {
    case "overview":
      renderClientsGrid();
      break;

    case "activity":
      window.dispatchEvent(new CustomEvent("zeroagent:render-activity"));
      break;

    case "prospecting":
      window.dispatchEvent(new CustomEvent("zeroagent:render-prospecting"));
      break;

    case "project": {
      const warning = document.getElementById("project-no-client");
      const content = document.getElementById("project-content");
      if (!activeClient) {
        warning.style.display = "flex";
        content.style.display = "none";
      } else {
        warning.style.display = "none";
        content.style.display = "grid";
        document.getElementById("project-stage").value = activeClient.project?.stage || "intake";
        document.getElementById("project-next-action").value = activeClient.project?.nextAction || "";
        document.getElementById("project-notes").value = activeClient.project?.notes || "";
        renderProjectReadiness(activeClient);
        loadInfrastructure(activeClient);
      }
      break;
    }

    case "editor":
      const editorWarning = document.getElementById("editor-no-client");
      const editorContent = document.getElementById("editor-content");
      
      if (!activeClient) {
        editorWarning.style.display = "flex";
        editorContent.style.display = "none";
      } else {
        editorWarning.style.display = "none";
        editorContent.style.display = "grid";
        
        // Cargar datos en el formulario
        document.getElementById("agent-name").value = activeClient.agent?.name || "";
        document.getElementById("agent-tone").value = activeClient.agent?.tone || "friendly";
        renderToneTemplatePreview(activeClient.agent?.tone || "friendly");
        document.getElementById("agent-role").value = activeClient.agent?.role || "";
        document.getElementById("agent-whatsapp").value = activeClient.agent?.whatsapp || "";
        document.getElementById("agent-system-prompt").value = activeClient.agent?.systemPrompt || "";
        
        // Seleccionar color de avatar
        const colorVal = activeClient.agent?.avatarColor || "emerald";
        const colorRadio = document.querySelector(`input[name="avatar-color"][value="${colorVal}"]`);
        if (colorRadio) colorRadio.checked = true;

        document.getElementById("editor-save-status").innerHTML = '<i data-lucide="check-circle" class="text-emerald"></i> <span>Configuración cargada</span>';
        lucide.createIcons();
      }
      break;

    case "agenda": {
      const warning = document.getElementById("agenda-no-client");
      const content = document.getElementById("agenda-content");
      if (!activeClient) {
        warning.style.display = "flex";
        content.style.display = "none";
      } else {
        warning.style.display = "none";
        content.style.display = "grid";
        renderAgendaConfig(activeClient);
      }
      break;
    }

    case "knowledge":
      const knowledgeWarning = document.getElementById("knowledge-no-client");
      const knowledgeContent = document.getElementById("knowledge-content");
      
      if (!activeClient) {
        knowledgeWarning.style.display = "flex";
        knowledgeContent.style.display = "none";
      } else {
        knowledgeWarning.style.display = "none";
        knowledgeContent.style.display = "grid";
        
        document.getElementById("knowledge-client-name").textContent = activeClient.name;
        renderKnowledgeFactsList(activeClient);
        loadGapQuestions(activeClient.id);
      }
      break;

    case "sources": {
      const warning = document.getElementById("sources-no-client");
      const content = document.getElementById("sources-content");
      if (!activeClient) {
        warning.style.display = "flex";
        content.style.display = "none";
      } else {
        warning.style.display = "none";
        content.style.display = "grid";
        renderSourcesList(activeClient);
      }
      break;
    }

    case "simulator":
      const simWarning = document.getElementById("simulator-no-client");
      const simContent = document.getElementById("simulator-content");
      
      if (!activeClient) {
        simWarning.style.display = "flex";
        simContent.style.display = "none";
      } else {
        simWarning.style.display = "none";
        simContent.style.display = "flex";
        
        // Cargar cabecera del chat
        document.getElementById("wa-agent-name").textContent = activeClient.agent?.name || "Agente";
        
        const avatarDiv = document.getElementById("wa-agent-avatar");
        const agentName = activeClient.agent?.name || "A";
        avatarDiv.textContent = agentName.split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase();
        
        // Estilo de color de avatar
        avatarDiv.className = "wa-avatar color-" + (activeClient.agent?.avatarColor || "emerald");
        
        // Renderizar mensajes
        renderChatMessages(activeClient);

        // Actualizar panel de depuración
        document.getElementById("debug-system-prompt").textContent = activeClient.agent?.systemPrompt || "Sin instrucciones configuradas.";
        document.getElementById("debug-model-used").textContent = "Motor runtime · esperando prueba";
      }
      break;

    case "ai-usage":
      loadAiBudget(activeClient);
      break;

    case "settings":
      break;
  }
}

// ==========================================
// RENDERIZADO DE COMPONENTES
// ==========================================

// Renderizar cuadrícula de clientes (Inicio)
function renderClientsGrid() {
  const container = document.getElementById("clients-list-container");
  container.innerHTML = "";

  if (state.clients.length === 0) {
    container.innerHTML = `
      <div class="no-data-placeholder">
        <i data-lucide="users" class="placeholder-icon"></i>
        <h4>No tienes clientes registrados</h4>
        <p>Crea tu primer prospecto de cliente usando el botón "Nuevo Cliente" en la esquina superior derecha.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  state.clients.forEach(client => {
    const card = document.createElement("div");
    card.className = `client-card ${client.id === state.activeClientId ? "active" : ""}`;
    card.setAttribute("data-id", client.id);

    const docCount = client.documents ? client.documents.length : 0;
    const chatCount = client.chats ? client.chats.length : 0;

    card.innerHTML = `
      <div>
        <div class="client-card-header">
          <div class="client-title-area">
            <h4>${escapeHTML(client.name)}</h4>
            <span class="client-niche">${escapeHTML(client.niche)}</span>
          </div>
          <button class="btn-delete-client k-action-btn" data-id="${client.id}" title="Eliminar Cliente">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      <p class="client-desc">${escapeHTML(client.desc || "Sin descripción detallada.")}</p>
      </div>
      <div class="client-stats">
        <div class="client-stat">
          <i data-lucide="brain"></i>
          <span>${docCount} Doc(s)</span>
        </div>
        <div class="client-stat">
          <i data-lucide="message-square"></i>
          <span>${chatCount} Msg(s)</span>
        </div>
        <div class="client-stat">
          <i data-lucide="bot"></i>
          <span class="text-emerald font-bold">${client.agent?.name ? "Activo" : "Borrador"}</span>
        </div>
      </div>
    `;

    // Click en tarjeta selecciona el cliente y abre el editor
    card.addEventListener("click", (e) => {
      if (e.target.closest(".btn-delete-client")) return;

      state.activeClientId = client.id;
      localStorage.setItem("za_active_client", client.id);
      syncGlobalUI();
      
      const editorMenu = document.querySelector('.menu-item[data-view="editor"]');
      if (editorMenu) editorMenu.click();
    });

    // Manejador del botón eliminar
    const deleteBtn = card.querySelector(".btn-delete-client");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`¿Estás seguro de que deseas eliminar el cliente "${client.name}" de SQLite y sus datos?`)) {
        deleteClient(client.id);
      }
    });

    container.appendChild(card);
  });

  lucide.createIcons();
}

// Renderizar listado de documentos de entrenamiento (RAG)
function renderKnowledgeFactsList(client) {
  const container = document.getElementById("knowledge-facts-list");
  container.innerHTML = "";

  const facts = client.knowledgeItems || [];
  const tests = client.tests || [];
  if (facts.length === 0) {
    container.innerHTML = `
      <div class="no-data-placeholder">
        <i data-lucide="shield-question" class="placeholder-icon"></i>
        <h4>Sin datos estructurados</h4>
        <p>Registra hechos críticos, como precios, sucursales o condiciones. No deben quedar escondidos sólo dentro de un prompt.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  facts.forEach(fact => {
    const relatedTests = tests.filter(test => test.knowledge_item_id === fact.id);
    const item = document.createElement("div");
    item.className = "knowledge-fact-item";
    item.innerHTML = `
      <div class="knowledge-fact-header">
        <span class="knowledge-fact-subject">${escapeHTML(fact.subject)}</span>
        <span class="k-doc-tag">${escapeHTML(fact.category)}</span>
      </div>
      <div class="knowledge-fact-value">${escapeHTML(fact.value)}</div>
      ${fact.notes ? `<div class="knowledge-fact-notes">${escapeHTML(fact.notes)}</div>` : ""}
      <div class="knowledge-fact-footer">
        <span>${relatedTests.length ? `${relatedTests.length} prueba(s) asociada(s)` : "Sin prueba aún"}</span>
        <button class="k-action-btn btn-delete-fact" title="Eliminar dato"><i data-lucide="trash-2"></i></button>
      </div>
    `;

    item.querySelector(".btn-delete-fact").addEventListener("click", async () => {
      if (confirm(`¿Eliminar el dato "${fact.subject}"?`)) {
        await deleteKnowledgeFact(client.id, fact.id);
      }
    });

    container.appendChild(item);
  });

  lucide.createIcons();
}

async function loadGapQuestions(clientId) {
  const container = document.getElementById("gap-questions-list");
  if (!container) return;
  container.innerHTML = '<span class="text-xs text-muted">Revisando cobertura…</span>';
  try {
    const res = await fetch(`/api/clients/${clientId}/gap-questions`);
    if (!res.ok) throw new Error("No se pudieron detectar vacíos.");
    const { questions } = await res.json();
    if (!questions.length) {
      container.innerHTML = '<span class="text-xs text-emerald">No se detectaron vacíos básicos. Aun así, revisa conversaciones reales.</span>';
      return;
    }
    container.innerHTML = questions.map(item => `
      <div class="gap-question ${escapeHTML(item.priority)}"><span>${escapeHTML(item.priority === "critical" ? "Crítico" : "Importante")}</span>${escapeHTML(item.question)}</div>
    `).join("");
  } catch (err) {
    container.innerHTML = `<span class="text-xs text-orange">${escapeHTML(err.message)}</span>`;
  }
}

function escapeHTML(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatStage(stage) {
  const stages = {
    intake: "Captación / diagnóstico",
    waiting_info: "Esperando información",
    building: "Construyendo agente",
    testing: "En pruebas",
    ready_to_install: "Listo para instalar",
    installed: "Instalado",
    paused: "Pausado"
  };
  return stages[stage] || "Sin estado";
}

function formatSourceStatus(status) {
  const statuses = {
    pending_ide: "Pendiente para IDE",
    under_review: "En revisión",
    approved: "Aprobada",
    rejected: "Descartada"
  };
  return statuses[status] || status;
}

function formatLocalDate(value) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderToneTemplatePreview(tone) {
  const preview = document.getElementById("tone-template-preview");
  if (!preview) return;
  const template = TONE_TEMPLATES[tone] || TONE_TEMPLATES.friendly;
  preview.innerHTML = `<strong>Plantilla activa: ${escapeHTML(template.title)}</strong><span>${escapeHTML(template.text)}</span>`;
}

function renderProjectReadiness(client) {
  const container = document.getElementById("project-readiness");
  const sources = client.sources || [];
  const approvedSources = sources.filter(source => source.status === "approved").length;
  const pendingJobs = (client.intakeJobs || []).filter(job => job.status === "pending_ide").length;
  const hasAgentIdentity = Boolean(client.agent?.name && client.agent?.systemPrompt);
  const hasVersion = (client.versions || []).length > 0;
  const agenda = client.agenda || {};
  const agendaEnabled = Boolean(agenda.enabled);
  const agendaCatalogReady = !agendaEnabled || Boolean(agenda.services?.length && agenda.resources?.length);

  const items = [
    { ready: hasAgentIdentity, text: hasAgentIdentity ? "Identidad y directivas configuradas" : "Falta configurar identidad y directivas" },
    { ready: sources.length > 0, text: sources.length ? `${sources.length} fuente(s) registrada(s)` : "Falta registrar una fuente original" },
    { ready: approvedSources > 0, text: approvedSources ? `${approvedSources} fuente(s) aprobada(s)` : "Falta revisar y aprobar información" },
    { ready: pendingJobs === 0, text: pendingJobs ? `${pendingJobs} tarea(s) pendiente(s) para IDE` : "No hay tareas pendientes para IDE" },
    { ready: agendaCatalogReady, text: !agendaEnabled ? "Agenda v1 no aplica a este agente" : agendaCatalogReady ? `Agenda v1 preparada: ${agenda.services.length} servicio(s) y ${agenda.resources.length} recurso(s)` : "Agenda v1 activa pero falta catálogo de servicios o recursos" },
    { ready: hasVersion, text: hasVersion ? "Existe al menos una versión del agente" : "Aún no existe un paquete versionado" }
  ];

  container.innerHTML = `
    <div class="project-stage-pill">${escapeHTML(formatStage(client.project?.stage || "intake"))}</div>
    <div class="readiness-list mt-md">
      ${items.map(item => `
        <div class="readiness-item ${item.ready ? "ready" : "pending"}">
          <i data-lucide="${item.ready ? "check-circle-2" : "circle-dashed"}"></i>
          <span>${escapeHTML(item.text)}</span>
        </div>
      `).join("")}
    </div>
  `;
  lucide.createIcons();
  renderProjectVersions(client);
}

function renderProjectVersions(client) {
  const container = document.getElementById("project-versions-list");
  const versions = client.versions || [];
  if (versions.length === 0) {
    container.innerHTML = '<span class="text-xs text-muted">Aún no se ha creado ninguna versión.</span>';
    return;
  }

  container.innerHTML = "";
  versions.forEach(version => {
    const item = document.createElement("div");
    item.className = "project-version-item";
    item.innerHTML = `
      <div>
        <div class="project-version-name">v${escapeHTML(version.version)} · ${escapeHTML(version.status === "approved" ? "Aprobada" : "Borrador")}</div>
        <div class="project-version-summary">${escapeHTML(version.summary || "Sin resumen")}</div>
      </div>
      <div class="project-version-actions">
        ${version.status !== "approved" ? '<button class="btn btn-emerald btn-xs" data-version-approve="true">Aprobar</button>' : ""}
        ${version.status === "approved" ? `
          <label class="runtime-target-control">
            <span class="sr-only">Entorno de instalación</span>
            <select class="runtime-target-select" data-runtime-target aria-label="Entorno de instalación">
              <option value="preview">Preview</option>
              <option value="staging">Staging</option>
              <option value="production">Producción</option>
            </select>
          </label>
          <button class="btn btn-outline btn-xs" data-runtime-build="true">Construir</button>
        ` : ""}
        <a class="btn btn-outline btn-xs" href="/api/clients/${encodeURIComponent(client.id)}/versions/${encodeURIComponent(version.id)}/export">Exportar</a>
      </div>
    `;
    const approveButton = item.querySelector("[data-version-approve]");
    if (approveButton) {
      approveButton.addEventListener("click", () => approveAgentVersion(client.id, version.id));
    }
    const buildButton = item.querySelector("[data-runtime-build]");
    if (buildButton) {
      buildButton.addEventListener("click", () => {
        const target = item.querySelector("[data-runtime-target]")?.value;
        buildAgentRuntime(client.id, version.id, target);
      });
    }
    container.appendChild(item);
  });
}

function renderSourcesList(client) {
  const container = document.getElementById("sources-list");
  const sources = client.sources || [];
  container.innerHTML = "";

  if (sources.length === 0) {
    container.innerHTML = `
      <div class="no-data-placeholder">
        <i data-lucide="folder-plus" class="placeholder-icon"></i>
        <h4>Aún no hay fuentes</h4>
        <p>Sube un Excel, documento, enlace o nota. Quedará guardado localmente y listo para ser interpretado desde el IDE.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  sources.forEach(source => {
    const item = document.createElement("article");
    item.className = "source-item";
    const job = (client.intakeJobs || []).find(currentJob => currentJob.source_id === source.id);
    const fileLink = source.storage_path
      ? `<a class="text-emerald" href="/storage/${encodeURI(source.storage_path)}" target="_blank" rel="noopener">Abrir original</a>`
      : "Sin archivo adjunto";
    const changeCount = job?.proposal?.changes
      ? Object.values(job.proposal.changes).reduce((total, changes) => total + (Array.isArray(changes) ? changes.length : 0), 0)
      : 0;
    const proposalSummary = job?.proposal
      ? (() => {
          const facts = job.proposal.knowledge_proposal?.facts || job.proposal.knowledge_proposal?.items || job.proposal.knowledge_items || [];
          const tests = job.proposal.test_proposals || job.proposal.tests || [];
          return `<div class="source-proposal"><strong>Propuesta del IDE</strong><span>${escapeHTML(job.proposal.summary)}</span><small>${changeCount} cambio(s) o alerta(s) detectada(s). Revisión humana pendiente.</small>
            <details class="proposal-details"><summary>Ver datos y pruebas propuestos</summary>
              <div class="proposal-detail-list"><b>Datos (${facts.length})</b>${facts.length ? facts.map(fact => `<div>• <strong>${escapeHTML(fact.subject || "Sin asunto")}</strong>: ${escapeHTML(fact.value || "Sin valor")}</div>`).join("") : "<div>Sin datos estructurados propuestos.</div>"}
              <b>Pruebas (${tests.length})</b>${tests.length ? tests.map(test => `<div>• ${escapeHTML(test.question || "Sin pregunta")}</div>`).join("") : "<div>Sin pruebas propuestas.</div>"}</div>
            </details></div>`;
        })()
      : job
        ? `<div class="source-ide-status">Tarea para IDE: ${escapeHTML(formatSourceStatus(job.status))}</div>`
        : "";

    item.innerHTML = `
      <div class="source-item-header">
        <div>
          <div class="source-item-title">${escapeHTML(source.title)}</div>
          <div class="source-item-meta">
            <span>${escapeHTML(source.source_type)}</span>
            <span>v${source.version_number}</span>
            <span>${escapeHTML(source.original_name || "Sin nombre de archivo")}</span>
          </div>
        </div>
        <span class="source-badge ${escapeHTML(source.status)}">${escapeHTML(formatSourceStatus(source.status))}</span>
      </div>
      <div class="source-item-meta">
        <span>${escapeHTML(formatLocalDate(source.created_at))}</span>
        <span>${source.size_bytes ? `${Math.ceil(source.size_bytes / 1024)} KB` : "Registro manual"}</span>
        ${fileLink}
      </div>
      ${source.notes ? `<div class="source-item-notes">${escapeHTML(source.notes)}</div>` : ""}
      ${proposalSummary}
      <div class="source-item-actions">
        ${source.status === "pending_ide" ? '<button class="btn btn-outline btn-xs" data-source-status="under_review">Marcar en revisión</button>' : ""}
        ${job?.proposal && job.status !== "applied" ? '<button class="btn btn-emerald btn-xs" data-proposal-apply="true">Aplicar propuesta aprobada</button>' : ""}
        ${source.status !== "approved" && source.status !== "rejected" ? '<button class="btn btn-emerald btn-xs" data-source-status="approved">Aprobar fuente</button>' : ""}
        <button class="btn btn-danger-outline btn-xs" data-source-delete="true">Eliminar</button>
      </div>
    `;

    item.querySelectorAll("[data-source-status]").forEach(button => {
      button.addEventListener("click", () => updateSourceStatus(client.id, source.id, button.dataset.sourceStatus));
    });
    const applyButton = item.querySelector("[data-proposal-apply]");
    if (applyButton) {
      applyButton.addEventListener("click", () => applyIntakeProposal(client.id, job.id, source.title));
    }
    item.querySelector("[data-source-delete]").addEventListener("click", () => {
      if (confirm(`¿Eliminar la fuente "${source.title}"? El archivo local también se eliminará.`)) {
        deleteSource(client.id, source.id);
      }
    });
    container.appendChild(item);
  });
  lucide.createIcons();
}

// Renderizar mensajes de chat de WhatsApp (Playground)
function renderChatMessages(client) {
  const container = document.getElementById("whatsapp-messages-container");
  
  container.innerHTML = `
    <div class="wa-system-time">HOY</div>
    <div class="wa-encryption-notice">
      <i data-lucide="lock" class="icon-xs"></i> Cada respuesta ejecuta el mismo motor y paquete versionado que se instala en el cliente.
    </div>
  `;

  if (!client.chats || client.chats.length === 0) {
    client.chats = [
      { sender: "agent", text: `¡Hola! Soy tu asistente de WhatsApp. ¿En qué te puedo asesorar hoy?`, time: "12:00" }
    ];
  }

  client.chats.forEach(msg => {
    const msgDiv = document.createElement("div");
    msgDiv.className = `wa-message ${msg.sender === "user" ? "wa-message-user" : "wa-message-agent"}`;
    const formattedText = escapeHTML(msg.text).replace(/\n/g, "<br>");
    const feedback = (client.feedback || []).find(item => Number(item.chat_id) === Number(msg.id));
    const reviewControls = msg.sender === "agent" && msg.id
      ? feedback
        ? `<div class="message-review-status ${feedback.rating}">${feedback.rating === "up" ? "✓ Respuesta validada" : "↳ Corrección enviada a revisión"}</div>`
        : `<div class="message-review" data-chat-id="${msg.id}">
            <span>¿Correcta?</span>
            <button type="button" class="message-review-btn" data-feedback="up" title="Respuesta correcta">👍</button>
            <button type="button" class="message-review-btn" data-feedback="down" title="Corregir respuesta">👎</button>
            <div class="message-correction-form" hidden>
              <textarea placeholder="¿Cómo debió responder?"></textarea>
              <button type="button" class="btn btn-emerald btn-xs" data-feedback-submit="down">Enviar corrección</button>
            </div>
          </div>`
      : "";

    msgDiv.innerHTML = `
      ${formattedText}
      <div class="wa-msg-meta">
        <span>${escapeHTML(msg.time)}</span>
        ${msg.sender === "user" ? '<i data-lucide="check-check" class="icon-xs"></i>' : ''}
      </div>
      ${reviewControls}
    `;
    const review = msgDiv.querySelector("[data-chat-id]");
    if (review) {
      review.querySelector('[data-feedback="up"]').addEventListener("click", () => submitChatFeedback(client.id, msg.id, "up"));
      review.querySelector('[data-feedback="down"]').addEventListener("click", () => {
        review.querySelector(".message-correction-form").hidden = false;
      });
      review.querySelector('[data-feedback-submit="down"]').addEventListener("click", () => {
        const correctionText = review.querySelector("textarea").value.trim();
        submitChatFeedback(client.id, msg.id, "down", correctionText);
      });
    }
    container.appendChild(msgDiv);
  });

  lucide.createIcons();
  container.scrollTop = container.scrollHeight;
}

function clp(value = 0) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Number(value) || 0);
}

async function loadAiBudget(client) {
  const warning = document.getElementById('ai-usage-no-client');
  const content = document.getElementById('ai-usage-content');
  if (!client) { warning.style.display = 'flex'; content.style.display = 'none'; return; }
  warning.style.display = 'none'; content.style.display = 'grid';
  try {
    const res = await fetch(`/api/clients/${client.id}/ai-budget`);
    if (!res.ok) throw new Error('No se pudo cargar el consumo.');
    const data = await res.json(); const { config, usage } = data;
    document.getElementById('ai-provider').value = config.provider;
    document.getElementById('ai-model').value = config.model;
    document.getElementById('ai-budget-clp').value = Math.round(config.cycle_budget_clp);
    document.getElementById('ai-usd-clp').value = Math.round(config.usd_clp);
    document.getElementById('ai-usage-model').textContent = `${client.name} · ${config.provider} / ${config.model}`;
    document.getElementById('ai-available').textContent = clp(usage.available_clp);
    document.getElementById('ai-spent').textContent = clp(usage.spent_clp);
    document.getElementById('ai-percent').textContent = `${usage.percent.toFixed(1)}%`;
    document.getElementById('ai-requests').textContent = usage.requests;
    const bar = document.getElementById('ai-progress-bar'); const progress = bar.parentElement;
    bar.style.width = `${Math.min(100, usage.percent)}%`;
    progress.className = `ai-progress ${usage.alert_level === 'ok' ? '' : usage.alert_level === '50' ? 'warning' : 'danger'}`;
    document.getElementById('ai-alert-status').textContent = usage.alert_level === 'ok'
      ? 'Todo normal. Las alertas se activan al 50%, 75% y 90% del presupuesto.'
      : `Alerta ${usage.alert_level === 'exhausted' ? 'de presupuesto agotado' : `de ${usage.alert_level}%`}. Registra una recarga o pausa la IA.`;
    lucide.createIcons();
  } catch (error) { alert(`Error de consumo IA: ${error.message}`); }
}

async function loadInfrastructure(client) {
  try {
    const res = await fetch(`/api/clients/${client.id}/infrastructure`);
    if (!res.ok) throw new Error('No se pudo cargar vault.');
    const infra = await res.json();
    document.getElementById('infra-supabase-url').value = infra.supabase_url || '';
    document.getElementById('infra-project-ref').value = infra.project_ref || '';
    document.getElementById('infra-secret-key').value = '';
    const detail = infra.vault_configured ? `Vault local configurado (${infra.credential_hint || 'clave protegida'}) · ${infra.connection_status}` : 'Sin credencial configurada.';
    document.getElementById('infra-vault-status').textContent = detail;
  } catch (error) { document.getElementById('infra-vault-status').textContent = `Error: ${error.message}`; }
}

function splitAgendaLines(value, mapLine) {
  return String(value || '').split('\n').map(line => line.trim()).filter(Boolean).map(mapLine).filter(Boolean);
}

function formatAgendaLines(items, formatter) {
  return (items || []).map(formatter).join('\n');
}

function renderAgendaConfig(client) {
  const agenda = client.agenda || {};
  const rules = agenda.rules || {};
  document.getElementById('agenda-enabled').checked = Boolean(agenda.enabled);
  document.getElementById('agenda-mode').value = agenda.booking_mode || 'appointment';
  document.getElementById('agenda-confirmation').value = agenda.confirmation_mode || 'manual';
  document.getElementById('agenda-timezone').value = agenda.timezone || 'America/Santiago';
  document.getElementById('agenda-reminder').value = agenda.reminder_hours ?? 24;
  document.getElementById('agenda-slot').value = rules.slot_interval_minutes ?? 15;
  document.getElementById('agenda-notice').value = rules.minimum_notice_hours ?? 2;
  document.getElementById('agenda-policy').value = agenda.cancellation_policy || '';
  document.getElementById('agenda-locations').value = formatAgendaLines(agenda.locations, item => [item.name, item.address, item.hours].filter(Boolean).join(' | '));
  document.getElementById('agenda-services').value = formatAgendaLines(agenda.services, item => [item.name, item.duration_minutes, item.price_clp].filter(value => value !== undefined && value !== null && value !== '').join(' | '));
  document.getElementById('agenda-resources').value = formatAgendaLines(agenda.resources, item => [item.name, item.specialty, Array.isArray(item.services) ? item.services.join(', ') : item.services].filter(Boolean).join(' | '));
  updateAgendaContractStatus(agenda);
  loadStudioAgendaFeedback(client);
  lucide.createIcons();
}

async function loadStudioAgendaFeedback(client) {
  const status = document.getElementById('agenda-contract-status');
  if (!client?.agenda?.enabled) return;
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(client.id)}/agenda-feedback`);
    if (res.status === 409) return;
    if (!res.ok) throw new Error('No disponible');
    const remote = await res.json();
    status.textContent += ` · Mantenimiento remoto: ${remote.feedback.length} corrección(es) y ${remote.outbox.length} alerta(s) pendientes.`;
  } catch { status.textContent += ' · No se pudo leer feedback remoto todavía.'; }
}

function updateAgendaContractStatus(agenda) {
  const status = document.getElementById('agenda-contract-status');
  if (!agenda?.enabled) {
    status.textContent = 'Agenda v1 está desactivada: este agente seguirá siendo generalista hasta que la habilites.';
    return;
  }
  const services = agenda.services?.length || 0;
  const resources = agenda.resources?.length || 0;
  status.textContent = `Agenda v1 lista para empaquetar: ${services} servicio(s), ${resources} recurso(s). El runtime exigirá disponibilidad en vivo antes de confirmar una reserva.`;
}

function readAgendaForm() {
  const toNumber = (id, fallback) => Number(document.getElementById(id).value) || fallback;
  return {
    enabled: document.getElementById('agenda-enabled').checked,
    booking_mode: document.getElementById('agenda-mode').value,
    confirmation_mode: document.getElementById('agenda-confirmation').value,
    timezone: document.getElementById('agenda-timezone').value.trim(),
    reminder_hours: toNumber('agenda-reminder', 24),
    cancellation_policy: document.getElementById('agenda-policy').value.trim(),
    locations: splitAgendaLines(document.getElementById('agenda-locations').value, line => {
      const [name, address = '', hours = ''] = line.split('|').map(part => part.trim());
      return name ? { name, address, hours } : null;
    }),
    services: splitAgendaLines(document.getElementById('agenda-services').value, line => {
      const [name, duration, price = ''] = line.split('|').map(part => part.trim());
      if (!name) return null;
      return { name, duration_minutes: Number(duration) || 30, price_clp: price ? Number(String(price).replace(/[^0-9]/g, '')) || null : null };
    }),
    resources: splitAgendaLines(document.getElementById('agenda-resources').value, line => {
      const [name, specialty = '', services = ''] = line.split('|').map(part => part.trim());
      return name ? { name, specialty, services: services.split(',').map(item => item.trim()).filter(Boolean) } : null;
    }),
    rules: {
      slot_interval_minutes: toNumber('agenda-slot', 15),
      minimum_notice_hours: toNumber('agenda-notice', 2),
      maximum_advance_days: 60,
      require_customer_phone: true,
      human_handoff_on_conflict: true
    }
  };
}

async function saveAgendaConfig() {
  const client = state.clients.find(c => c.id === state.activeClientId);
  if (!client) return;
  const payload = readAgendaForm();
  const res = await fetch(`/api/clients/${encodeURIComponent(client.id)}/agenda`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo guardar Agenda v1.');
  const agenda = await res.json();
  client.agenda = agenda;
  updateAgendaContractStatus(agenda);
  return agenda;
}

// ==========================================
// MANEJADORES DE EVENTOS CON LLAMADAS API REST
// ==========================================
function initEventListeners() {
  
  // 1. Cambio de cliente activo desde la cabecera
  document.getElementById("global-client-select").addEventListener("change", (e) => {
    state.activeClientId = e.target.value;
    localStorage.setItem("za_active_client", state.activeClientId);
    syncGlobalUI();
  });

  // 2. Modal: Abrir "Nuevo Cliente"
  const modal = document.getElementById("modal-new-client");
  document.getElementById("btn-new-client").addEventListener("click", () => {
    modal.classList.add("active");
  });

  // 3. Modal: Cerrar "Nuevo Cliente"
  document.getElementById("modal-close-new-client").addEventListener("click", () => {
    modal.classList.remove("active");
  });
  document.getElementById("modal-cancel-new-client").addEventListener("click", () => {
    modal.classList.remove("active");
  });

  // 4. Modal: Guardar nuevo cliente (API POST)
  document.getElementById("new-client-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("new-client-name").value.trim();
    const niche = document.getElementById("new-client-niche").value.trim();
    const desc = document.getElementById("new-client-desc").value.trim();
    
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    if (state.clients.some(c => c.id === id)) {
      alert("Ya existe un cliente con ese nombre.");
      return;
    }

    const newClient = {
      id,
      name,
      niche,
      desc,
      agent: {
        name: `Asistente de ${name}`,
        tone: "friendly",
        avatarColor: "emerald",
        role: `Resolver dudas de clientes de ${name}.`,
        whatsapp: "",
        systemPrompt: `Eres un asistente de WhatsApp atento y profesional de la empresa "${name}".\n\nReglas:\n1. Saluda y sé cortés.\n2. Consulta tus documentos de entrenamiento para dar información verídica.`
      }
    };

    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newClient)
      });

      if (!res.ok) throw new Error("No se pudo crear el cliente en el servidor.");

      // Recargar clientes y sincronizar
      await fetchClients();
      state.activeClientId = id;
      localStorage.setItem("za_active_client", id);
      
      modal.classList.remove("active");
      document.getElementById("new-client-form").reset();
      syncGlobalUI();

    } catch (err) {
      alert("Error al registrar cliente: " + err.message);
    }
  });

  // Estado y notas del proyecto local
  document.getElementById("project-config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;

    const project = {
      stage: document.getElementById("project-stage").value,
      nextAction: document.getElementById("project-next-action").value.trim(),
      notes: document.getElementById("project-notes").value.trim()
    };

    try {
      const res = await fetch(`/api/clients/${activeClient.id}/project`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project)
      });
      if (!res.ok) throw new Error("No se pudo guardar el proyecto.");
      activeClient.project = project;
      renderProjectReadiness(activeClient);
      syncGlobalUI();
    } catch (err) {
      alert("Error al guardar proyecto: " + err.message);
    }
  });

  document.getElementById("project-version-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;
    const version = document.getElementById("agent-version").value.trim();
    const summary = document.getElementById("agent-version-summary").value.trim();

    try {
      const res = await fetch(`/api/clients/${activeClient.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, summary })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "No se pudo crear la versión.");
      }
      document.getElementById("agent-version-summary").value = "";
      await fetchClients();
      syncGlobalUI();
      syncViewContent("project");
    } catch (err) {
      alert("Error al crear versión: " + err.message);
    }
  });

  document.getElementById('infrastructure-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const client = state.clients.find(c => c.id === state.activeClientId); if (!client) return;
    try {
      const res = await fetch(`/api/clients/${client.id}/infrastructure`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
        supabaseUrl: document.getElementById('infra-supabase-url').value, projectRef: document.getElementById('infra-project-ref').value,
        secretKey: document.getElementById('infra-secret-key').value
      }) });
      if (!res.ok) throw new Error((await res.json()).error); await loadInfrastructure(client);
    } catch (error) { alert(`No se pudo guardar vault: ${error.message}`); }
  });
  document.getElementById('infra-test-btn').addEventListener('click', async () => {
    const client = state.clients.find(c => c.id === state.activeClientId); if (!client) return;
    try { const res = await fetch(`/api/clients/${client.id}/infrastructure/test`, {method:'POST'}); if (!res.ok) throw new Error((await res.json()).error); alert('Conexión Supabase verificada.'); await loadInfrastructure(client); } catch (error) { alert(error.message); }
  });
  document.getElementById('infra-forget-btn').addEventListener('click', async () => {
    const client = state.clients.find(c => c.id === state.activeClientId); if (!client || !confirm(`¿Olvidar la credencial local de ${client.name}?`)) return;
    try { const res = await fetch(`/api/clients/${client.id}/infrastructure`, {method:'DELETE'}); if (!res.ok) throw new Error((await res.json()).error); await loadInfrastructure(client); } catch (error) { alert(error.message); }
  });

  document.getElementById('agenda-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await saveAgendaConfig(); alert('Configuración de Agenda v1 guardada.'); }
    catch (error) { alert(error.message); }
  });
  document.getElementById('agenda-catalog-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await saveAgendaConfig(); alert('Catálogo de Agenda v1 guardado y listo para el siguiente paquete.'); }
    catch (error) { alert(error.message); }
  });

  // Registro de fuentes originales; los archivos quedan locales y las tareas para el IDE quedan pendientes.
  document.getElementById("source-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;

    const file = document.getElementById("source-file").files[0];
    const source = {
      title: document.getElementById("source-title").value.trim(),
      sourceType: document.getElementById("source-type").value,
      content: document.getElementById("source-content").value.trim(),
      notes: document.getElementById("source-notes").value.trim(),
      originalName: file?.name || "",
      mimeType: file?.type || "",
      sizeBytes: file?.size || 0,
      fileData: file ? await readFileAsDataURL(file) : ""
    };

    try {
      const res = await fetch(`/api/clients/${activeClient.id}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source)
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "No se pudo registrar la fuente.");
      }
      document.getElementById("source-add-form").reset();
      await fetchClients();
      syncGlobalUI();
      syncViewContent("sources");
    } catch (err) {
      alert("Error al registrar fuente: " + err.message);
    }
  });

  // 5. Editor de Agente: Guardar Configuración (API PUT)
  document.getElementById("agent-config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;

    const name = document.getElementById("agent-name").value.trim();
    const tone = document.getElementById("agent-tone").value;
    const role = document.getElementById("agent-role").value.trim();
    const whatsapp = document.getElementById("agent-whatsapp").value.trim();
    const systemPrompt = document.getElementById("agent-system-prompt").value.trim();
    const avatarColor = document.querySelector('input[name="avatar-color"]:checked').value;

    const agentConfig = {
      name,
      tone,
      role,
      whatsapp,
      systemPrompt,
      avatarColor
    };

    try {
      const res = await fetch(`/api/clients/${activeClient.id}/agent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentConfig)
      });

      if (!res.ok) throw new Error("Error al guardar agente en el backend.");

      // Sincronizar estado local
      activeClient.agent = agentConfig;
      
      const status = document.getElementById("editor-save-status");
      status.innerHTML = '<i data-lucide="check-circle" class="text-emerald"></i> <span>¡Configuración SQLite guardada!</span>';
      lucide.createIcons();
      
      setTimeout(() => {
        status.innerHTML = '<i data-lucide="check-circle" class="text-emerald"></i> <span>Configuración al día</span>';
        lucide.createIcons();
      }, 3000);

    } catch (err) {
      alert("Error al guardar agente: " + err.message);
    }
  });

  // Cargar plantillas de prompts
  const templateButtons = document.querySelectorAll(".btn-tag");
  templateButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const templateName = btn.getAttribute("data-template");
      const promptTextarea = document.getElementById("agent-system-prompt");
      
      if (PROMPT_TEMPLATES[templateName]) {
        promptTextarea.value = PROMPT_TEMPLATES[templateName];
        const status = document.getElementById("editor-save-status");
        status.innerHTML = '<i data-lucide="info" class="text-muted"></i> <span>Plantilla cargada. Guarda para aplicar cambios.</span>';
        lucide.createIcons();
      }
    });
  });

  document.getElementById("agent-tone").addEventListener("change", (event) => {
    renderToneTemplatePreview(event.target.value);
  });

  // 6. Base de Conocimiento: Añadir Documento (API POST)
  document.getElementById("knowledge-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;

    const title = document.getElementById("doc-title").value.trim();
    const content = document.getElementById("doc-content").value.trim();
    const category = document.getElementById("doc-category").value;

    const newDoc = {
      id: "doc-" + Date.now(),
      title,
      content,
      category
    };

    try {
      const res = await fetch(`/api/clients/${activeClient.id}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDoc)
      });

      if (!res.ok) throw new Error("Error al guardar documento de entrenamiento.");

      if (!activeClient.documents) activeClient.documents = [];
      activeClient.documents.push(newDoc);
      
      document.getElementById("knowledge-add-form").reset();
      syncViewContent("knowledge");

    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  document.getElementById("knowledge-fact-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;
    const payload = {
      category: document.getElementById("fact-category").value.trim(),
      subject: document.getElementById("fact-subject").value.trim(),
      value: document.getElementById("fact-value").value.trim(),
      notes: document.getElementById("fact-notes").value.trim(),
      testQuestion: document.getElementById("fact-test-question").value.trim(),
      expectedBehavior: document.getElementById("fact-test-answer").value.trim()
    };
    try {
      const res = await fetch(`/api/clients/${activeClient.id}/knowledge-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "No se pudo guardar el dato.");
      }
      document.getElementById("knowledge-fact-form").reset();
      await fetchClients();
      syncGlobalUI();
      syncViewContent("knowledge");
    } catch (err) {
      alert("Error al guardar dato confirmado: " + err.message);
    }
  });

  document.getElementById("btn-refresh-gap-questions").addEventListener("click", () => {
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (activeClient) loadGapQuestions(activeClient.id);
  });

  // 7. Simulador: Enviar Mensaje (API POST + LLM)
  document.getElementById("whatsapp-chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;

    const userInput = document.getElementById("wa-user-input");
    const userText = userInput.value.trim();
    if (!userText) return;

    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg = { sender: "user", text: userText, time: timeNow };
    
    // Guardar mensaje de usuario en SQLite
    try {
      const savedUser = await fetch(`/api/clients/${activeClient.id}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userMsg)
      });
      const savedUserData = await savedUser.json();
      userMsg.id = savedUserData.chatId;
      
      if (!activeClient.chats) activeClient.chats = [];
      activeClient.chats.push(userMsg);
      renderChatMessages(activeClient);
    } catch (err) {
      console.error("Error al registrar mensaje de usuario:", err);
    }
    
    userInput.value = "";
    document.getElementById("wa-btn-send").disabled = true;

    // Mostrar typing indicator
    const container = document.getElementById("whatsapp-messages-container");
    const typingDiv = document.createElement("div");
    typingDiv.className = "wa-message wa-message-agent text-italic text-muted";
    typingDiv.id = "wa-typing-indicator";
    typingDiv.innerHTML = `Escribiendo...`;
    container.appendChild(typingDiv);
    container.scrollTop = container.scrollHeight;

    // Obtener respuesta del agente
    let result;
    try {
      result = await getAgentResponse(
        activeClient.id,
        activeClient.agent,
        userText,
        null,
        "runtime",
        activeClient.chats.slice(-10)
      );
    } catch (error) {
      const typingElement = document.getElementById("wa-typing-indicator");
      if (typingElement) typingElement.remove();
      document.getElementById("wa-btn-send").disabled = false;
      alert(`El Playground no respondió: ${error.message}\n\nNo se generó una respuesta simulada. Corrige la versión o la configuración del runtime y vuelve a probar.`);
      return;
    }

    // Remover typing indicator
    const typingElement = document.getElementById("wa-typing-indicator");
    if (typingElement) typingElement.remove();

    // Guardar respuesta del agente en SQLite
    const agentMsg = { sender: "agent", text: result.reply, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    
    try {
      const savedAgent = await fetch(`/api/clients/${activeClient.id}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentMsg)
      });
      const savedAgentData = await savedAgent.json();
      agentMsg.id = savedAgentData.chatId;
      activeClient.chats.push(agentMsg);
      renderChatMessages(activeClient);
    } catch (err) {
      console.error("Error al registrar mensaje de agente:", err);
    }

    document.getElementById("wa-btn-send").disabled = false;

    // Actualizar panel de depuración
    const debugContext = document.getElementById("debug-retrieved-context");
    debugContext.innerHTML = "";

    if (result.retrievedContext && result.retrievedContext.length > 0) {
      result.retrievedContext.forEach(doc => {
        const item = document.createElement("div");
        item.style.marginBottom = "8px";
        item.style.borderLeft = "2px solid var(--color-emerald)";
        item.style.paddingLeft = "8px";
        item.innerHTML = `
          <div class="font-bold text-xs text-emerald">${escapeHTML(doc.subject || doc.title || "Dato confirmado")}</div>
          <div class="text-xs">${escapeHTML(String(doc.value || doc.content || "").substring(0, 150))}${String(doc.value || doc.content || "").length > 150 ? "…" : ""}</div>
        `;
        debugContext.appendChild(item);
      });
    } else {
      debugContext.innerHTML = `<span class="text-italic text-muted">No se recuperaron coincidencias relevantes de la base de conocimientos.</span>`;
    }

    document.getElementById("debug-latency").textContent = `${result.latency}ms`;
    document.getElementById("debug-model-used").textContent = result.modelUsed;
  });

  // Limpiar historial de chat
  document.getElementById("btn-clear-chat").addEventListener("click", async () => {
    const activeClient = state.clients.find(c => c.id === state.activeClientId);
    if (!activeClient) return;

    if (confirm("¿Estás seguro de que deseas vaciar el historial de mensajes de este chat simulado en SQLite?")) {
      try {
        await fetch(`/api/clients/${activeClient.id}/chats`, { method: 'DELETE' });
        activeClient.chats = [];
        renderChatMessages(activeClient);
      } catch (err) {
        alert("Error al limpiar historial: " + err.message);
      }
    }
  });

  // 8. Consumo IA: configuración y recarga de ciclo.
  document.getElementById('ai-budget-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const client = state.clients.find(c => c.id === state.activeClientId); if (!client) return;
    try {
      const res = await fetch(`/api/clients/${client.id}/ai-budget`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
        provider: document.getElementById('ai-provider').value, model: document.getElementById('ai-model').value,
        cycleBudgetClp: Number(document.getElementById('ai-budget-clp').value), usdClp: Number(document.getElementById('ai-usd-clp').value)
      }) });
      if (!res.ok) throw new Error((await res.json()).error); await loadAiBudget(client);
    } catch (error) { alert(`No se pudo guardar: ${error.message}`); }
  });
  document.getElementById('ai-recharge-btn').addEventListener('click', async () => {
    const client = state.clients.find(c => c.id === state.activeClientId); if (!client) return;
    const amount = Number(prompt('Monto de nueva recarga / presupuesto de ciclo (CLP):', '20000'));
    if (!amount) return;
    try {
      const res = await fetch(`/api/clients/${client.id}/ai-budget/recharge`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ amountClp: amount, notes: 'Recarga registrada desde ZeroAgent Studio' }) });
      if (!res.ok) throw new Error((await res.json()).error); await loadAiBudget(client);
    } catch (error) { alert(`No se pudo registrar la recarga: ${error.message}`); }
  });

  // 9. Configuración: Copias de seguridad (Exportar JSON)
  document.getElementById("btn-export-data").addEventListener("click", () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `zeroagent-sqlite-backup-${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  });

  // Configuración: Importar JSON
  document.getElementById("btn-import-data").addEventListener("change", (e) => {
    const fileReader = new FileReader();
    fileReader.onload = async function(event) {
      try {
        const imported = JSON.parse(event.target.result);
        if (imported.clients) {
          const res = await fetch('/api/settings/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clients: imported.clients })
          });

          if (!res.ok) throw new Error("Error del servidor al importar base de datos.");

          alert("Base de datos SQLite importada correctamente.");
          await fetchClients();
          syncGlobalUI();
        } else {
          alert("El archivo JSON no posee la estructura correcta de ZeroAgent.");
        }
      } catch (err) {
        alert("Error al importar: " + err.message);
      }
    };
    if (e.target.files[0]) {
      fileReader.readAsText(e.target.files[0]);
    }
  });

  // Configuración: Restablecer todo (Re-seed SQLite)
  document.getElementById("btn-reset-data").addEventListener("click", async () => {
    if (confirm("¡ATENCIÓN! Esto borrará todos tus agentes, documentos de entrenamiento y chats en SQLite, cargando la demo inicial. ¿Deseas continuar?")) {
      try {
        const res = await fetch('/api/settings/reset', { method: 'POST' });
        if (!res.ok) throw new Error("Error al restablecer la base de datos.");

        alert("La base de datos SQLite ha sido re-establecida.");
        await fetchClients();
        syncGlobalUI();
      } catch (err) {
        alert("Error: " + err.message);
      }
    }
  });
}

// ==========================================
// FUNCIONES AUXILIARES (APIS DE BORRADO)
// ==========================================

async function deleteClient(id) {
  try {
    const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error("Error al eliminar cliente de SQLite.");

    state.clients = state.clients.filter(c => c.id !== id);
    if (state.activeClientId === id) {
      state.activeClientId = state.clients.length > 0 ? state.clients[0].id : "";
      localStorage.setItem("za_active_client", state.activeClientId);
    }

    syncGlobalUI();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteDocument(clientId, docId) {
  try {
    const res = await fetch(`/api/clients/${clientId}/documents/${docId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error("Error al eliminar documento.");

    const client = state.clients.find(c => c.id === clientId);
    if (client) {
      client.documents = client.documents.filter(d => d.id !== docId);
    }
    syncViewContent("knowledge");
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteKnowledgeFact(clientId, factId) {
  try {
    const res = await fetch(`/api/clients/${clientId}/knowledge-items/${factId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("No se pudo eliminar el dato confirmado.");
    await fetchClients();
    syncGlobalUI();
    syncViewContent("knowledge");
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function submitChatFeedback(clientId, chatId, rating, correctionText = "") {
  if (rating === "down" && !correctionText) {
    alert("Cuéntame cómo debió responder para enviar la corrección a revisión.");
    return;
  }
  try {
    const res = await fetch(`/api/clients/${clientId}/chats/${chatId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating, correctionText })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || "No se pudo registrar la revisión.");
    }
    await fetchClients();
    syncGlobalUI();
    syncViewContent("simulator");
  } catch (err) {
    alert("Error al registrar revisión: " + err.message);
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer el archivo seleccionado."));
    reader.readAsDataURL(file);
  });
}

async function updateSourceStatus(clientId, sourceId, status) {
  try {
    const res = await fetch(`/api/clients/${clientId}/sources/${sourceId}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error("No se pudo actualizar el estado de la fuente.");
    await fetchClients();
    syncGlobalUI();
    syncViewContent("sources");
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteSource(clientId, sourceId) {
  try {
    const res = await fetch(`/api/clients/${clientId}/sources/${sourceId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("No se pudo eliminar la fuente.");
    await fetchClients();
    syncGlobalUI();
    syncViewContent("sources");
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function applyIntakeProposal(clientId, jobId, sourceTitle) {
  if (!confirm(`¿Aplicar la propuesta del IDE para "${sourceTitle}"? Esto creará datos confirmados y pruebas; luego podrás generar una nueva versión del agente.`)) return;
  try {
    const res = await fetch(`/api/intake-jobs/${jobId}/apply`, { method: "POST" });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || "No se pudo aplicar la propuesta.");
    }
    await fetchClients();
    syncGlobalUI();
    syncViewContent("sources");
  } catch (err) {
    alert("Error al aplicar propuesta: " + err.message);
  }
}

async function approveAgentVersion(clientId, versionId) {
  if (!confirm("¿Aprobar esta versión? Las versiones aprobadas serán las candidatas para instalar o actualizar un agente.")) return;
  try {
    const res = await fetch(`/api/clients/${clientId}/versions/${versionId}/approve`, { method: "PUT" });
    if (!res.ok) throw new Error("No se pudo aprobar la versión.");
    await fetchClients();
    syncGlobalUI();
    syncViewContent("project");
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function buildAgentRuntime(clientId, versionId, target) {
  const environmentLabels = { preview: "preview", staging: "staging", production: "producción" };
  if (!environmentLabels[target]) {
    alert("Selecciona un entorno de instalación válido.");
    return;
  }
  if (!confirm(`¿Construir esta versión para ${environmentLabels[target]}? Se ejecutará el preflight específico de ese entorno.`)) return;
  try {
    const res = await fetch(`/api/clients/${clientId}/versions/${versionId}/build-runtime`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || "No se pudo preparar la instalación.");
    }
    const result = await res.json();
    alert(`${result.message}\n\nEntorno: ${environmentLabels[result.target] || result.target}.\nIncluye: preview web privada (/) y webhook de WhatsApp.\n\nCarpeta local:\n${result.outputDir}`);
  } catch (err) {
    alert("Error al preparar instalación: " + err.message);
  }
}
