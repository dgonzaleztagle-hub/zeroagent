const prospectingState = { verticals: [], prospects: [], stats: {}, selectedId: null, view: 'today', configured: false };
const $p = selector => document.querySelector(selector);
const escp = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
const safeHref = value => { const url = String(value ?? '').trim(); return /^https?:\/\//i.test(url) ? escp(url) : ''; };

// WhatsApp sólo cuando es realmente alcanzable: número scrapeado del sitio, o un móvil chileno
// (9 + 8 dígitos). Un fijo no sirve para wa.me, así que devuelve vacío y no se ofrece el botón.
function waNumberFor(item) {
  if (item.whatsapp) return String(item.whatsapp).replace(/\D/g, '');
  const digits = String(item.phone || '').replace(/\D/g, '').replace(/^56/, '');
  return /^9\d{8}$/.test(digits) ? `56${digits}` : '';
}
function waLinkFor(item) {
  const number = waNumberFor(item);
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(item.suggested_message || '')}` : '';
}
function mailtoFor(item) {
  if (!item.email) return '';
  const subject = `Una idea para ${item.name || 'tu negocio'}`;
  return `mailto:${item.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(item.suggested_message || '')}`;
}
const statusLabels = { new:'Nuevo', shortlisted:'Seleccionado', contacted:'Contactado', replied:'Respondió', qualified:'Calificado', won:'Proyecto creado', lost:'No avanzó', discarded:'Descartado' };
const pipelineStatuses = ['new', 'shortlisted', 'contacted', 'replied', 'qualified', 'won'];

function prospectingDate(value) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-CL', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }).format(new Date(value));
}

function followUpBadge(item) {
  if (!item.next_action_at || ['won', 'lost', 'discarded'].includes(item.status)) return '';
  const overdue = new Date(item.next_action_at) <= new Date();
  return `<small class="crm-follow ${overdue ? 'overdue' : ''}">${overdue ? 'Seguimiento vencido' : `Seguimiento ${prospectingDate(item.next_action_at)}`}</small>`;
}

const channelLabels = { whatsapp:'WhatsApp', email:'Correo', call:'Llamada', instagram:'Instagram', visit:'Visita' };

function lastContactLine(item) {
  if (!item.last_contacted_at) return '<span class="record-lastcontact pending"><i data-lucide="circle-dashed"></i> Sin contactar aún</span>';
  const label = channelLabels[item.last_contact_channel] || 'contacto';
  return `<span class="record-lastcontact done"><i data-lucide="check-circle-2"></i> Último contacto: ${prospectingDate(item.last_contacted_at)} · ${label}</span>`;
}

async function logContact(id, channel) {
  try {
    await prospectingRequest(`/api/prospecting/prospects/${encodeURIComponent(id)}/contact`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ channel }) });
    await loadProspecting();
  } catch (error) { console.warn('No se pudo registrar el contacto:', error.message); }
}

async function prospectingRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
}

async function initProspecting() {
  const select = $p('#prospecting-vertical');
  if (!select) return;
  prospectingState.verticals = await prospectingRequest('/api/prospecting/verticals');
  select.innerHTML = prospectingState.verticals.map(item => `<option value="${escp(item.id)}">${escp(item.label)}</option>`).join('');
  applyVerticalTerms();
  await loadProspecting();
  setCrmView('today');
}

function applyVerticalTerms() {
  const vertical = prospectingState.verticals.find(item => item.id === $p('#prospecting-vertical')?.value);
  if (vertical && $p('#prospecting-terms')) $p('#prospecting-terms').value = vertical.defaultTerms;
}

async function loadProspecting() {
  const search = $p('#prospecting-filter-search')?.value || '';
  const status = $p('#prospecting-filter-status')?.value || 'all';
  const data = await prospectingRequest(`/api/prospecting/overview?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`);
  prospectingState.prospects = data.prospects;
  prospectingState.stats = data.stats;
  prospectingState.configured = data.configured;
  if (prospectingState.selectedId && !data.prospects.some(item => item.id === prospectingState.selectedId)) prospectingState.selectedId = null;
  renderProspectingStats();
  renderProspectingList();
  renderProspectingPipeline();
  renderProspectingRecord();
  if (prospectingState.view === 'today') renderToday();
  $p('#prospecting-provider-status').innerHTML = data.configured
    ? '<span class="provider-dot ready"></span> Búsqueda real disponible desde este equipo.'
    : '<span class="provider-dot"></span> Falta SERPER_API_KEY. Puedes recorrer el escenario completo.';
  $p('#prospecting-nav-count').textContent = Number(data.stats.new || 0) + Number(data.stats.replied || 0) + Number(data.stats.qualified || 0);
  window.lucide?.createIcons();
}

function renderProspectingStats() {
  const prospects = prospectingState.prospects;
  $p('#prospecting-stat-total').textContent = prospectingState.stats.total || 0;
  $p('#prospecting-stat-hot').textContent = prospects.filter(item => item.fit === 'high' && !['won','lost','discarded'].includes(item.status)).length;
  $p('#prospecting-stat-contacted').textContent = Number(prospectingState.stats.contacted || 0) + Number(prospectingState.stats.replied || 0);
  $p('#prospecting-stat-qualified').textContent = prospectingState.stats.qualified || 0;
}

function renderProspectingList() {
  const container = $p('#prospecting-list');
  if (!prospectingState.prospects.length) {
    container.innerHTML = '<div class="crm-list-empty"><i data-lucide="radar"></i><h4>El radar está limpio</h4><p>Ejecuta una búsqueda o carga el escenario para revisar el flujo.</p></div>';
    return;
  }
  container.innerHTML = `<div class="crm-list-head"><span>Negocio</span><span>Señal principal</span><span>Etapa</span><span>Score</span></div>` + prospectingState.prospects.map(item => `
    <button class="crm-lead-row ${item.id === prospectingState.selectedId ? 'active' : ''}" type="button" data-prospect-id="${item.id}">
      <span class="crm-company"><b>${escp(item.name)}</b><small>${escp(item.category || item.location)}</small><span class="crm-contact-tags">${item.email ? '<em class="tag-email">correo</em>' : ''}${item.whatsapp ? '<em class="tag-wa">WhatsApp</em>' : ''}</span></span>
      <span class="crm-signal">${escp(item.signals?.[0] || 'Requiere revisión')}${followUpBadge(item)}</span>
      <span><em class="crm-status status-${escp(item.status)}">${escp(statusLabels[item.status] || item.status)}</em></span>
      <span class="crm-score score-${escp(item.fit)}"><b>${item.score}</b><small>/100</small></span>
    </button>`).join('');
  container.querySelectorAll('[data-prospect-id]').forEach(button => button.addEventListener('click', () => {
    prospectingState.selectedId = button.dataset.prospectId;
    renderProspectingList();
    renderProspectingRecord();
  }));
}

function renderProspectingRecord() {
  const container = $p('#prospecting-record');
  const item = prospectingState.prospects.find(prospect => prospect.id === prospectingState.selectedId);
  if (!item) {
    container.innerHTML = '<div class="crm-record-empty"><i data-lucide="mouse-pointer-click"></i><h4>Abre una oportunidad</h4><p>Aquí verás evidencia, contacto, mensaje sugerido y toda su historia.</p></div>';
    window.lucide?.createIcons();
    return;
  }
  const phoneLink = waLinkFor(item);
  const emailLink = mailtoFor(item);
  const siteLink = safeHref(item.website);
  const socialLink = item.instagram ? `https://instagram.com/${String(item.instagram).replace(/[^a-zA-Z0-9_.]/g, '')}` : (item.facebook ? `https://facebook.com/${String(item.facebook).replace(/[^a-zA-Z0-9.]/g, '')}` : '');
  container.innerHTML = `
    <header class="crm-record-head">
      <div><span class="eyebrow">${escp(prospectingState.verticals.find(v => v.id === item.vertical)?.label || item.vertical)}</span><h3>${escp(item.name)}</h3><p>${escp(item.category)} · ${escp(item.location)}</p></div>
      <div class="record-score score-${escp(item.fit)}"><strong>${item.score}</strong><span>encaje</span></div>
    </header>
    <div class="record-actions">
      ${phoneLink ? `<a class="btn btn-primary" id="prospecting-wa" href="${phoneLink}" target="_blank" rel="noopener"><i data-lucide="message-circle"></i> WhatsApp</a>` : ''}
      ${emailLink ? `<a class="btn btn-outline" id="prospecting-email" href="${emailLink}"><i data-lucide="mail"></i> Correo</a>` : ''}
      ${siteLink ? `<a class="btn btn-outline" href="${siteLink}" target="_blank" rel="noopener"><i data-lucide="globe-2"></i> Sitio</a>` : ''}
      <button class="btn btn-outline" type="button" id="prospecting-copy-message"><i data-lucide="copy"></i> Copiar mensaje</button>
    </div>
    <div class="record-trace">${lastContactLine(item)}${item.email || item.whatsapp || item.phone ? '' : ' <span class="record-lastcontact pending">Sin canal directo — revisa el sitio</span>'}<button class="btn-link" type="button" id="prospecting-log-call">Registrar llamada/visita</button></div>
    <section class="record-section"><span class="record-label">Por qué aparece</span><div class="record-signals">${(item.signals || []).map(signal => `<span><i data-lucide="check"></i>${escp(signal)}</span>`).join('')}</div></section>
    <section class="record-section record-contact-grid">
      <div><span class="record-label">Correo</span><strong>${item.email ? escp(item.email) : 'No encontrado en la web'}</strong></div>
      <div><span class="record-label">WhatsApp</span><strong>${item.whatsapp ? escp(item.whatsapp) : (item.phone ? `${escp(item.phone)} (teléfono)` : 'No encontrado')}</strong></div>
      <div><span class="record-label">Teléfono</span><strong>${escp(item.phone || 'No encontrado')}</strong></div>
      <div><span class="record-label">Reseñas</span><strong>${item.rating ? `${item.rating} · ${item.review_count}` : 'Sin dato'}</strong></div>
      <div class="wide"><span class="record-label">Redes</span><strong>${socialLink ? `<a href="${escp(socialLink)}" target="_blank" rel="noopener">${escp(item.instagram ? '@' + item.instagram : item.facebook)}</a>` : 'Sin redes detectadas'}</strong></div>
      <div class="wide"><span class="record-label">Dirección</span><strong>${escp(item.address || 'No encontrada')}</strong></div>
    </section>
    <section class="record-section"><span class="record-label">Apertura sugerida</span><p class="record-message">${escp(item.suggested_message)}</p></section>
    <form id="prospecting-record-form" class="record-form">
      <div class="form-row">
        <div class="form-group"><label for="record-status">Etapa</label><select id="record-status">${Object.entries(statusLabels).map(([value,label]) => `<option value="${value}" ${value === item.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div class="form-group"><label for="record-next-action">Próximo seguimiento</label><input id="record-next-action" type="datetime-local" value="${item.next_action_at ? escp(item.next_action_at.slice(0,16)) : ''}"></div>
      </div>
      <div class="form-group"><label for="record-notes">Notas comerciales</label><textarea id="record-notes" rows="3" placeholder="Qué hablamos, objeciones, persona de contacto…">${escp(item.notes)}</textarea></div>
      <button class="btn btn-outline btn-full" type="submit"><i data-lucide="save"></i> Guardar seguimiento</button>
    </form>
    <section class="record-section record-timeline"><span class="record-label">Historia</span>${(item.activities || []).slice(0,8).map(activity => `<div><i></i><p>${escp(activity.summary)}<small>${prospectingDate(activity.created_at)}</small></p></div>`).join('') || '<p class="text-muted">Todavía no hay actividad.</p>'}</section>
    <footer class="record-footer">${item.converted_client_id ? `<span><i data-lucide="check-circle-2"></i> Proyecto ${escp(item.converted_client_id)} creado</span>` : '<button class="btn btn-primary btn-full" type="button" id="prospecting-convert"><i data-lucide="briefcase-business"></i> Convertir en proyecto ZeroAgent</button>'}</footer>`;

  // Contactar por WhatsApp/correo abre el canal y, en el mismo gesto, deja registro y avanza etapa.
  $p('#prospecting-wa')?.addEventListener('click', () => logContact(item.id, 'whatsapp'));
  $p('#prospecting-email')?.addEventListener('click', () => logContact(item.id, 'email'));
  $p('#prospecting-log-call')?.addEventListener('click', () => logContact(item.id, 'call'));
  $p('#prospecting-copy-message')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.suggested_message);
      $p('#prospecting-copy-message').textContent = 'Mensaje copiado';
    } catch { $p('#prospecting-copy-message').textContent = 'Copia manual: selecciona el texto'; }
  });
  $p('#prospecting-record-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    await updateProspect(item.id, { status:$p('#record-status').value, notes:$p('#record-notes').value, next_action_at:$p('#record-next-action').value || null });
  });
  $p('#prospecting-convert')?.addEventListener('click', () => convertProspect(item.id));
  window.lucide?.createIcons();
}

function renderProspectingPipeline() {
  const container = $p('#prospecting-pipeline-view');
  container.innerHTML = pipelineStatuses.map(status => {
    const items = prospectingState.prospects.filter(item => item.status === status);
    return `<section class="pipeline-column" data-pipeline-status="${status}"><header><span>${statusLabels[status]}</span><b>${items.length}</b></header><div class="pipeline-stack">${items.map(item => `<button draggable="true" type="button" class="pipeline-card" data-prospect-id="${item.id}"><span>${escp(item.category)}</span><strong>${escp(item.name)}</strong><small>${escp(item.location)} · ${item.score}/100</small></button>`).join('') || '<p>Suelta una oportunidad aquí</p>'}</div></section>`;
  }).join('');
  container.querySelectorAll('.pipeline-card').forEach(card => {
    card.addEventListener('click', () => { prospectingState.selectedId = card.dataset.prospectId; setCrmView('focus'); renderProspectingList(); renderProspectingRecord(); });
    card.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', card.dataset.prospectId));
  });
  container.querySelectorAll('.pipeline-column').forEach(column => {
    column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', async event => { event.preventDefault(); column.classList.remove('drag-over'); await updateProspect(event.dataTransfer.getData('text/plain'), { status:column.dataset.pipelineStatus }); });
  });
}

function openInFocus(id) {
  prospectingState.selectedId = id;
  setCrmView('focus');
  renderProspectingList();
  renderProspectingRecord();
}

function todayCard(item) {
  const waLink = waLinkFor(item);
  const emailLink = mailtoFor(item);
  const tags = `${item.email ? '<em class="tag-email">correo</em>' : ''}${waNumberFor(item) ? '<em class="tag-wa">WhatsApp</em>' : ''}`;
  return `<article class="today-card" data-prospect-id="${item.id}">
    <button class="today-card-main" type="button" data-open="${item.id}">
      <b>${escp(item.name)}</b>
      <small>${escp(item.category || item.location)} · ${item.score}/100</small>
      <span class="crm-contact-tags">${tags}${followUpBadge(item)}</span>
    </button>
    <div class="today-card-actions">
      ${waLink ? `<a class="today-act wa" data-contact="whatsapp" data-id="${item.id}" href="${waLink}" target="_blank" rel="noopener" title="WhatsApp con mensaje listo"><i data-lucide="message-circle"></i></a>` : ''}
      ${emailLink ? `<a class="today-act mail" data-contact="email" data-id="${item.id}" href="${emailLink}" title="Correo con propuesta lista"><i data-lucide="mail"></i></a>` : ''}
    </div>
  </article>`;
}

async function renderToday() {
  const container = $p('#prospecting-today-view');
  if (!container) return;
  let data;
  try { data = await prospectingRequest('/api/prospecting/overview?status=all&search='); }
  catch (error) { container.innerHTML = `<div class="crm-list-empty"><p>No se pudo cargar la bandeja: ${escp(error.message)}</p></div>`; return; }
  const all = data.prospects || [];
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const isActive = item => !['won', 'lost', 'discarded'].includes(item.status);
  const followUps = all.filter(item => isActive(item) && item.next_action_at && new Date(item.next_action_at) <= endToday)
    .sort((a, b) => new Date(a.next_action_at) - new Date(b.next_action_at));
  const toContact = all.filter(item => (item.email || waNumberFor(item)) && ['new', 'shortlisted'].includes(item.status) && !item.last_contacted_at)
    .sort((a, b) => b.score - a.score).slice(0, 20);

  const section = (title, hint, items, emptyText) => `
    <section class="today-section">
      <header class="today-section-head"><h4>${title}</h4><span>${items.length}</span></header>
      <p class="today-hint">${hint}</p>
      ${items.length ? `<div class="today-stack">${items.map(todayCard).join('')}</div>` : `<p class="today-empty">${emptyText}</p>`}
    </section>`;

  if (!all.length) {
    container.innerHTML = `<div class="crm-list-empty"><i data-lucide="radar"></i><h4>El radar está vacío</h4><p>Busca negocios locales o carga el escenario para empezar a trabajar tu cartera.</p></div>`;
  } else if (!followUps.length && !toContact.length) {
    container.innerHTML = `<div class="crm-list-empty"><i data-lucide="check-circle-2"></i><h4>Estás al día</h4><p>Sin seguimientos pendientes ni contactos nuevos por hacer. Corre una búsqueda para sumar oportunidades.</p></div>`;
  } else {
    container.innerHTML =
      section('Seguimientos de hoy', 'Compromisos que se vencen o ya vencieron. Retómalos antes de que se enfríen.', followUps, 'Sin seguimientos para hoy.') +
      section('Por contactar', 'Negocios con correo o WhatsApp, aún sin primer contacto. Ábrelos y ofréceles tu demo.', toContact, 'Nada nuevo por contactar ahora mismo.');
  }

  container.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => openInFocus(button.dataset.open)));
  container.querySelectorAll('[data-contact]').forEach(anchor => anchor.addEventListener('click', () => logContact(anchor.dataset.id, anchor.dataset.contact)));
  window.lucide?.createIcons();
}

async function updateProspect(id, payload) {
  try {
    await prospectingRequest(`/api/prospecting/prospects/${encodeURIComponent(id)}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  } catch (error) {
    alert(`No se pudo guardar el cambio: ${error.message}`);
  }
  await loadProspecting();
}

