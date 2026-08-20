const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const initials = name => String(name || 'ZA').split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();

const state = {
  dashboard: null,
  control: { mode: 'active', paused_reason: '' },
  selectedDate: new Date(),
  playground: [],
  handoffs: [],
  inbox: { conversations: [] },
  knowledge: { facts: [], suggestions: [] },
  customers: [],
  customerFilter: 'todos',
  customerSelected: new Set(),
  customerSearch: '',
  aiAccount: null,
};

// ── Autenticación: mismo patrón que la consola de escritorio (clave por sesión). ──
async function api(url, options = {}) {
  const key = sessionStorage.getItem('zeroagent-dashboard-key') || '';
  const headers = { 'content-type': 'application/json', 'x-dashboard-key': key, ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.reload(); throw new Error('Sesión vencida, recargando…'); }
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la acción.');
  return data;
}

async function previewApi(url, body) {
  const key = sessionStorage.getItem('zeroagent-preview-key') || '';
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-preview-key': key }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const entered = prompt('Clave de preview:');
    if (entered) { sessionStorage.setItem('zeroagent-preview-key', entered); return previewApi(url, body); }
  }
  if (!response.ok) throw new Error(data.error || 'No se pudo probar el agente.');
  return data;
}

const tz = () => state.dashboard?.config?.timezone || 'America/Santiago';
const dateKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date(value));
const hourFmt = value => new Intl.DateTimeFormat('es-CL', { timeZone: tz(), hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const dayFmt = value => new Intl.DateTimeFormat('es-CL', { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(value));

const activeAppointments = () => (state.dashboard?.appointments || []).filter(item => !['cancelled', 'rejected'].includes(item.status));
const operationalAppointments = () => activeAppointments().filter(item => ['pending_confirmation', 'confirmed'].includes(item.status));
const appointmentIsExpired = (item, now = Date.now()) => item?.status === 'pending_confirmation'
  && (item.is_expired === true || new Date(item.starts_at).getTime() < now);
const appointmentStateLabel = item => appointmentIsExpired(item) ? 'Vencida' : statusLabel(item?.status);
function appointmentQueues(now = Date.now()) {
  const items = operationalAppointments();
  return {
    future: items.filter(item => new Date(item.starts_at).getTime() >= now && !appointmentIsExpired(item, now)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    overdue: items.filter(item => appointmentIsExpired(item, now)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  };
}
function openHumanCases() {
  const conversations = state.inbox?.conversations || [];
  if (conversations.length) return conversations.filter(item => item.needs_human || item.status === 'handoff').map(item => ({ kind: 'conversation', item }));
  return (state.handoffs || []).filter(item => item.status === 'open').map(item => ({ kind: 'ticket', item }));
}
function terminology() {
  const configured = state.dashboard?.config?.terminology || state.dashboard?.terminology || {};
  return {
    singular: configured.customer_singular || configured.customer || 'cliente',
    plural: configured.customer_plural || configured.customers || 'clientes',
    record: configured.record_label || configured.customer_record || 'Ficha de atención',
    intake: configured.intake_label || 'Datos de admisión',
  };
}
function applyTerminology() {
  const terms = terminology();
  const pluralTitle = terms.plural.charAt(0).toUpperCase() + terms.plural.slice(1);
  $('#customers-title').textContent = pluralTitle;
  $('#customers-copy').textContent = `Contactos y ${terms.intake.toLowerCase()} reunidos desde la conversación y la agenda.`;
  $('#clientes-search').placeholder = `Buscar ${terms.singular} por nombre o teléfono…`;
  const tabLabel = $('[data-screen="clientes"] span'); if (tabLabel) tabLabel.textContent = pluralTitle;
}
const confirmationMode = () => state.dashboard?.config?.confirmation_mode || 'manual';
function confirmationCopy(status) {
  if (status === 'confirmed') return 'La reserva quedó confirmada.';
  if (status === 'pending_confirmation') return 'La solicitud quedó pendiente de confirmación.';
  return 'La solicitud fue creada.';
}
let toastTimer;
function showToast(message) {
  const toast = $('#operation-toast'); if (!toast) return;
  clearTimeout(toastTimer); toast.textContent = message; toast.hidden = false; toast.classList.add('visible');
  toastTimer = setTimeout(() => { toast.classList.remove('visible'); toast.hidden = true; }, 4200);
}

// ── Navegación de pantallas ──
function showScreen(name) {
  $$('.screen').forEach(section => section.classList.toggle('active', section.id === `screen-${name}`));
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.screen === name));
  if (name === 'bandeja') loadBandeja().catch(error => { $('#bandeja-list').innerHTML = `<div class="empty">${esc(error.message)}</div>`; });
  if (name === 'entrenar') loadEntrenar().catch(error => { $('#facts-list').innerHTML = `<div class="empty">${esc(error.message)}</div>`; });
  if (name === 'clientes') loadClientes().catch(error => { $('#clientes-list').innerHTML = `<div class="empty">${esc(error.message)}</div>`; });
}
$$('.tab').forEach(tab => tab.addEventListener('click', () => showScreen(tab.dataset.screen)));

// ── Hoy ──
function renderHoy() {
  const today = dateKey(Date.now());
  const { future, overdue } = appointmentQueues();
  const todayItems = future.filter(item => dateKey(item.starts_at) === today);
  const pendingCount = future.filter(item => item.status === 'pending_confirmation').length;
  const humanCases = openHumanCases();

  $('#stat-today').textContent = todayItems.length;
  $('#stat-pending').textContent = pendingCount;
  $('#stat-overdue').textContent = overdue.length;
  $('#stat-attention').textContent = humanCases.length;
  $('#hoy-date').textContent = new Intl.DateTimeFormat('es-CL', { timeZone: tz(), weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const actions = [
    ...humanCases.map(entry => entry.kind === 'conversation' ? humanActionHtml(entry.item) : ticketActionHtml(entry.item)),
    ...overdue.map(overdueActionHtml),
  ];
  $('#hoy-actions').hidden = !actions.length;
  $('#hoy-action-list').innerHTML = actions.slice(0, 6).join('');
  $('#hoy-list').innerHTML = future.length ? groupedByDayHtml(future.slice(0, 8)) : '<div class="empty">No hay próximas atenciones.</div>';
}

function humanActionHtml(conversation) {
  return `<div class="action-card handoff" data-conversation="${esc(conversation.id)}">
    <span><strong>${esc(conversation.customer_name || conversation.customer_phone || 'Conversación')}</strong><small>${esc(conversation.handoff_reason || 'Necesita atención humana')}</small></span>
    <span class="status-pill open">Atender</span>
  </div>`;
}
function ticketActionHtml(ticket) {
  return `<button class="action-card handoff" data-show-bandeja>
    <span><strong>${esc(ticket.customer_name || 'Caso derivado')}</strong><small>${esc(ticket.reason || ticket.customer_message || 'Necesita atención humana')}</small></span>
    <span class="status-pill open">Atender</span>
  </button>`;
}
function overdueActionHtml(item) {
  return `<button class="action-card overdue" data-appointment="${esc(item.id)}">
    <span><strong>${esc(item.customer_name)} · ${esc(item.service)}</strong><small>${esc(dayFmt(item.starts_at))} · ${esc(hourFmt(item.starts_at))}</small></span>
    <span class="status-pill overdue">Vencida</span>
  </button>`;
}

function mobileSetAiAction(message = '', isError = false) { const node = $('#mobile-ai-action-status'); node.textContent = message; node.style.color = isError ? 'var(--danger)' : ''; }
async function loadAiAccount() { try { state.aiAccount = await api('/api/client/ai-account'); mobileSetAiAction(''); } catch (error) { state.aiAccount = { selection: { mode: 'environment' } }; } renderAiPlan(); return state.aiAccount; }
function renderAiPlan() {
  const summary = state.dashboard?.ai_plan || state.dashboard?.ai || state.dashboard?.config?.ai || {};
  const account = state.aiAccount || {}, selection = account.selection || {}, capabilities = state.dashboard?.capabilities?.ai || summary.capabilities || {};
  const model = selection.byokModel || summary.model || '', provider = selection.byokProvider || summary.provider || '';
  const configured = Boolean(selection.mode === 'byok' && selection.credentialConfigured);
  $('#mobile-ai-status').textContent = String(summary.status || (configured ? 'Configurado' : 'No configurado')).replaceAll('_', ' ');
  $('#mobile-ai-status').classList.toggle('confirmed', configured);
  $('#mobile-ai-name').textContent = summary.plan_name || summary.plan || model || 'Sin datos publicados';
  $('#mobile-ai-detail').textContent = [provider, model].filter(Boolean).join(' · ') || 'El runtime todavía no informa proveedor ni modelo.';

  const byokAllowed = capabilities.byok === true, providerSelect = $('#mobile-ai-byok-provider'), byokModel = $('#mobile-ai-byok-model'), base = $('#mobile-ai-byok-base'), key = $('#mobile-ai-byok-key');
  if (document.activeElement !== providerSelect && selection.byokProvider) providerSelect.value = selection.byokProvider;
  if (document.activeElement !== byokModel && !byokModel.value) byokModel.value = selection.byokModel || '';
  if (document.activeElement !== base && !base.value) base.value = selection.byokBaseUrl || '';
  $('#mobile-ai-byok-base-row').hidden = providerSelect.value !== 'compatible'; key.required = !selection.credentialConfigured;
  $('#mobile-ai-byok-key-state').textContent = selection.credentialConfigured ? 'Hay una clave cifrada guardada. Déjala en blanco para conservarla.' : 'La clave se enviará una vez al vault cifrado y este panel no podrá volver a leerla.';
  $('#mobile-ai-byok-form button[type="submit"]').disabled = !byokAllowed;
  $('#mobile-byok-copy').textContent = byokAllowed ? 'Conecta una cuenta propia. El consumo y cobro dependen de ese proveedor.' : 'BYOK requiere base de datos y cifrado del servidor; todavía no está disponible.';
}
async function loadGoogleCalendarStatus() { try { state.googleCalendar = await api('/api/client/google-calendar'); } catch (error) { state.googleCalendar = { connected: false }; } renderGoogleCalendar(); return state.googleCalendar; }
function renderGoogleCalendar() {
  const info = state.googleCalendar || {}, status = $('#mobile-google-status'), copy = $('#mobile-google-copy'), connectLink = $('#mobile-google-connect'), disconnectButton = $('#mobile-google-disconnect');
  if (!status) return;
  status.textContent = info.connected ? 'Conectado' : 'Pendiente';
  status.classList.toggle('ok', Boolean(info.connected));
  status.classList.toggle('pending', !info.connected);
  copy.textContent = info.connected ? `Conectado como ${info.accountEmail}.` : 'Conecta tu Google Calendar para verlo reflejado desde el negocio.';
  if (connectLink) connectLink.hidden = Boolean(info.connected);
  if (disconnectButton) disconnectButton.hidden = !info.connected;
}
function handleGoogleCalendarRedirectParams() {
  const params = new URLSearchParams(location.search);
  const result = params.get('google_calendar');
  if (!result) return;
  if (result === 'connected') showToast(`Google Calendar conectado (${params.get('google_account') || ''}).`);
  else showToast(params.get('google_calendar_message') || 'No se pudo conectar Google Calendar.');
  params.delete('google_calendar'); params.delete('google_account'); params.delete('google_calendar_message');
  const clean = params.toString();
  history.replaceState(null, '', location.pathname + (clean ? `?${clean}` : ''));
}
$('#mobile-google-disconnect')?.addEventListener('click', async () => {
  if (!confirm('¿Desconectar Google Calendar?')) return;
  try { await api('/api/client/google-calendar/disconnect', { method: 'POST' }); await loadGoogleCalendarStatus(); showToast('Google Calendar desconectado.'); }
  catch (error) { alert(error.message); }
});

// La lista de "próximas atenciones" muestra varios días, no sólo hoy (para que la
// pantalla no quede vacía apenas no hay nada agendado hoy mismo) — pero cada hora
// SIEMPRE va bajo un encabezado de día explícito, para que un turno de mañana a
// las 17:00 nunca se confunda con uno de hoy a la misma hora.
function dayGroupLabel(value) {
  const key = dateKey(value);
  if (key === dateKey(Date.now())) return 'Hoy';
  if (key === dateKey(Date.now() + 86400000)) return 'Mañana';
  return dayFmt(value);
}
function groupedByDayHtml(items) {
  let html = '';
  let lastKey = null;
  for (const item of items) {
    const key = dateKey(item.starts_at);
    if (key !== lastKey) { html += `<div class="day-group">${esc(dayGroupLabel(item.starts_at))}</div>`; lastKey = key; }
    html += rowHtml(item);
  }
  return html;
}

function rowHtml(item) {
  const expired = appointmentIsExpired(item);
  return `<button class="row-card" data-appointment="${esc(item.id)}">
    <span class="row-time">${hourFmt(item.starts_at)}</span>
    <span class="row-main"><strong>${esc(item.customer_name)}</strong><small>${esc(item.service)} · ${esc(item.resource)}</small></span>
    <span class="status-pill ${expired ? 'overdue' : esc(item.status)}">${esc(appointmentStateLabel(item))}</span>
  </button>`;
}

function statusLabel(status) {
  return { pending_confirmation: 'Por confirmar', confirmed: 'Confirmada', cancelled: 'Cancelada', completed: 'Completada', no_show: 'No asistió', rejected: 'Rechazada' }[status] || status;
}

// ── Agenda: tira de días + lista del día seleccionado ──
function renderDayStrip() {
  const today = new Date();
  const days = Array.from({ length: 14 }, (_, index) => new Date(today.getTime() + index * 86400000));
  const selectedKey = dateKey(state.selectedDate);
  $('#day-strip').innerHTML = days.map(day => {
    const key = dateKey(day);
    const isToday = key === dateKey(today);
    const isActive = key === selectedKey;
    return `<button class="day-pill${isActive ? ' active' : ''}${isToday ? ' today' : ''}" data-day="${key}">
      <span>${new Intl.DateTimeFormat('es-CL', { timeZone: tz(), weekday: 'short' }).format(day)}</span>
      <strong>${day.getDate()}</strong>
    </button>`;
  }).join('');
}

function renderAgendaList() {
  const key = dateKey(state.selectedDate);
  const items = activeAppointments().filter(item => dateKey(item.starts_at) === key).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  $('#agenda-list').innerHTML = items.length ? items.map(rowHtml).join('') : '<div class="empty">Sin reservas este día.</div>';
}

// ── Bloqueos: turnos en otro centro, traslado a domicilio, etc. — no son reservas ──
function blockHtml(block) {
  return `<div class="ticket-card">
    <div class="ticket-head"><span>${esc(dayFmt(block.starts_at))} · ${esc(hourFmt(block.starts_at))}–${esc(hourFmt(block.ends_at))}</span></div>
    <div class="ticket-msg"><strong>${esc(block.reason || 'Bloqueo')}</strong></div>
    <button data-delete-block="${esc(block.id)}">Quitar bloqueo</button>
  </div>`;
}
function renderBlocksList() {
  const upcoming = (state.dashboard?.blocks || []).filter(block => new Date(block.ends_at).getTime() >= Date.now())
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  $('#blocks-list').innerHTML = upcoming.length ? upcoming.map(blockHtml).join('') : '<div class="empty">Sin bloqueos próximos.</div>';
}

$('#day-strip').addEventListener('click', event => {
  const pill = event.target.closest('.day-pill');
  if (!pill) return;
  state.selectedDate = new Date(`${pill.dataset.day}T00:00:00`);
  renderDayStrip();
  renderAgendaList();
});

// ── Detalle de una reserva (bottom sheet) ──
function openDetail(id) {
  const item = (state.dashboard?.appointments || []).find(entry => entry.id === id);
  if (!item) return;
  const expired = appointmentIsExpired(item);
  const rows = [
    ['Cliente', item.customer_name], ['Teléfono', item.customer_phone],
    ['Servicio', item.service], ['Profesional', item.resource],
    ['Fecha', `${dayFmt(item.starts_at)} · ${hourFmt(item.starts_at)}`], ['Estado', appointmentStateLabel(item)],
    ['Referencia', item.reference], ['Nota', item.notes || '—'],
  ];
  const canConfirm = item.status === 'pending_confirmation' && !expired;
  const canCancel = !expired && ['pending_confirmation', 'confirmed'].includes(item.status);
  const canReschedule = canCancel;
  $('#detail-body').innerHTML = `
    <h2>${esc(item.customer_name)}</h2>
    ${expired ? '<div class="record-scope warning"><strong>Solicitud vencida</strong><p>Este horario ya pasó sin confirmación. Crea una nueva solicitud si la persona quiere reagendar.</p></div>' : ''}
    ${rows.map(([label, value]) => `<div class="detail-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}
    <div class="sheet-actions">
      ${canConfirm ? `<button class="primary" data-set-status="confirmed" data-id="${esc(item.id)}">Confirmar reserva</button>` : ''}
      ${canReschedule ? `<button class="ghost reschedule-toggle" data-toggle-reschedule="${esc(item.id)}">Reagendar</button>` : ''}
      ${canCancel ? `<button class="ghost" data-set-status="cancelled" data-id="${esc(item.id)}">Cancelar reserva</button>` : ''}
    </div>
    ${canReschedule ? `
    <div class="reschedule-box" id="reschedule-box" hidden>
      <label>Nueva fecha y hora<input type="datetime-local" id="reschedule-input"></label>
      <p class="sheet-error" id="reschedule-error"></p>
      <button class="primary full" data-confirm-reschedule="${esc(item.id)}">Guardar nuevo horario</button>
    </div>` : ''}`;
  $('#detail-sheet').showModal();
}

document.addEventListener('click', async event => {
  const row = event.target.closest('[data-appointment]');
  if (row) { openDetail(row.dataset.appointment); return; }
  const showBandeja = event.target.closest('[data-show-bandeja]');
  if (showBandeja) { showScreen('bandeja'); return; }
  const statusButton = event.target.closest('[data-set-status]');
  if (statusButton) {
    try {
      await api(`/api/agenda/appointments/${statusButton.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: statusButton.dataset.setStatus }) });
      $('#detail-sheet').close();
      await load();
    } catch (error) { alert(error.message); }
    return;
  }
  const closeSheet = event.target.closest('[data-close-sheet]');
  if (closeSheet) { $(`#${closeSheet.dataset.closeSheet}`).close(); return; }
  if (event.target.closest('#open-new-customer')) {
    $('#new-customer-form').reset();
    $('#new-customer-error').textContent = '';
    $('#new-customer-sheet').showModal();
    return;
  }
  const toggleReschedule = event.target.closest('[data-toggle-reschedule]');
  if (toggleReschedule) {
    const box = $('#reschedule-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#reschedule-input').focus();
    return;
  }
  const confirmReschedule = event.target.closest('[data-confirm-reschedule]');
  if (confirmReschedule) {
    const value = $('#reschedule-input').value;
    if (!value) { $('#reschedule-error').textContent = 'Elige una fecha y hora.'; return; }
    try {
      await api(`/api/agenda/appointments/${confirmReschedule.dataset.confirmReschedule}`, {
        method: 'PATCH', body: JSON.stringify({ new_starts_at: new Date(value).toISOString() })
      });
      $('#detail-sheet').close();
      await load();
    } catch (error) { $('#reschedule-error').textContent = error.message; }
    return;
  }
  const deleteBlock = event.target.closest('[data-delete-block]');
  if (deleteBlock) {
    try {
      await api(`/api/agenda/availability-blocks/${deleteBlock.dataset.deleteBlock}`, { method: 'DELETE' });
      await load();
    } catch (error) { alert(error.message); }
    return;
  }
  const resolveTicket = event.target.closest('[data-resolve-ticket]');
  if (resolveTicket) {
    try {
      await api(`/api/client/handoffs/${resolveTicket.dataset.resolveTicket}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
      await loadBandeja();
    } catch (error) { alert(error.message); }
    return;
  }
  const resolveCorrection = event.target.closest('[data-resolve-feedback]');
  if (resolveCorrection) {
    try {
      await api(`/api/agenda/feedback/${resolveCorrection.dataset.resolveFeedback}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
      await loadEntrenar();
    } catch (error) { alert(error.message); }
    return;
  }
  const customerRow = event.target.closest('[data-customer]');
  if (customerRow) { openCustomer(customerRow.dataset.customer).catch(error => alert(error.message)); return; }
  if (event.target.closest('#clientes-bulk-clear')) { state.customerSelected.clear(); renderClientesList(); return; }
  if (event.target.closest('#clientes-bulk-mute')) {
    const ids = [...state.customerSelected];
    if (!ids.length) return;
    try {
      await api('/api/client/customers', { method: 'PATCH', body: JSON.stringify({ ids, bot_muted: true }) });
      state.customerSelected.clear();
      await loadClientes();
    } catch (error) { alert(error.message); }
    return;
  }
  const segmentButton = event.target.closest('.segment-picker [data-segment]');
  if (segmentButton) {
    const customerId = segmentButton.closest('.segment-picker').dataset.customerId;
    try {
      await api(`/api/client/customers/${encodeURIComponent(customerId)}`, { method: 'PATCH', body: JSON.stringify({ segment: segmentButton.dataset.segment }) });
      $$('.segment-picker button').forEach(button => button.classList.toggle('active', button === segmentButton));
      await loadClientes();
    } catch (error) { alert(error.message); }
    return;
  }
  const muteButton = event.target.closest('[data-mute-customer]');
  if (muteButton) {
    const customerId = muteButton.dataset.muteCustomer, nextMuted = muteButton.dataset.muted === '1';
    try {
      await api(`/api/client/customers/${encodeURIComponent(customerId)}`, { method: 'PATCH', body: JSON.stringify({ bot_muted: nextMuted }) });
      await loadClientes();
      await openCustomer(customerId);
    } catch (error) { alert(error.message); }
    return;
  }
  const saveNote = event.target.closest('[data-save-note]');
  if (saveNote) {
    const textarea = saveNote.closest('.visit-card').querySelector('.visit-notes');
    try {
      await api(`/api/agenda/appointments/${saveNote.dataset.saveNote}`, { method: 'PATCH', body: JSON.stringify({ notes: textarea.value }) });
      saveNote.textContent = 'Guardado ✓';
      setTimeout(() => { saveNote.textContent = 'Guardar nota'; }, 1500);
    } catch (error) { alert(error.message); }
    return;
  }
  const rateMsg = event.target.closest('[data-rate-msg]');
  if (rateMsg) {
    const rating = rateMsg.dataset.rateMsg, conversationId = rateMsg.dataset.conversation, messageId = rateMsg.dataset.message;
    const conv = (state.inbox?.conversations || []).find(item => item.id === conversationId);
    const message = conv?.messages?.find(item => item.id === messageId);
    if (!message) return;
    const question = [...(conv.messages || [])].filter(item => item.direction === 'inbound' && item.created_at < message.created_at).slice(-1)[0]?.content || '';
    let expectedAnswer = '';
    if (rating === 'down') {
      expectedAnswer = prompt('¿Cómo debería haber respondido el agente?') || '';
      if (!expectedAnswer.trim()) return;
    }
    try {
      await api('/api/client/feedback', { method: 'POST', body: JSON.stringify({ rating, expectedAnswer, conversationId, messageId, question, reply: message?.content || '', channel: conv?.channel || 'whatsapp' }) });
      rateMsg.closest('.conv-rate').innerHTML = rating === 'up' ? 'Marcada como correcta ✓' : 'Corrección enviada ✓';
    } catch (error) { alert(error.message); }
    return;
  }
  const takeConversation = event.target.closest('[data-take-conversation]');
  if (takeConversation) {
    try {
      await api(`/api/client/conversations/${takeConversation.dataset.takeConversation}`, { method: 'PATCH', body: JSON.stringify({ status: 'handoff', needs_human: true, handoff_reason: 'Tomada desde la aplicación' }) });
      await loadBandeja();
      openConversation(takeConversation.dataset.takeConversation);
    } catch (error) { alert(error.message); }
    return;
  }
  const returnConversation = event.target.closest('[data-return-conversation]');
  if (returnConversation) {
    try {
      await api(`/api/client/conversations/${returnConversation.dataset.returnConversation}`, { method: 'PATCH', body: JSON.stringify({ status: 'active', needs_human: false, handoff_reason: '' }) });
      $('#conversation-sheet').close();
      await loadBandeja();
    } catch (error) { alert(error.message); }
    return;
  }
  const conversationRow = event.target.closest('[data-conversation]');
  if (conversationRow && conversationRow.tagName !== 'BUTTON') { openConversation(conversationRow.dataset.conversation); return; }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'conversation-composer') return;
  event.preventDefault();
  const conversationId = event.target.dataset.conversation;
  const text = $('#conversation-reply').value.trim();
  if (!text) return;
  try {
    await api(`/api/client/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text, operatorName: 'Equipo' }) });
    $('#conversation-composer-error').textContent = '';
    await loadBandeja();
    openConversation(conversationId);
  } catch (error) { $('#conversation-composer-error').textContent = error.message; }
});

// Tocar el fondo oscuro (fuera de la hoja) también cierra sin acción — un
// <dialog> nativo no hace esto solo. El click sobre el backdrop cae en el
// propio <dialog>, nunca en su contenido, así que basta comparar el target.
$$('.sheet').forEach(sheet => sheet.addEventListener('click', event => { if (event.target === sheet) sheet.close(); }));

function fillSelect(selectId, items) {
  const select = $(selectId); select.replaceChildren();
  for (const item of items) { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; select.append(option); }
}
const serviceIsBookable = service => service?.active !== false && service?.bookable !== false;
function resourceSupportsService(resource, serviceName) {
  return !Array.isArray(resource?.services) || !resource.services.length || resource.services.some(name => String(name).localeCompare(String(serviceName), undefined, { sensitivity: 'base' }) === 0);
}
function locationsForService(service, locations) {
  const allowed = service?.locations || service?.location_names;
  if (!Array.isArray(allowed) || !allowed.length) return locations;
  return locations.filter(location => allowed.some(value => String(value?.name || value).localeCompare(String(location.name), undefined, { sensitivity: 'base' }) === 0));
}
function refreshMobileBookingOptions() {
  const catalog = state.dashboard?.catalog || { services: [], resources: [], locations: [] };
  const services = (catalog.services || []).filter(serviceIsBookable);
  const service = services.find(item => item.name === $('#booking-service').value) || services[0];
  const resources = (catalog.resources || []).filter(item => resourceSupportsService(item, service?.name));
  fillResourceField('#booking-resource-label', '#booking-resource', resources);
  fillSelect('#booking-location', locationsForService(service, catalog.locations || []));
}
// Con un solo profesional no tiene sentido mostrar un dropdown de una sola opción —
// se deja seleccionado igual (el submit sigue leyendo su .value) pero oculto.
function fillResourceField(labelId, selectId, resources) {
  const label = $(labelId);
  if (resources.length === 1) {
    label.innerHTML = `Profesional<strong class="booking-resource-fixed">${esc(resources[0].name)}</strong>`;
    const hiddenSelect = document.createElement('select'); hiddenSelect.id = selectId.slice(1); hiddenSelect.hidden = true;
    const option = document.createElement('option'); option.value = resources[0].name; option.selected = true;
    hiddenSelect.append(option); label.append(hiddenSelect);
    return;
  }
  label.innerHTML = `Profesional<select id="${selectId.slice(1)}" required></select>`;
  fillSelect(selectId, resources);
}

// ── Nueva reserva ──
$('#new-booking').addEventListener('click', () => {
  const catalog = state.dashboard?.catalog || { services: [], resources: [], locations: [] };
  const services = (catalog.services || []).filter(serviceIsBookable);
  fillSelect('#booking-service', services);
  refreshMobileBookingOptions();
  $('#booking-form').reset();
  $('#booking-error').textContent = '';
  const manual = confirmationMode() !== 'automatic';
  $('#booking-sheet h2').textContent = manual ? 'Nueva solicitud' : 'Nueva reserva';
  $('#booking-mode-note').textContent = manual ? 'La hora quedará por confirmar hasta que el equipo la acepte.' : 'La hora quedará confirmada si sigue disponible al guardar.';
  $('#booking-submit').textContent = manual ? 'Crear solicitud' : 'Confirmar reserva';
  $('#booking-submit').disabled = !services.length;
  $('#booking-sheet').showModal();
});
$('#booking-service').addEventListener('change', refreshMobileBookingOptions);

$('#booking-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#booking-submit'); submit.disabled = true; $('#booking-error').textContent = '';
  try {
    const response = await api('/api/agenda/appointments', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: $('#booking-name').value, customer_phone: $('#booking-phone').value,
        customer_email: $('#booking-email').value, location: $('#booking-location').value,
        service: $('#booking-service').value, resource: $('#booking-resource').value,
        starts_at: $('#booking-starts').value, notes: $('#booking-notes').value,
      }),
    });
    $('#booking-sheet').close();
    await load();
    showToast(confirmationCopy(response.appointment?.status));
  } catch (error) { $('#booking-error').textContent = error.message; }
  finally { submit.disabled = false; }
});

// ── Bloquear horario ──
$('#new-block').addEventListener('click', () => {
  const catalog = state.dashboard?.catalog || { resources: [] };
  fillResourceField('#block-resource-label', '#block-resource', catalog.resources);
  $('#block-form').reset();
  $('#block-error').textContent = '';
  $('#block-sheet').showModal();
});

$('#block-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/agenda/availability-blocks', {
      method: 'POST',
      body: JSON.stringify({ resource: $('#block-resource').value, reason: $('#block-reason').value, starts_at: $('#block-starts').value, ends_at: $('#block-ends').value }),
    });
    $('#block-sheet').close();
    await load();
  } catch (error) { $('#block-error').textContent = error.message; }
});

// ── Agente: pausar / activar ──
function renderAgentToggle() {
  const paused = state.control.mode === 'paused';
  $('#agent-toggle').classList.toggle('paused', paused);
  $('#agent-toggle-label').textContent = paused ? 'Pausado' : 'Activo';
  $('#agent-state-label').textContent = paused ? 'Respondiendo pausado' : 'Atendiendo automático';
}
$('#agent-toggle').addEventListener('click', async () => {
  const nextMode = state.control.mode === 'paused' ? 'active' : 'paused';
  try { const result = await api('/api/client/agent-control', { method: 'PUT', body: JSON.stringify({ mode: nextMode }) }); state.control = result.control || result; renderAgentToggle(); }
  catch (error) { alert(error.message); }
});

// ── Probar: chat contra el motor real ──
// El agente necesita ver los turnos anteriores para poder indagar (preguntar
// algo y usar la respuesta), no sólo contestar cada mensaje sin memoria.
const chatHistory = [];
function addBubble(text, who) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${who}`;
  const paragraph = document.createElement('p'); paragraph.textContent = text; bubble.append(paragraph);
  $('#chat-log').append(bubble);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  return bubble;
}
$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message) return;
  addBubble(message, 'user');
  input.value = '';
  try {
    const data = await previewApi('/api/preview/chat', { message, conversationId: 'mobile-demo', history: chatHistory.slice(-20) });
    chatHistory.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply.text });
    const bubble = addBubble(data.reply.text, 'agent');
    const actions = document.createElement('div'); actions.className = 'feedback';
    actions.innerHTML = '<button data-rate="up">👍 Correcta</button><button data-rate="down">👎 Corregir</button>';
    actions.querySelector('[data-rate="up"]').onclick = () => previewApi('/api/preview/feedback', { rating: 'up', question: message, reply: data.reply.text }).then(() => actions.remove()).catch(error => alert(error.message));
    actions.querySelector('[data-rate="down"]').onclick = () => {
      const expected = prompt('¿Cómo debió responder?');
      if (expected) previewApi('/api/preview/feedback', { rating: 'down', question: message, reply: data.reply.text, expectedAnswer: expected })
        .then(() => { actions.innerHTML = `<span class="text-muted">Corrección guardada.</span> <a href="${supportWaLink('Corrección enviada')}" target="_blank" rel="noopener">Avisar por WhatsApp →</a>`; })
        .catch(error => alert(error.message));
    };
    bubble.append(actions);
  } catch (error) { addBubble(`Error: ${error.message}`, 'agent'); }
});

// ── Bandeja: casos que el agente derivó a una persona ──
function ticketHtml(ticket) {
  const when = new Intl.DateTimeFormat('es-CL', { timeZone: tz(), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ticket.created_at));
  return `<div class="ticket-card ${esc(ticket.status)}">
    <div class="ticket-head"><span class="status-pill ${esc(ticket.status)}">${ticket.status === 'open' ? 'Sin resolver' : 'Resuelto'}</span><time>${when}</time></div>
    <div class="ticket-msg"><strong>Escribió</strong>${esc(ticket.customer_message)}</div>
    <div class="ticket-msg"><strong>Respondió el agente</strong>${esc(ticket.agent_reply)}</div>
    <div class="ticket-reason">${esc(ticket.reason)}</div>
    ${ticket.status === 'open' ? `<button data-resolve-ticket="${esc(ticket.id)}">Marcar resuelto</button>` : ''}
  </div>`;
}
// Con Zavu/WhatsApp conectado, las conversaciones reales viven en Supabase y esto reemplaza
// el fallback de tickets locales — mismo patrón que ya existía en la consola de escritorio,
// llevado a móvil (antes acá solo se veían los tickets, nunca el hilo completo).
function conversationRowHtml(conv) {
  const when = new Intl.DateTimeFormat('es-CL', { timeZone: tz(), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(conv.updated_at));
  const last = [...(conv.messages || [])].slice(-1)[0]?.content || '';
  const requiresPerson = conv.needs_human || conv.status === 'handoff';
  return `<div class="ticket-card ${requiresPerson ? 'open' : 'resolved'}" data-conversation="${esc(conv.id)}">
    <div class="ticket-head"><span class="status-pill ${requiresPerson ? 'open' : 'resolved'}">${requiresPerson ? 'Necesita persona' : 'IA atendiendo'}</span><time>${when}</time></div>
    <div class="ticket-msg"><strong>${esc(conv.customer_name || conv.customer_phone || 'Contacto')}${conv.customer_bot_muted ? ' 🔇' : ''}</strong>${esc(last)}</div>
    ${conv.handoff_reason ? `<div class="ticket-reason">${esc(conv.handoff_reason)}</div>` : ''}
  </div>`;
}
function conversationMessageHtml(conv, message) {
  const when = new Intl.DateTimeFormat('es-CL', { timeZone: tz(), hour: '2-digit', minute: '2-digit' }).format(new Date(message.created_at));
  const who = message.direction === 'inbound' ? 'Cliente' : message.sender_type === 'human' ? 'Equipo' : 'Agente';
  const canRate = message.direction === 'outbound' && message.sender_type !== 'human';
  return `<div class="conv-message ${esc(message.direction)}">
    <small>${who} · ${when}</small>
    <p>${esc(message.content)}</p>
    ${canRate ? `<div class="conv-rate"><button data-rate-msg="up" data-conversation="${esc(conv.id)}" data-message="${esc(message.id)}">👍 Correcta</button><button data-rate-msg="down" data-conversation="${esc(conv.id)}" data-message="${esc(message.id)}">👎 Corregir</button></div>` : ''}
  </div>`;
}
function openConversation(id) {
  const conv = (state.inbox?.conversations || []).find(item => item.id === id);
  if (!conv) return;
  state.activeConversationId = id;
  const wa = String(conv.customer_phone || '').replace(/\D/g, '');
  const requiresPerson = conv.needs_human || conv.status === 'handoff';
  $('#conversation-body').innerHTML = `
    <h2>${esc(conv.customer_name || 'Conversación')}</h2>
    <p class="screen-sub">${esc(conv.customer_phone || '')} · WhatsApp${wa ? ` · <a href="https://wa.me/${wa}" target="_blank" rel="noopener">Ficha ↗</a>` : ''}</p>
    ${conv.customer_bot_muted ? '<div class="ticket-reason">🔇 Este contacto está silenciado: el bot no le responde (configurado desde su ficha).</div>' : ''}
    ${conv.handoff_reason ? `<div class="ticket-reason">${esc(conv.handoff_reason)}</div>` : ''}
    <div class="conv-stream">${(conv.messages || []).map(message => conversationMessageHtml(conv, message)).join('')}</div>
    ${requiresPerson
      ? `<form class="knowledge-form" id="conversation-composer" data-conversation="${esc(conv.id)}">
           <label>Responder como equipo<textarea id="conversation-reply" rows="2" required placeholder="Escribe tu respuesta…"></textarea></label>
           <p class="sheet-error" id="conversation-composer-error"></p>
           <button type="submit" class="primary full">Enviar por WhatsApp</button>
         </form>
         <button class="ghost" data-return-conversation="${esc(conv.id)}">Devolver a la IA</button>`
      : `<button class="ghost" data-take-conversation="${esc(conv.id)}">Tomar conversación</button>`}
  `;
  $('#conversation-sheet').showModal();
}
async function loadBandeja() {
  const [ticketsRes, inboxRes] = await Promise.all([
    api('/api/client/handoffs'),
    api('/api/client/inbox').catch(() => ({ conversations: [] }))
  ]);
  state.handoffs = ticketsRes.tickets || [];
  state.inbox = inboxRes;
  const conversations = inboxRes.conversations || [];
  if (conversations.length) {
    const requiresPerson = item => item.needs_human || item.status === 'handoff';
    const needsHuman = conversations.filter(requiresPerson);
    const badge = $('#bandeja-badge');
    badge.hidden = !needsHuman.length;
    badge.textContent = needsHuman.length;
    const ordered = [...needsHuman, ...conversations.filter(item => !requiresPerson(item))];
    $('#bandeja-list').innerHTML = ordered.map(conversationRowHtml).join('');
    renderHoy();
    return;
  }
  const open = state.handoffs.filter(ticket => ticket.status === 'open');
  const badge = $('#bandeja-badge');
  badge.hidden = !open.length;
  badge.textContent = open.length;
  const ordered = [...open, ...state.handoffs.filter(ticket => ticket.status !== 'open')];
  $('#bandeja-list').innerHTML = ordered.length ? ordered.map(ticketHtml).join('') : '<div class="empty">Sin casos derivados por ahora.</div>';
  renderHoy();
}

// ── Entrenar: lo que el agente sabe + correcciones pendientes ──
function factHtml(fact) {
  return `<div class="fact-card"><strong>${esc(fact.category)} · ${esc(fact.subject)}</strong><p>${esc(fact.value)}</p></div>`;
}
function suggestionHtml(item) {
  return `<div class="fact-card"><strong>${esc(item.category)} · ${esc(item.subject)}</strong><p>${esc(item.value)}</p><span class="note-inline">Esperando revisión del equipo</span></div>`;
}
function correctionHtml(item) {
  return `<div class="correction-card">
    <p class="q">"${esc(item.question)}"</p>
    <p>${esc(item.reply)}</p>
    <p class="fix">Debió decir: ${esc(item.correction_text)}</p>
    <button data-resolve-feedback="${esc(item.id)}">Marcar resuelto</button>
  </div>`;
}
function businessDataHtml(item) {
  return `<div class="fact-card"><p class="fact-subject">${esc(item.label)}</p><p>${esc(item.value)}</p></div>`;
}
function businessInfoHtml(item) {
  return `<div class="fact-card"><p>${esc(item.text)}</p></div>`;
}
async function loadEntrenar() {
  const [knowledge, dashboard, businessData, businessInfo] = await Promise.all([
    api('/api/client/knowledge'), api('/api/agenda/dashboard'),
    api('/api/client/business-data').catch(() => ({ items: [] })),
    api('/api/client/business-info').catch(() => ({ items: [] }))
  ]);
  state.knowledge = knowledge;
  state.dashboard = dashboard;
  state.businessData = businessData.items || [];
  state.businessInfo = businessInfo.items || [];
  const pending = (dashboard.feedback || []).filter(item => item.rating === 'down' && item.status !== 'resolved');
  $('#correcciones-list').innerHTML = pending.length ? pending.map(correctionHtml).join('') : '<div class="empty">Sin correcciones pendientes.</div>';
  $('#facts-list').innerHTML = knowledge.facts.length ? knowledge.facts.map(factHtml).join('') : '<div class="empty">Todavía no hay datos confirmados.</div>';
  const pendingSuggestions = (knowledge.suggestions || []).filter(item => item.status === 'pending');
  $('#suggestions-list').innerHTML = pendingSuggestions.length ? pendingSuggestions.map(suggestionHtml).join('') : '';
  $('#suggestions-note').textContent = pendingSuggestions.length
    ? `${pendingSuggestions.length} sugerencia(s) esperando revisión del equipo.`
    : '';
  $('#business-data-list').innerHTML = state.businessData.length ? state.businessData.map(businessDataHtml).join('') : '<div class="empty">Sin datos cargados todavía.</div>';
  $('#business-info-list').innerHTML = state.businessInfo.length ? state.businessInfo.map(businessInfoHtml).join('') : '<div class="empty">Sin info cargada todavía.</div>';
}
$('#suggestion-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/client/knowledge/suggestions', {
      method: 'POST',
      body: JSON.stringify({ category: $('#sugg-category').value, subject: $('#sugg-subject').value, value: $('#sugg-value').value })
    });
    $('#suggestion-form').reset();
    $('#suggestion-error').textContent = '';
    await loadEntrenar();
    $('#suggestions-note').innerHTML = `Sugerencia enviada. Alguien del equipo la revisará antes de que quede activa. <a href="${supportWaLink('Sugerencia de conocimiento enviada')}" target="_blank" rel="noopener">Avisar por WhatsApp →</a>`;
  } catch (error) { $('#suggestion-error').textContent = error.message; }
});
$('#new-customer-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const { customer } = await api('/api/client/customers', {
      method: 'POST',
      body: JSON.stringify({ full_name: $('#new-customer-name').value, phone: $('#new-customer-phone').value })
    });
    $('#new-customer-sheet').close();
    await loadClientes();
    await openCustomer(customer.id);
  } catch (error) { $('#new-customer-error').textContent = error.message; }
});
$('#business-data-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/client/business-data', {
      method: 'POST',
      body: JSON.stringify({ label: $('#business-data-label').value, value: $('#business-data-value').value, category: $('#business-data-category').value })
    });
    $('#business-data-form').reset();
    $('#business-data-error').textContent = '';
    await loadEntrenar();
  } catch (error) { $('#business-data-error').textContent = error.message; }
});
$('#business-info-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/client/business-info', { method: 'POST', body: JSON.stringify({ text: $('#business-info-text').value }) });
    $('#business-info-form').reset();
    $('#business-info-error').textContent = '';
    await loadEntrenar();
  } catch (error) { $('#business-info-error').textContent = error.message; }
});
$('#mobile-ai-byok-provider')?.addEventListener('change', event => { $('#mobile-ai-byok-base-row').hidden = event.target.value !== 'compatible'; });
$('#mobile-ai-byok-form')?.addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button[type="submit"]'), keyInput = $('#mobile-ai-byok-key');
  const payload = { mode: 'byok', provider: $('#mobile-ai-byok-provider').value, model: $('#mobile-ai-byok-model').value.trim(), baseUrl: $('#mobile-ai-byok-base').value.trim(), apiKey: keyInput.value };
  button.disabled = true; mobileSetAiAction('Validando y cifrando la clave en el servidor…');
  try { state.aiAccount = await api('/api/client/ai-account', { method: 'PUT', body: JSON.stringify(payload) }); renderAiPlan(); mobileSetAiAction('Clave propia activada.'); showToast('IA del negocio actualizada.'); }
  catch (error) { mobileSetAiAction(error.message, true); } finally { keyInput.value = ''; payload.apiKey = ''; button.disabled = false; }
});