async function convertProspect(id) {
  try {
    const data = await prospectingRequest(`/api/prospecting/prospects/${encodeURIComponent(id)}/convert`, { method:'POST' });
    await loadProspecting();
    window.dispatchEvent(new CustomEvent('zeroagent:prospect-converted', { detail:data }));
    alert('Proyecto creado. Ya está disponible en Portafolio para enviar el onboarding.');
  } catch (error) {
    alert(`No se pudo convertir en proyecto: ${error.message}`);
  }
}

function setCrmView(view) {
  prospectingState.view = view;
  document.querySelectorAll('[data-crm-view]').forEach(button => button.classList.toggle('active', button.dataset.crmView === view));
  $p('#prospecting-today-view').hidden = view !== 'today';
  $p('#prospecting-focus-view').hidden = view !== 'focus';
  $p('#prospecting-pipeline-view').hidden = view !== 'pipeline';
  if (view === 'today') renderToday();
}

$p('#prospecting-vertical')?.addEventListener('change', applyVerticalTerms);
$p('#prospecting-search-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  const previous = button.innerHTML;
  button.disabled = true; button.textContent = 'Buscando negocios…';
  try {
    const data = await prospectingRequest('/api/prospecting/search', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ vertical:$p('#prospecting-vertical').value, location:$p('#prospecting-location').value, coverage:$p('#prospecting-coverage').value, terms:$p('#prospecting-terms').value }) });
    await loadProspecting();
    alert(`Búsqueda terminada: ${data.found} encontrados, ${data.created} nuevos.\nContacto directo: ${data.with_email ?? 0} con correo, ${data.with_whatsapp ?? 0} con WhatsApp propio.`);
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; button.innerHTML = previous; window.lucide?.createIcons(); }
});
$p('#prospecting-demo')?.addEventListener('click', async () => {
  try { await prospectingRequest('/api/prospecting/demo', { method:'POST' }); await loadProspecting(); }
  catch (error) { alert(`No se pudo cargar el escenario: ${error.message}`); }
});
$p('#prospecting-export')?.addEventListener('click', () => {
  if (!prospectingState.prospects.length) { alert('No hay prospectos para exportar con los filtros actuales.'); return; }
  const status = $p('#prospecting-filter-status')?.value || 'all';
  const search = $p('#prospecting-filter-search')?.value || '';
  window.location.href = `/api/prospecting/export?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`;
});