// ── Clientes: CRM ligero de control interno ──
const segmentLabel = segment => ({ frio: 'Frío', caliente: 'Caliente', cliente: 'Cliente', revisar: 'Revisar' }[segment] || segment);
function clienteRowHtml(customer) {
  const last = customer.last_visit ? dayFmt(customer.last_visit) : 'sin visitas';
  return `<div class="row-with-check">
    <label class="row-check"><input type="checkbox" ${state.customerSelected.has(customer.id) ? 'checked' : ''} onclick="toggleCustomerSelect('${esc(customer.id)}',this.checked)"></label>
    <button class="row-card" data-customer="${esc(customer.id)}">
      <span class="row-main"><strong>${esc(customer.full_name || 'Sin nombre')}${customer.bot_muted ? ' 🔇' : ''}</strong><small>${esc(customer.phone)} · última visita: ${esc(last)}</small></span>
      <span class="segment-badge ${esc(customer.segment)}">${esc(segmentLabel(customer.segment))}</span>
    </button>
  </div>`;
}
function renderClientesList() {
  const term = state.customerSearch.trim().toLowerCase();
  const filtered = state.customers.filter(customer => {
    if (state.customerFilter !== 'todos' && customer.segment !== state.customerFilter) return false;
    if (!term) return true;
    return (customer.full_name || '').toLowerCase().includes(term) || (customer.phone || '').includes(term);
  });
  const visibleIds = new Set(filtered.map(c => c.id));
  for (const id of [...state.customerSelected]) if (!visibleIds.has(id)) state.customerSelected.delete(id);
  $('#clientes-list').innerHTML = filtered.length ? filtered.map(clienteRowHtml).join('') : '<div class="empty">Sin contactos que coincidan.</div>';
  const bar = $('#clientes-bulk-bar');
  if (bar) {
    bar.hidden = state.customerSelected.size === 0;
    const count = $('#clientes-bulk-count');
    if (count) count.textContent = `${state.customerSelected.size} seleccionado${state.customerSelected.size === 1 ? '' : 's'}`;
  }
}
function toggleCustomerSelect(id, checked) {
  if (checked) state.customerSelected.add(id); else state.customerSelected.delete(id);
  renderClientesList();
}
async function loadClientes() {
  const data = await api('/api/client/customers');
  state.customers = data.customers || [];
  renderClientesList();
}
$('#entrenar-subtabs').addEventListener('click', event => {
  const pill = event.target.closest('[data-entrenar-tab]');
  if (!pill) return;
  $$('#entrenar-subtabs .segment-pill').forEach(button => button.classList.toggle('active', button === pill));
  $$('.entrenar-panel').forEach(panel => { panel.hidden = panel.dataset.entrenarPanel !== pill.dataset.entrenarTab; });
});
$('#clientes-search').addEventListener('input', event => { state.customerSearch = event.target.value; renderClientesList(); });
$('#segment-pills').addEventListener('click', event => {
  const pill = event.target.closest('[data-segment-filter]');
  if (!pill) return;
  state.customerFilter = pill.dataset.segmentFilter;
  $$('#segment-pills .segment-pill').forEach(button => button.classList.toggle('active', button === pill));
  renderClientesList();
});

function waLink(phone) { return `https://wa.me/${String(phone || '').replace(/\D/g, '')}`; }
// Aviso opcional del dueño hacia soporte: mensaje persona-a-persona común (sin API de Meta,
// sin plantilla aprobada, sin costo de conversación) — el dueño toca el link si quiere avisar
// más rápido; si no lo toca, igual queda visible en Studio la próxima vez que se revise.
const SUPPORT_WHATSAPP_NUMBER = '56972739105';
function supportWaLink(message) {
  const businessName = state.dashboard?.business_name || $('#business-name')?.textContent?.trim() || 'el proyecto';
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(`${message} en ${businessName}.`)}`;
}
function visitCardHtml(appointment) {
  const expired = appointmentIsExpired(appointment);
  return `<div class="visit-card" data-appointment-id="${esc(appointment.id)}">
    <div class="visit-head"><span>${esc(dayFmt(appointment.starts_at))} · ${esc(appointment.service || '')}</span><span class="status-pill ${expired ? 'overdue' : esc(appointment.status)}">${esc(appointmentStateLabel(appointment))}</span></div>
    <textarea class="visit-notes" rows="2" placeholder="Motivo o seguimiento interno…">${esc(appointment.notes || '')}</textarea>
    <button class="save-note" data-save-note="${esc(appointment.id)}">Guardar nota</button>
  </div>`;
}
async function openCustomer(id) {
  const detail = await api(`/api/client/customers/${encodeURIComponent(id)}`);
  const { customer, appointments } = detail;
  const segments = ['frio', 'caliente', 'cliente'];
  const terms = terminology();
  $('#customer-body').innerHTML = `
    <div class="section-label">${esc(terms.record)}</div>
    <h2>${esc(customer.full_name || 'Sin nombre')}</h2>
    <div class="record-scope"><strong>${esc(terms.intake)}</strong><p>Información entregada por esta persona durante la conversación o la reserva. No sustituye los registros profesionales externos que el negocio deba mantener.</p></div>
    <div class="detail-row"><span>Teléfono</span><strong>${esc(customer.phone)}</strong></div>
    ${customer.email ? `<div class="detail-row"><span>Correo</span><strong>${esc(customer.email)}</strong></div>` : ''}
    ${customer.rut ? `<div class="detail-row"><span>RUT</span><strong>${esc(customer.rut)}</strong></div>` : ''}
    ${customer.age ? `<div class="detail-row"><span>Edad</span><strong>${esc(customer.age)}</strong></div>` : ''}
    ${customer.occupation ? `<div class="detail-row"><span>Ocupación</span><strong>${esc(customer.occupation)}</strong></div>` : ''}
    ${customer.medical_history ? `<div class="detail-row"><span>Antecedentes informados</span><strong>${esc(customer.medical_history)}</strong></div>` : ''}
    ${customer.extra_symptoms ? `<div class="detail-row"><span>Información adicional</span><strong>${esc(customer.extra_symptoms)}</strong></div>` : ''}
    <div class="segment-picker" data-customer-id="${esc(customer.id)}">
      ${segments.map(segment => `<button data-segment="${segment}" class="${segment === customer.segment ? 'active' : ''}">${esc(segmentLabel(segment))}</button>`).join('')}
    </div>
    <button type="button" class="mute-toggle ${customer.bot_muted ? 'active' : ''}" data-mute-customer="${esc(customer.id)}" data-muted="${customer.bot_muted ? '0' : '1'}">${customer.bot_muted ? '🔇 El bot no le responde · reactivar' : '🔈 El bot le responde · no contestar'}</button>
    <div class="contact-actions">
      <a href="${waLink(customer.phone)}" target="_blank" rel="noopener">WhatsApp →</a>
      ${customer.email ? `<a href="mailto:${esc(customer.email)}">Enviar correo →</a>` : ''}
    </div>
    <div class="section-label">Historial operativo</div>
    ${appointments.length ? appointments.map(visitCardHtml).join('') : '<div class="empty">Sin atenciones registradas.</div>'}
  `;
  $('#customer-sheet').showModal();
}

// ── Carga inicial ──
async function load() {
  const [dashboard, control, health] = await Promise.all([
    api('/api/agenda/dashboard'), api('/api/client/agent-control'), fetch('/health').then(response => response.json()),
  ]);
  state.dashboard = dashboard;
  state.control = control.control || control;
  $('#business-name').textContent = dashboard.business_name || health.agent || 'Negocio';
  $('#brand-mark').textContent = initials(dashboard.business_name || health.agent);
  $('#hoy-greeting').textContent = `Hola${dashboard.business_name ? ', ' + dashboard.business_name : ''}`;
  $('#chat-welcome').textContent = `Hola, soy ${health.agent || 'el asistente'}. ¿En qué te ayudo?`;
  renderAgentToggle();
  applyTerminology();
  renderAiPlan();
  renderHoy();
  renderDayStrip();
  renderAgendaList();
  renderBlocksList();
  loadBandeja().catch(() => {});
  loadAiAccount().catch(() => {});
  loadGoogleCalendarStatus().catch(() => {});
  handleGoogleCalendarRedirectParams();
}

function startLoad() {
  load().catch(error => {
    $('#hoy-list').innerHTML = `<div class="empty">No se pudo cargar la agenda: ${esc(error.message)}</div>`;
  });
}
// Espera a que auth-gate.js confirme sesión de operador antes de pedir datos — si no, esta
// llamada corre en paralelo a la pantalla de PIN y compite con ella por 401.
if (window.zaAuthenticated) startLoad();
else document.addEventListener('za-authenticated', startLoad, { once: true });