function toggleAddModal(open) {
  const modal = $p('#prospecting-add-modal');
  if (!modal) return;
  modal.hidden = !open;
  if (open) {
    const select = $p('#add-vertical');
    if (select && !select.options.length) select.innerHTML = prospectingState.verticals.map(item => `<option value="${escp(item.id)}">${escp(item.label)}</option>`).join('');
    $p('#add-name')?.focus();
  }
}
$p('#prospecting-add')?.addEventListener('click', () => toggleAddModal(true));
document.querySelectorAll('[data-close-modal]').forEach(element => element.addEventListener('click', () => toggleAddModal(false)));
$p('#prospecting-add-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || $p('#prospecting-add-form button[type="submit"]');
  const payload = {
    name: $p('#add-name').value.trim(), category: $p('#add-category').value.trim(), location: $p('#add-location').value.trim(),
    phone: $p('#add-phone').value.trim(), whatsapp: $p('#add-whatsapp').value.trim(), email: $p('#add-email').value.trim(),
    website: $p('#add-website').value.trim(), vertical: $p('#add-vertical').value
  };
  if (!payload.name) { alert('El nombre del negocio es obligatorio.'); return; }
  if (button) button.disabled = true;
  try {
    const data = await prospectingRequest('/api/prospecting/prospects/manual', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    toggleAddModal(false);
    $p('#prospecting-add-form').reset();
    await loadProspecting();
    if (data.id) openInFocus(data.id);
  } catch (error) { alert(`No se pudo agregar: ${error.message}`); }
  finally { if (button) button.disabled = false; }
});
$p('#prospecting-filter-status')?.addEventListener('change', loadProspecting);
let prospectingSearchTimer;
$p('#prospecting-filter-search')?.addEventListener('input', () => { clearTimeout(prospectingSearchTimer); prospectingSearchTimer = setTimeout(loadProspecting, 250); });
document.querySelectorAll('[data-crm-view]').forEach(button => button.addEventListener('click', () => setCrmView(button.dataset.crmView)));
window.addEventListener('zeroagent:render-prospecting', loadProspecting);
window.addEventListener('zeroagent:prospect-converted', async () => { if (typeof window.zeroagentRefreshClients === 'function') await window.zeroagentRefreshClients(); });
document.addEventListener('DOMContentLoaded', () => initProspecting().catch(error => console.error('Prospección:', error)));
