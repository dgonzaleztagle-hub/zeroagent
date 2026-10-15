import { agendaConfig, agendaSupabaseRequest, agendaUsesSupabase, getAgendaDashboard, getAvailableSlots, createAgendaAppointment, updateAgendaAppointment, rescheduleAgendaAppointment, findRiskWindow, isActiveAgendaAppointment, asIso, listUpcomingAppointmentsForPhone } from './agenda.js';
import { updateCustomerIntakeRecord } from './customer-records.js';
import { dayLabel } from './turn-guards.js';

// Match de catálogo tolerante: el LLM puede pasar el nombre con otra capitalización o sin tildes.
// La relevancia no debe depender de coincidencia textual exacta.
const normName = value => String(value || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const findByName = (list, name) => (list || []).find(item => normName(item.name) === normName(name));
// Si no hay match exacto (el modelo escribió "evaluación" en vez de "Evaluación · Box Buin"),
// intenta un match parcial ANTES de rendirse. Si calza con un solo item, se resuelve solo — es
// justo el caso más común y lo que antes fallaba siempre al primer intento (ver AGENDA_BEHAVIOR /
// el enum de getAgendaToolDefinitions, que reduce esto todavía más). Si calza con más de uno
// ("evaluación" sin decir sede, y hay evaluación en 2 sedes), es ambigüedad real del cliente, no
// del matching — no se elige por él, se marca `ambiguous` para que el modelo pregunte.
function resolveCatalogItem(list, name) {
  const exact = findByName(list, name);
  if (exact) return { item: exact };
  const query = normName(name);
  if (!query) return { item: null };
  const candidates = (list || []).filter(item => normName(item.name).includes(query));
  if (candidates.length === 1) return { item: candidates[0] };
  if (candidates.length > 1) return { item: null, ambiguous: candidates };
  return { item: null };
}
// Zona de atención a domicilio (config.home_visit_zone: comunas/localidades donde el negocio sí llega
// con el traslado calculado). El modelo extrae la comuna que dijo el cliente (eso lo hace bien) y el
// código decide si cae dentro: ofrecer horas a domicilio fuera de zona prometía algo que Francisco
// tenía que desmentir (replay 14-10-2026, Isla de Maipo, 0 de 2). Sin zona configurada no se exige nada.
function homeZoneCheck(config, comuna) {
  const zone = (config?.home_visit_zone || []).map(normName).filter(Boolean);
  if (!zone.length) return { status: 'not_configured' };
  const value = normName(comuna).replace(/^(la |el )?(comuna|sector|localidad|ciudad) de /, '').trim();
  if (!value) return { status: 'missing' };
  if (zone.includes(value)) return { status: 'in' };
  // "Paine" a secas es ambiguo cuando la zona sólo incluye "Paine centro".
  if (zone.some(entry => entry.includes(' ') && entry.split(' ')[0] === value)) return { status: 'ambiguous' };
  return { status: 'outside' };
}
const isHomeService = (service, location) => service?.delivery_mode === 'mobile' || /domicilio/i.test(`${service?.name || ''} ${location || ''}`);
function homeZoneBlock(config, service, location, comuna, clientTexts) {
  if (!isHomeService(service, location)) return null;
  // El modelo, al recibir "falta la comuna", puede rellenarla con una que el cliente nunca dijo (replay
  // 14-10-2026 pasó "Buin" sin que nadie la mencionara): si hay textos del cliente, la comuna tiene que estar ahí.
  const said = !Array.isArray(clientTexts) || !normName(comuna) || clientTexts.some(text => normName(text).includes(normName(comuna)));
  const check = homeZoneCheck(config, said ? comuna : '');
  const zoneList = (config?.home_visit_zone || []).join(', ');
  if (check.status === 'missing') return { error: 'comuna_required', message: `Para atender a domicilio primero necesito la comuna o localidad del cliente (zona de atención: ${zoneList}). Pregúntasela en una frase y vuelve a llamar con "comuna" tal como la dijo; no la supongas.` };
  if (check.status === 'ambiguous') return { error: 'comuna_ambiguous', message: `Esa localidad puede estar dentro o fuera de la zona (${zoneList}). Pregúntale en qué sector exacto está antes de ofrecer horas a domicilio.` };
  if (check.status === 'outside') return { ok: true, action: 'outside_zone', zona_de_atencion: zoneList, message: `"${comuna}" está fuera de la zona de atención a domicilio (${zoneList}). NO ofrezcas horas a domicilio: dile en una frase que ahí el traslado lo coordina Francisco, ofrécele el Box Buin consultando get_availability con location "Box Buin", y avisa a Francisco con avisar_al_dueno.` };
  return null;
}
const normalizePhone = value => String(value || '').replace(/\D/g, '');
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const samePhone = (a, b) => {
  const left = normalizePhone(a); const right = normalizePhone(b);
  return left.length >= 8 && right.length >= 8 && left === right;
};

// El 2do parámetro (catálogo LIVE, mismo que ejecuta las herramientas) es opcional — sin él, se
// comporta como antes (sólo `type: 'string'`, sin enum). Con él, service/resource/location quedan
// acotados a los nombres reales, así el modelo elige de una lista real en vez de escribir el
// nombre libre y fallar contra el match exacto/parcial de resolveCatalogItem.
export function getAgendaToolDefinitions(packageData, catalog, options = {}) {
  if (!agendaConfig(packageData)) return [];
  const namesOf = list => (list || []).map(item => item.name).filter(Boolean);
  const withEnum = (schema, names) => (names.length ? { ...schema, enum: names } : schema);
  const serviceSchema = withEnum({ type: 'string' }, namesOf(catalog?.services));
  const resourceSchema = withEnum({ type: 'string' }, namesOf(catalog?.resources));
  const locationSchema = withEnum({ type: 'string' }, namesOf(catalog?.locations));
  return [
    { type: 'function', function: { name: 'get_availability', description: 'Consulta los horarios realmente disponibles. Úsala SIEMPRE que pregunten por horarios, disponibilidad o cupos, incluidas preguntas de sí/no como "¿tienen hora?" o "¿hay cupo?". Nunca inventes horarios ni respondas disponibilidad sin llamarla. Para saber si hay hora sólo hace falta la SEDE (Box Buin o domicilio) — el servicio exacto (sesión general, sesión respiratoria) casi no cambia la duración real y es una pregunta posterior, no un requisito para buscar hora; pásalo sólo si el cliente ya lo dijo espontáneamente.', parameters: { type: 'object', properties: { location: { type: 'string', description: 'Sede pedida por el cliente.', enum: ['Box Buin', 'Domicilio'] }, service: serviceSchema, resource: resourceSchema, date: { type: 'string', description: 'YYYY-MM-DD' }, comuna: { type: 'string', description: 'Sólo para atención a domicilio: la comuna o localidad que dijo el cliente, tal cual. No la supongas ni la inventes; si no la dijo, pregúntasela antes de consultar.' }, fuera_de: { type: 'array', description: 'Rangos en que el cliente dijo en CUALQUIER momento de la conversación que NO puede, en hora local, para que la herramienta los saque. Ej.: "entreno de 17:30 a 22:30" -> [{"desde":"17:30","hasta":"22:30"}]; "sólo después de las 18" -> [{"desde":"00:00","hasta":"18:00"}]; "en la mañana" -> [{"desde":"13:00","hasta":"23:59"}]. Pásalo en cada consulta mientras siga vigente; omítelo si no dijo nada.', items: { type: 'object', properties: { desde: { type: 'string', description: 'HH:MM' }, hasta: { type: 'string', description: 'HH:MM' } }, required: ['desde', 'hasta'] } } }, required: ['location', 'resource', 'date'] } } },
    { type: 'function', function: { name: 'get_my_appointment', description: 'Consulta las reservas activas del cliente que escribe. Requiere identidad verificada por canal.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'create_appointment', description: 'Crea la reserva apenas tengas los datos requeridos (nombre, servicio, profesional, horario) y el cliente haya confirmado que quiere agendar ese horario. Al pedir los datos pídelos TODOS en la misma frase: nombre y apellido, RUT y correo (ej. "para dejarte tomada la hora necesito tu nombre y apellido, tu RUT para la boleta y un correo, así te llega la invitación al calendario"). Pregúntalo UNA sola vez: si el cliente no los da o responde sin alguno, AGENDA IGUAL con lo que tengas y menciona al confirmar qué dato quedó pendiente para la boleta — nunca retengas la hora esperando el RUT ni vuelvas a insistir. Salvo el nombre, ninguno de esos datos bloquea la reserva. Si la respuesta trae ask_intake_details:true, sigue el texto de intake_prompt para pedir esos datos opcionales DESPUÉS, en el mismo mensaje donde confirmas que la hora quedó agendada — nunca antes de crear la reserva. Si la respuesta trae action:"needs_manual_confirmation", NO digas que la reserva quedó agendada: sigue el mensaje que te devuelve la herramienta (el profesional debe confirmar esa hora en particular manualmente).', parameters: { type: 'object', properties: { customer_name: { type: 'string', description: 'Nombre y apellido de quien ESCRIBE (el dueño del teléfono). Una dirección (calle y número) nunca es un nombre.' }, patient_name: { type: 'string', description: 'Nombre de quien se ATIENDE, sólo si es otra persona (hijo, mamá, pareja). Si son varias personas, una reserva por cada una.' }, email: { type: 'string', description: 'Correo del cliente, si lo dio.' }, rut: { type: 'string', description: 'RUT del cliente, si lo dio (se pide para emitir la boleta).' }, address: { type: 'string', description: 'Dirección de atención (calle, número, comuna) — obligatoria si el servicio es a domicilio.' }, comuna: { type: 'string', description: 'Sólo a domicilio: la comuna o localidad del cliente, tal como la dijo.' }, service: serviceSchema, resource: resourceSchema, location: locationSchema, date: { type: 'string', description: 'Día de la hora, YYYY-MM-DD.' }, time: { type: 'string', description: 'Hora local HH:MM, tal como viene en hora_local de get_availability (ej. 18:30). Nunca conviertas zonas horarias.' }, notes: { type: 'string' } }, required: ['customer_name', 'service', 'resource', 'date', 'time'] } } },
    { type: 'function', function: { name: 'update_customer_profile', description: 'Guarda el RUT o el correo que el cliente entrega después de agendar. Es SÓLO para guardar esos datos: no implica crear, cambiar ni revisar ninguna reserva. Llámala apenas entregue alguno.', parameters: { type: 'object', properties: { email: { type: 'string' }, rut: { type: 'string' } } } } },
    { type: 'function', function: { name: 'cancel_appointment', description: 'Cancela una reserva del cliente que escribe, sólo si lo pidió explícitamente. Si tiene una sola reserva activa no hace falta la referencia.', parameters: { type: 'object', properties: { reference: { type: 'string', description: 'Referencia ZA-... sólo si la tienes de una herramienta en este turno; si no, omítela.' } } } } },
    { type: 'function', function: { name: 'reschedule_appointment', description: 'Cambia la hora de una reserva del cliente que escribe, después de que eligió día y hora. Si tiene una sola reserva activa no hace falta la referencia. Si el cambio no se puede, la reserva original queda intacta y la respuesta trae alternativas reales de ese día: ofrécelas. Nunca canceles para cambiar una hora.', parameters: { type: 'object', properties: { reference: { type: 'string', description: 'Referencia ZA-... sólo si la tienes de una herramienta en este turno; si no, omítela.' }, date: { type: 'string', description: 'Día nuevo, YYYY-MM-DD.' }, time: { type: 'string', description: 'Hora local nueva HH:MM, tal como viene en hora_local de get_availability.' } }, required: ['date', 'time'] } } },
    ...(literalReplies(packageData).length ? [{ type: 'function', function: { name: 'responder_textual', description: `Envía una respuesta oficial del negocio TAL CUAL fue escrita por el dueño. Úsala SIEMPRE que el mensaje del cliente caiga en uno de estos casos, en vez de redactar tú la respuesta:
${literalReplies(packageData).map(item => `- "${item.id}": ${item.when}`).join('\n')}
El texto se manda literal y completo; tú no lo reescribes, no lo resumes y no le agregas nada antes ni después. NO la uses cuando el cliente hace una pregunta puntual que se contesta con un dato ("¿son 30 mil?", "¿es quiropráctico?", "¿atienden hasta las 8?"): respóndele tú en una frase con los hechos confirmados, usando el precio o la sede de su hora si ya tiene una. El bloque oficial es para cuando pide la información completa y todavía no la tiene.`, parameters: { type: 'object', properties: { id: { type: 'string', enum: literalReplies(packageData).map(item => item.id), description: 'Cuál de las respuestas oficiales corresponde.' }, ademas: { type: 'string', enum: literalReplies(packageData).map(item => item.id), description: 'Si en el mismo mensaje el cliente preguntó por DOS cosas que tienen respuesta oficial (ej. dónde queda y cuánto vale), el id de la segunda. Omítelo si preguntó una sola.' } }, required: ['id'] } } }] : []),
    // Dos herramientas distintas a propósito. La primera CALLA al agente en ese hilo, así que es
    // sólo para los casos en que seguir contestando sería peor; la segunda avisa al dueño sin
    // interrumpir la atención. Mientras existió una sola, descrita como "cuando hay un problema
    // real", el modelo la usaba con cualquier paciente con dolor —9 de 18 derivaciones reales de
    // la primera semana de franciskom eran pacientes comunes que había que llevar a una hora— y
    // dejaba el hilo mudo 12 h mientras el cliente seguía preguntando precio y horarios.
    { type: 'function', function: { name: 'request_human_handoff', description: 'Traspasa la conversación a una persona; el agente deja de atender ese hilo. Llámala cuando el cliente pide hablar con una persona, cuando el mensaje es de un tema ajeno al negocio o de un tercero, y cuando lo pedido está fuera de lo que el negocio cumple. No es para la gravedad ni los antecedentes de salud del cliente: eso se atiende y se agenda. Ejecútala en el mismo turno en que anuncias el traspaso.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
    // Sólo se ofrece cuando el runtime lo permite (ver historyAllowsSilence): el dueño contesta
    // desde su propio WhatsApp y el canal no nos entrega esos mensajes, así que en un hilo que él
    // está llevando la respuesta correcta puede ser ninguna. Callarse en cualquier otro contexto
    // sería perder al cliente, por eso la herramienta no existe en esos turnos.
    ...(options.allowSilence ? [{ type: 'function', function: { name: 'no_intervenir', description: 'No manda ningún mensaje en este turno. Llámala cuando el hilo lo está llevando una persona del negocio y tú no ves sus mensajes: el último mensaje del cliente responde a algo que tú no dijiste (contesta "sí", "a las 15", "ya llegué", "gracias" sin que tú se lo hayas preguntado), o coordina algo que tú nunca ofreciste. Ante la duda, responde en vez de callarte.', parameters: { type: 'object', properties: { reason: { type: 'string', description: 'En una frase: por qué este turno no es para ti.' } }, required: ['reason'] } } }] : []),
    { type: 'function', function: { name: 'ignorar_mensaje_ajeno', description: 'No manda ningún mensaje. Llámala cuando el mensaje NO viene de una persona que busca los servicios del negocio sino de un sistema o de un tercero: respuesta automática de una campaña o menú de botones ("toca uno de los botones", "No me interesa", "Llamar ahora"), mensajes de otra organización que coordina algo ajeno (otro centro, un laboratorio, una empresa que te escribe a ti). Contestarles es ruido o confunde. NO la uses con ninguna persona que escribe para consultar o pedir algo, aunque sea un servicio que el negocio no ofrece (por ejemplo una mascota, otro tipo de atención) o un tema distinto: a ellos SIEMPRE se les responde, aunque sea para decirles que eso no se atiende.', parameters: { type: 'object', properties: { origen: { type: 'string', enum: ['respuesta_automatica', 'otra_organizacion', 'persona_que_consulta'], description: 'Quién escribe: respuesta_automatica (campaña, menú de botones), otra_organizacion (un tercero coordinando algo ajeno) o persona_que_consulta (cualquier persona que pregunta o pide algo, incluso algo que el negocio no hace).' }, reason: { type: 'string', description: 'En una frase: qué es este mensaje.' } }, required: ['origen', 'reason'] } } },
    { type: 'function', function: { name: 'avisar_al_dueno', description: 'Avisa al dueño para que entre él a cerrar la venta, sin dejar de atender: en el mismo turno sigues respondiendo y ofreciendo hora. Es el último recurso, no el primero: úsala sólo cuando YA le ofreciste horas concretas y el cliente igual duda, pone un freno (plata, tiempo, lo va a pensar) o no la toma, o cuando pide algo que sólo el dueño puede resolver (un traslado fuera de zona, una condición de precio).', parameters: { type: 'object', properties: { reason: { type: 'string', description: 'En una frase: qué duda tiene el cliente o qué dato falta.' } }, required: ['reason'] } } }
  ];
}

// El modelo alucina la cola de una lista larga de horas: con 18-23 horas devueltas por la
// herramienta, gpt-4o-mini seguía la serie regular más allá del último dato real y ofrecía horas
// fuera del horario de atención (medido 3/3 en franciskom: ofrecía hasta las 22:00 atendiendo
// hasta las 20:00); con listas cortas responde exacto. Por eso la herramienta entrega una
// preselección breve y repartida a lo largo del día en vez del bloque completo — la lista real
// sigue disponible en available_slots para validar la hora que pida el cliente.
const MAX_SLOTS_TO_OFFER = 3; // un vendedor ofrece dos o tres opciones, no la lista entera

function pickSlotShortlist(slots) {
  if (slots.length <= MAX_SLOTS_TO_OFFER) return slots;
  const step = (slots.length - 1) / (MAX_SLOTS_TO_OFFER - 1);
  const picked = [];
  for (let i = 0; i < MAX_SLOTS_TO_OFFER; i += 1) {
    const slot = slots[Math.round(i * step)];
    if (slot && !picked.includes(slot)) picked.push(slot);
  }
  return picked;
}

// Respuestas que el dueño quiere que salgan PALABRA POR PALABRA: precios oficiales, qué incluye
// cada servicio, promociones. Pedirle al modelo que "copie textual" no basta — antes o después
// parafrasea, se come un emoji o reordena una línea, y ahí ya no es el texto del negocio. Por eso
// el modelo sólo elige CUÁL corresponde (que es lo que sabe hacer) y el runtime devuelve el texto
// exacto sin dejarlo redactar: ver el corte en engine.js.
export function literalReplies(packageData) {
  const list = packageData?.agent?.literal_replies || [];
  return list.filter(item => item?.id && item?.text);
}

async function dashboardOrError(packageData) {
  // En producción usa Supabase; en preview local usa el estado local para poder ejercitar la tool.
  return getAgendaDashboard(packageData);
}

// La RPC de Supabase necesita una conversación real (za_conversations.id) para marcarla en handoff
// y encolar el outbox. El chat de prueba ("Probar" en /m, playground del dueño) nunca crea esa
// fila — sólo pasa una etiqueta de prueba como conversationId — así que ahí no corresponde llamar
// la RPC aunque Supabase esté conectado: se trata como preview, y quien registra el ticket en la
// Bandeja es el llamador (server.js), no esta función.
async function requestHandoff(reason, context) {
  if (agendaUsesSupabase() && isUuid(context.conversationId)) {
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_request_handoff', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ p_conversation_id: context.conversationId, p_reason: String(reason || '').slice(0, 800), p_caller_phone: normalizePhone(context.callerPhone), p_operation_key: context.operationKey ? `${String(context.operationKey).slice(0, 200)}:handoff-outbox` : null }) });
    const handoff = Array.isArray(result) ? result[0] : result;
    return { ok: true, action: 'handoff_requested', event_id: handoff?.event_id || null };
  }
  return { ok: true, action: 'handoff_requested', event_id: null, preview: true };
}

function ownerAppointment(dashboard, reference, callerPhone) {
  if (!callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para consultar o modificar la reserva.' };
  const appointment = dashboard.appointments.find(item => String(item.reference || '').toUpperCase() === String(reference || '').trim().toUpperCase());
  if (!appointment) return { error: 'not_found', message: 'No encontré esa reserva.' };
  if (!samePhone(appointment.customer_phone, callerPhone)) return { error: 'ownership_not_verified', message: 'No puedo modificar una reserva sin verificar que pertenece a este número.' };
  return { appointment };
}

// La referencia de una reserva no sobrevive entre turnos: el historial guarda el texto, no el
// resultado de las herramientas. Camilo (franciskom, 14-09-2026) pidió cambiar su hora, el primer
// intento sí tenía la referencia y el segundo, un turno después, ya no: "No encontré esa reserva"
// con su hora intacta. Si la referencia falta o no calza, se resuelve por el teléfono verificado.
async function resolveOwnedAppointment(packageData, dashboard, reference, callerPhone) {
  if (!callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para consultar o modificar la reserva.' };
  if (String(reference || '').trim()) {
    const owned = ownerAppointment(dashboard, reference, callerPhone);
    if (!owned.error || owned.error === 'ownership_not_verified') return owned;
  }
  const upcoming = await listUpcomingAppointmentsForPhone(packageData, callerPhone, { graceMinutes: 0 });
  if (!upcoming.length) return { error: 'not_found', message: 'Este número no tiene reservas próximas activas.' };
  if (upcoming.length > 1) return { error: 'which_appointment', message: 'El cliente tiene más de una reserva próxima: pregúntale cuál quiere cambiar, nombrando día y hora.', appointments: upcoming.map(item => ({ reference: item.reference, starts_at: item.starts_at })) };
  const match = (dashboard.appointments || []).find(item => item.id === upcoming[0].id || item.reference === upcoming[0].reference);
  return { appointment: match || { ...upcoming[0], customer_phone: callerPhone } };
}

// Una hora que el cliente dice tener y que no está en el sistema casi siempre la agendó el dueño
// por fuera (WhatsApp, Calendar). Antes el bot le decía "no aparece una reserva a tu nombre",
// ofrecía que el equipo lo contactara y no avisaba a nadie: el dueño nunca supo que el paciente
// no iba (franciskom, 08-10-2026). Ahora el aviso sale siempre, desde la herramienta.
function appointmentOutsideSystem(owned, action, args = {}) {
  if (owned?.error !== 'not_found') return owned;
  const wanted = action === 'cancel' ? 'cancelar su hora' : `cambiar su hora${args.date ? ` al ${args.date}` : ''}${args.time ? ` a las ${args.time}` : ''}`;
  return {
    error: 'not_in_system', action: 'owner_notified',
    owner_alert: `Un cliente quiere ${wanted}, pero esa hora no está en el sistema (seguramente la agendaste por fuera). Revísalo con él.`,
    message: 'Esa hora no está registrada acá, probablemente se agendó directo con Francisco. Ya se le avisó a Francisco para que la revise: díselo al cliente en una frase (que Francisco le confirma el cambio). No le digas que no tiene reserva ni le ofrezcas avisar: el aviso ya salió.'
  };
}

// Día y hora locales (lo que el modelo lee en hora_local) → instante. Antes el modelo mandaba un
// ISO con offset calculado por él, y Chile cambia de horario en septiembre: un offset viejo corre la
// hora una completa y la reserva choca con otra cosa del Calendar.
function localDateTimeToIso(date, time, timeZone) {
  const day = String(date || '').trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(String(time || '').trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !match) return null;
  return asIso(`${day}T${match[1].padStart(2, '0')}:${match[2]}`, timeZone);
}

// Un nombre con números o con forma de calle es una dirección leída como nombre (Rodolfo, 14-09:
// "Eduardo Ríos Mackenna 1544" terminó como "¿Cuál te dejo para Eduardo Ríos?").
const looksLikeAddress = value => /\d/.test(String(value || '')) || /^\s*(calle|pasaje|psje|avenida|av\.?|camino|villa|poblaci[oó]n|block|depto)(?![a-záéíóúñ])/i.test(String(value || ''));

// Modo ensayo, sólo para medir el comportamiento del agente contra la agenda real: las lecturas
// (disponibilidad, reservas) van de verdad, pero ninguna escritura toca la base ni manda la
// invitación de Google Calendar. El servidor nunca pasa este flag; lo usa el medidor.
const MUTATING_TOOLS = new Set(['create_appointment', 'cancel_appointment', 'reschedule_appointment', 'update_customer_profile']);

// Francisco, 09-10-2026: el bot agendo a "Claudia" sin apellido (y antes a otros dos como "pareja"). La
// herramienta ya pedia nombre y apellido en su descripcion y el modelo lo ignoro: se exige en codigo.
const surnameMissing = args => {
  const who = String(args.patient_name || args.customer_name || '').trim();
  return who.split(/\s+/).filter(word => /\p{L}{2,}/u.test(word)).length < 2;
};
const SURNAME_ERROR = { error: 'name_needs_surname', message: 'Falta el apellido: pide nombre y apellido de quien se atiende (no sirve "pareja", "mi mamá" ni solo el nombre de pila) y vuelve a intentar. Si ya sabes el apellido por la ficha o la conversación, pásalo completo. No confirmes la hora al cliente todavía.' };

// Datos que la confirmación de una reserva debe decir. Claudia (franciskom, 09-10-2026) agendó creyendo
// que era el centro médico de Buin y la confirmación solo decía "Box Buin": sede, valor y mapa de LA
// hora tomada, y una invitación explícita a corregir si no era el lugar que buscaba.
function confirmationData(packageData, locationName, service) {
  const price = Number(service?.price_clp) > 0 ? `$${Number(service.price_clp).toLocaleString('es-CL')}` : '';
  const tokens = normName(locationName).replace(/\(.*?\)/g, ' ').split(/\s+/).filter(word => word.length > 2);
  const mapLink = literalReplies(packageData).find(item => /ubicaci/i.test(item.id || '') && tokens.length && tokens.every(word => normName(`${item.id} ${item.when || ''}`).includes(word)))?.text?.match(/https?:\/\/\S+/)?.[0] || '';
  return {
    sede: locationName, valor_de_esta_hora: price, ...(mapLink ? { mapa: mapLink } : {}),
    instruccion: `Al confirmar, di en el mismo mensaje la sede exacta de su hora${price ? `, su valor (${price})` : ''}${mapLink ? ' y el link del mapa' : ''}, y termina invitándolo a corregir: si buscaba otra sede o lugar, que te avise y lo cambias. Si en la conversación apareció el valor de otra sede o servicio, aclara que ese no es el de esta hora.`
  };
}

export async function executeAgendaTool(packageData, name, args = {}, context = {}) {
  if (context.dryRun === true && MUTATING_TOOLS.has(name)) {
    if (name === 'create_appointment') {
      if (surnameMissing(args)) return SURNAME_ERROR;
      if (looksLikeAddress(args.customer_name) || looksLikeAddress(args.patient_name)) return { error: 'name_looks_like_address', message: 'Ese nombre parece una dirección, no una persona. Pídele al cliente su nombre y apellido; la dirección va en address.' };
      const dryService = (packageData.solutions?.agenda?.config?.services || []).find?.(item => normName(item.name) === normName(args.service)) || null;
      return { ok: true, action: 'created', dry_run: true, para_la_confirmacion: confirmationData(packageData, args.location || '', dryService), received: args, appointment: { status: 'confirmed', reference: 'ZA-ENSAYO', starts_at: `${args.date}T${args.time}`, cuando_local: `${args.date} ${args.time}` } };
    }
    if (name !== 'reschedule_appointment') return { ok: true, action: { cancel_appointment: 'cancelled', update_customer_profile: 'profile_updated' }[name], dry_run: true, received: args };
  }
  try {
    const config = agendaConfig(packageData);
    if (!config) return { error: 'agenda_disabled' };
    const dashboard = await dashboardOrError(packageData);
    if (dashboard.error) return dashboard;
    if (name === 'get_availability') {
      const resourceMatch = resolveCatalogItem(dashboard.catalog.resources, args.resource);
      if (resourceMatch.ambiguous) return { error: 'ambiguous_resource', message: 'Más de un profesional calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: resourceMatch.ambiguous.map(item => item.name) };
      const resource = resourceMatch.item;
      if (!resource) return { error: 'catalog_not_found', message: 'Ese profesional no está en el catálogo. Ofrece sólo los disponibles.', available_resources: dashboard.catalog.resources.map(item => item.name) };
      let service = null;
      if (args.service) {
        const serviceMatch = resolveCatalogItem(dashboard.catalog.services, args.service);
        if (serviceMatch.ambiguous) return { error: 'ambiguous_service', message: 'Más de un servicio calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: serviceMatch.ambiguous.map(item => item.name) };
        service = serviceMatch.item;
      }
      if (!service && args.location) {
        // Sin servicio exacto, sólo sede: elige el servicio agendable de esa sede con MAYOR
        // duración (nunca ofrece un horario que le quede corto al servicio real que se termine
        // pidiendo — la diferencia entre servicios de una misma sede es de minutos, no cambia si
        // hay o no bloque libre). Confirmado con Daniel: lo único que realmente cambia la
        // viabilidad del horario es la sede (el traslado a domicilio necesita más bloque).
        const query = normName(args.location);
        const candidates = (dashboard.catalog.services || [])
          .filter(item => item.bookable !== false)
          .filter(item => normName(item.name).includes(query))
          .filter(item => (resource.services || []).some(n => normName(n) === normName(item.name)));
        service = candidates.sort((a, b) => (Number(b.duration_minutes) || 0) - (Number(a.duration_minutes) || 0))[0] || null;
      }
      // La sede que pidió el cliente puede existir pero no agendarse por este canal (la administra
      // un tercero). Antes se caía en "catalog_not_found", un error pensado para cuando falta el
      // dato — y el modelo, al recibirlo, seguía pidiéndole el servicio al cliente como si la hora
      // fuera posible, hasta dejarlo en un callejón sin salida. Si TODOS los servicios de esa sede
      // están marcados no agendables, la sede tampoco lo es: se dice de frente y se lo redirige.
      if (!service && args.location) {
        const query = normName(args.location);
        const inLocation = (dashboard.catalog.services || []).filter(item => normName(item.name).includes(query));
        if (inLocation.length && inLocation.every(item => item.bookable === false)) {
          const note = inLocation.find(item => item.redirect_note)?.redirect_note;
          return { ok: true, action: 'not_bookable_here', message: `${note || 'Esa sede no se agenda por este canal.'} Dile al cliente que esa hora la tiene que coordinar directamente con ese centro, y ofrécele agendar en las sedes que sí maneja Francisco.` };
        }
      }
      if (!service) return { error: 'catalog_not_found', message: 'Indica la sede (Box Buin o domicilio) para poder buscar hora, o el nombre exacto del servicio si el cliente ya lo dijo.', available_services: dashboard.catalog.services.map(item => item.name) };
      // Servicio marcado `bookable:false`: no lo maneja este negocio (ej. atención en un centro
      // de terceros) — no tiene sentido mostrar "disponibilidad" propia para algo que no se agenda acá.
      if (service.bookable === false) return { ok: true, action: 'not_bookable_here', message: service.redirect_note || `"${service.name}" no se agenda por este canal — indícale al cliente que coordine directamente con ese lugar.` };
      // La RPC de reserva (za_request_appointment) sí valida que el recurso realmente haga este
      // servicio (za_resource_services), pero get_availability no lo comprobaba — podía mostrar un
      // día completo de horarios "disponibles" para un profesional que ni siquiera ofrece ese
      // servicio, y recién fallar al intentar reservar. Sólo importa para negocios con más de un
      // profesional con servicios distintos (franciskom tiene uno solo que hace los tres).
      if (!(resource.services || []).some(name => normName(name) === normName(service.name))) {
        return { error: 'service_not_offered_by_resource', message: `"${resource.name}" no ofrece "${service.name}". Ofrece sólo servicios que ese profesional realmente hace.`, resource_services: resource.services || [] };
      }
      const zoneBlock = homeZoneBlock(config, service, args.location, args.comuna, context.clientTexts);
      if (zoneBlock) return zoneBlock;
      const slots = await getAvailableSlots(packageData, { service: service.name, resource: resource.name, date: args.date });
      const tz = config.timezone || 'America/Santiago';
      const hourFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      // Lo que el cliente dijo que no puede se filtra acá y no en el criterio del modelo: con la regla
      // sólo en el prompt, a Vicente (entrena 17:30-22:30) se le seguía ofreciendo las 19:00 en 2 de
      // 3 intentos (replay 08-10-2026).
      const toMinutes = value => { const m = String(value || '').match(/^(\d{1,2}):?(\d{2})?$/); return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null; };
      const blocked = (Array.isArray(args.fuera_de) ? args.fuera_de : [])
        .map(range => ({ from: toMinutes(range?.desde), to: toMinutes(range?.hasta) }))
        .filter(range => range.from !== null && range.to !== null && range.from !== range.to);
      // La sesión dura 45-60 min: una hora que empieza antes de su compromiso pero lo pisa tampoco sirve
      // (a quien entrena desde las 17:30 se le ofrecían las 17:00, 09-10-2026).
      const sessionMinutes = Number(service.duration_minutes) || 60;
      const isBlocked = local => {
        const start = toMinutes(local), end = start + sessionMinutes;
        return blocked.some(({ from, to }) => (from < to
          ? start < to && end > from
          : (start < 1440 && end > from) || (start < to)));
      };
      const allSlots = slots.map(iso => ({ at: iso, hora_local: hourFmt.format(new Date(iso)) }));
      const availableSlots = allSlots.filter(slot => !isBlocked(slot.hora_local));
      if (allSlots.length && !availableSlots.length) {
        return { ok: true, date: args.date, dia: dayLabel(args.date, tz), available_slots: [], total_disponibles: 0, descartadas_por_horario_del_cliente: allSlots.length, nota: 'Ese día hay horas, pero ninguna calza con el horario que dijo el cliente. Consulta otro día pasando el mismo fuera_de; no le ofrezcas las descartadas.' };
      }
      // Para ofrecer primero se prefieren horas que el agente puede cerrar solo: una hora dentro de
      // una franja de riesgo (ej. cuando Francisco puede estar en Eleva Salud) pasa a confirmación
      // manual al reservarla, así que ofrecerla de entrada es prometer algo que no depende del
      // agente. Siguen siendo reservables si el cliente las pide (están en available_slots); sólo
      // si el día no tiene otras, se ofrecen igual.
      for (const slot of availableSlots) {
        if (findRiskWindow(packageData, resource.name, slot.at)) slot.requiere_confirmacion = true;
      }
      const closableSlots = availableSlots.filter(slot => !slot.requiere_confirmacion);
      const shortlist = pickSlotShortlist(closableSlots.length ? closableSlots : availableSlots);
      return {
        ok: true, service: service.name, resource: resource.name, date: args.date, timezone: tz,
        // El día ya resuelto en código: el modelo lo copia tal cual en vez de calcular si es "hoy",
        // "mañana" o qué día de la semana cae (ver turn-guards.js).
        dia: dayLabel(args.date, tz),
        available_slots: availableSlots,
        total_disponibles: availableSlots.length,
        ofrecer_primero: shortlist.map(slot => slot.hora_local),
        nota: availableSlots.length > shortlist.length
          ? `TODAS las horas libres de ese día son las de "available_slots" (${availableSlots.length} en total, de ${availableSlots[0].hora_local} a ${availableSlots[availableSlots.length - 1].hora_local}). En tu mensaje ofrece sólo las de "ofrecer_primero" para no abrumar, y dile que hay más horas si ninguna le acomoda. Si el cliente pide otra hora, búscala en "available_slots": si está ahí, está libre y la agendas sin decir que no hay. Nunca ofrezcas una hora que no esté en "available_slots". Las marcadas "requiere_confirmacion" no las ofrezcas tú: al reservarlas quedan esperando confirmación manual del profesional; sólo se toman si el cliente pide exactamente esa hora.`
          : 'Estas son todas las horas libres del día: ofrécelas tal cual, sin agregar ninguna más.',
        como_nombrar_el_dia: `Al ofrecer estas horas nombra el día exactamente como "${dayLabel(args.date, tz)}" (puedes acortarlo a "${dayLabel(args.date, tz).split(' ').slice(0, 2).join(' ')}"), nunca con otro "hoy"/"mañana" ni otro día de la semana.`
      };
    }
    if (name === 'get_my_appointment') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para esta conversación.' };
      const appointments = dashboard.appointments.filter(item => isActiveAgendaAppointment(item) && samePhone(item.customer_phone, context.callerPhone));
      const tz = config.timezone || 'America/Santiago';
      const whenFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
      // Vacío no significa "no tiene hora": el dueño agenda también por fuera. Si el cliente dice
      // tenerla, cambiar/cancelar igual es el camino, porque esas herramientas avisan al dueño.
      const outside = appointments.length ? {} : { nota: 'Acá no hay horas registradas para este número, pero el dueño también agenda por fuera. Si el cliente dice que tiene una hora, créele: NO le digas que no tiene reserva. Si quiere cambiarla o cancelarla, llama reschedule_appointment (con el día y la hora nuevos que pidió) o cancel_appointment de todas formas: eso le avisa a Francisco para que lo confirme.' };
      return { ok: true, timezone: tz, appointments: appointments.map(item => ({ reference: item.reference, status: item.status, starts_at: item.starts_at, cuando_local: whenFmt.format(new Date(item.starts_at)), service: item.service, resource: item.resource, location: item.location })), ...outside };
    }
    if (name === 'update_customer_profile') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para esta conversación.' };
      try {
        const saved = await updateCustomerIntakeRecord(packageData, context.callerPhone, { email: args.email, rut: args.rut }, {
          source: 'whatsapp', sourceMessageId: context.messageId, operationKey: context.operationKey, createdBy: 'agent'
        });
        // Una versión vieja de la función SQL descartó el RUT un mes entero mientras esto decía
        // "profile_updated": sólo se confirma lo que la base dice haber guardado.
        if (Array.isArray(saved?.stored_fields)) {
          const missing = ['email', 'rut'].filter(key => String(args[key] || '').trim() && !saved.stored_fields.includes(key));
          if (missing.length) {
            console.error('[intake] la base no guardó', missing.join(', '));
            return { error: 'profile_update_failed', message: `No quedó guardado: ${missing.join(', ')}. No le digas al cliente que quedó registrado.` };
          }
        }
        return { ok: true, action: 'profile_updated' };
      } catch (error) {
        return { error: 'profile_update_failed', message: error.message };
      }
    }
    if (name === 'create_appointment') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No puedo crear una reserva por WhatsApp sin el teléfono verificado del remitente.' };
      const serviceMatch = resolveCatalogItem(dashboard.catalog.services, args.service);
      const resourceMatch = resolveCatalogItem(dashboard.catalog.resources, args.resource);
      if (serviceMatch.ambiguous) return { error: 'ambiguous_service', message: 'Más de un servicio calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: serviceMatch.ambiguous.map(item => item.name) };
      if (resourceMatch.ambiguous) return { error: 'ambiguous_resource', message: 'Más de un profesional calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: resourceMatch.ambiguous.map(item => item.name) };
      const service = serviceMatch.item;
      const resource = resourceMatch.item;
      if (!service || !resource) return { error: 'catalog_not_found', message: 'Ese servicio o profesional no está en el catálogo. Ofrece sólo los disponibles.', available_services: dashboard.catalog.services.map(item => item.name), available_resources: dashboard.catalog.resources.map(item => item.name) };
      // Igual que en get_availability: un servicio no gestionado por este negocio nunca se agenda
      // ni deriva a handoff — se redirige directo, sin crear ningún rastro de reserva/ticket.
      if (service.bookable === false) return { ok: true, action: 'not_bookable_here', message: service.redirect_note || `"${service.name}" no se agenda por este canal — indícale al cliente que coordine directamente con ese lugar.` };
      // Un reintento de la misma operación debe ser idempotente, pero un cliente sí puede reservar
      // varias sesiones futuras del mismo servicio. Sólo se deduplica la cita exacta.
      const zoneBlockCreate = homeZoneBlock(config, service, args.location, args.comuna, context.clientTexts);
      if (zoneBlockCreate) return zoneBlockCreate;
      if (surnameMissing(args)) return SURNAME_ERROR;
      if (looksLikeAddress(args.customer_name) || looksLikeAddress(args.patient_name)) return { error: 'name_looks_like_address', message: 'Ese nombre parece una dirección, no una persona. Pídele al cliente su nombre y apellido; la dirección va en address.' };
      const requestedIso = args.date && args.time ? localDateTimeToIso(args.date, args.time, config.timezone || 'America/Santiago') : asIso(args.starts_at, config.timezone || 'America/Santiago');
      const location = findByName(dashboard.catalog.locations, args.location);
      // Validar que la hora pedida sea futura y cumpla el aviso mínimo ANTES de mirar franjas de
      // riesgo: findRiskWindow sólo compara día-de-semana + hora, así que una fecha pasada que cae
      // en un día "riesgoso" (ej. un lunes que ya pasó) se colaba directo a needs_manual_confirmation
      // sin pasar nunca por el guard real de fecha pasada que sí tiene createAgendaAppointment más
      // abajo — se creaba un ticket de handoff para una hora que ya ocurrió.
      const requestedTime = new Date(requestedIso || '').getTime();
      if (!Number.isFinite(requestedTime)) return { error: 'invalid_starts_at', message: 'La hora solicitada no es una fecha válida.' };
      if (requestedTime < Date.now()) return { error: 'starts_at_in_past', message: 'Esa fecha/hora ya pasó. Pide una fecha futura y vuelve a intentar.' };
      const minimumNoticeMs = Number(config.rules?.minimum_notice_hours || 0) * 3_600_000;
      if (requestedTime - Date.now() < minimumNoticeMs) return { error: 'minimum_notice_not_met', message: `Esa hora está demasiado próxima — se necesitan al menos ${config.rules?.minimum_notice_hours || 0} horas de aviso. Ofrece un horario más adelante.` };
      const maximumAdvanceMs = Number(config.rules?.maximum_advance_days || 730) * 86_400_000;
      if (requestedTime - Date.now() > maximumAdvanceMs) return { error: 'maximum_advance_exceeded', message: `Esa hora supera la anticipación máxima de ${config.rules?.maximum_advance_days || 730} días. Ofrece una fecha más cercana.` };
      const existing = (dashboard.appointments || []).find(item => isActiveAgendaAppointment(item)
        && samePhone(item.customer_phone, context.callerPhone)
        && normName(item.service) === normName(service.name)
        && normName(item.resource) === normName(resource.name)
        && new Date(item.starts_at).getTime() === requestedTime);
      if (existing) {
        const existingTz = config.timezone || 'America/Santiago';
        const existingWhen = new Intl.DateTimeFormat('es-CL', { timeZone: existingTz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(existing.starts_at));
        return { ok: true, action: 'already_has_exact_appointment', appointment: { reference: existing.reference, starts_at: existing.starts_at, cuando_local: existingWhen, status: existing.status }, message: `Esa cita exacta ya existe (${existingWhen}, ref. ${existing.reference}). No se creó un duplicado.` };
      }
      // Franja de riesgo: el profesional podría estar comprometido en otro lugar a esa hora (no
      // siempre, depende de un tercero), así que no se agenda solo — se deriva para que confirme.
      const riskWindow = findRiskWindow(packageData, resource.name, requestedIso);
      if (riskWindow) {
        const handoffReason = `Cliente ${context.callerPhone || ''} pidió agendar "${service.name}" el ${new Date(requestedIso).toLocaleString('es-CL')} — cae en franja de riesgo (${riskWindow.reason || 'posible compromiso en otro lugar'}). Confirma disponibilidad real y agenda manualmente.`;
        const handoff = await requestHandoff(handoffReason, context);
        // Sugerencia de respaldo: buscar una hora libre ESE MISMO día en otro servicio que el
        // mismo profesional sí controla del todo (no cae en ninguna franja de riesgo), para que
        // el cliente no se quede sin ninguna opción mientras espera la confirmación.
        const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone || 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(requestedIso));
        let alternative = null;
        for (const altServiceName of resource.services || []) {
          if (altServiceName === service.name) continue;
          // Nunca ofrecer como "alternativa segura" un servicio que tampoco se agenda por este canal.
          const altService = findByName(dashboard.catalog.services, altServiceName);
          if (altService?.bookable === false) continue;
          const slots = await getAvailableSlots(packageData, { service: altServiceName, resource: resource.name, date: sameDay }).catch(() => []);
          const safeSlot = slots.find(iso => !findRiskWindow(packageData, resource.name, iso));
          if (safeSlot) { alternative = { service: altServiceName, starts_at: safeSlot }; break; }
        }
        const tz = config.timezone || 'America/Santiago';
        const alternativeText = alternative
          ? ` Como respaldo, hoy mismo hay hora libre a las ${new Intl.DateTimeFormat('es-CL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(alternative.starts_at))} para "${alternative.service}" — ofrécesela como alternativa segura si el cliente prefiere no esperar la confirmación.`
          : '';
        return { ...handoff, action: 'needs_manual_confirmation', message: `Explícale al cliente que ese horario necesita verificación manual (${riskWindow.reason || 'depende de una condición externa'}) y que el equipo retomará la conversación para avisar si queda disponible. No confirmes la reserva tú mismo.${alternativeText}` };
      }
      // Reusa createAgendaAppointment (ya cubre local/Supabase y el bump de segmento del
      // cliente) en vez de duplicar la llamada RPC — antes esta rama saltaba ese bump.
      const appointment = await createAgendaAppointment(packageData, {
        customer_name: String(args.customer_name || '').trim(), patient_name: String(args.patient_name || '').trim(), customer_phone: context.callerPhone, customer_email: String(args.email || '').trim(),
        customer_rut: String(args.rut || '').trim(), customer_address: String(args.address || '').trim(),
        customer_age: args.age, customer_occupation: String(args.occupation || '').trim(),
        customer_medical_history: String(args.medical_history || '').trim(), customer_extra_symptoms: String(args.extra_symptoms || '').trim(),
        service: service.name, resource: resource.name, location: location?.name || '', starts_at: requestedIso, notes: String(args.notes || '').trim()
      }, 'whatsapp');
      // La ficha es opcional por diseño y va DESPUÉS de que la reserva ya existe: si falla, la
      // hora igual quedó tomada, así que nunca puede propagar su error hacia arriba. Sin este
      // catch, un problema de ficha (cliente que no calza, migración no aplicada en el Supabase
      // del cliente) hacía que la herramienta completa se reportara como fallida y el agente le
      // dijera al paciente "no hice cambios en tu reserva" con la cita ya creada y el bloque
      // ocupado — el peor desenlace posible: el paciente cree que no tiene hora y nadie lo sabe.
      if (args.email || args.rut || args.age != null || args.occupation || args.medical_history || args.extra_symptoms) {
        try {
          await updateCustomerIntakeRecord(packageData, context.callerPhone, args, {
            source: 'whatsapp', sourceMessageId: context.messageId,
            operationKey: context.operationKey ? `${context.operationKey}:appointment-intake` : `appointment:${appointment.id || appointment.reference}`,
            createdBy: 'agent'
          });
        } catch (error) {
          console.error('[agenda] la reserva se creó pero no se pudo guardar la ficha del cliente:', error.message);
        }
      }
      const createdTz = config.timezone || 'America/Santiago';
      const createdWhen = new Intl.DateTimeFormat('es-CL', { timeZone: createdTz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(appointment.starts_at));
      // Los datos de ficha (correo/edad/ocupación/antecedentes/síntomas) son opcionales y NUNCA
      // deben bloquear la creación de la reserva. Se piden DESPUÉS de que la herramienta ya tuvo
      // éxito (acá, con un hint), nunca antes — pedirlos como precondición en el mismo turno que
      // la confirmación hacía que el modelo esperara la respuesta en vez de agendar (medido con
      // gpt-4o-mini: se quedaba pidiendo estos datos indefinidamente y nunca llamaba la herramienta,
      // incluso con el cliente diciendo explícitamente "agéndala ya").
      const missingIntake = [!args.rut ? 'RUT (para la boleta)' : '', !args.email ? 'correo (para la invitación al calendario)' : ''].filter(Boolean);
      // Claudia (franciskom, 09-10-2026) vio en septiembre el bloque con los $30.000 de otro centro y hoy
      // agendó en el Box sin que nadie le dijera cuánto cuesta ESA sede: lo preguntó después y la
      // respuesta mezclaba ambos montos. La confirmación lleva sede y valor de la hora tomada.
      const forConfirmation = confirmationData(packageData, location?.name || '', service);
      return { ok: true, action: 'created', para_la_confirmacion: forConfirmation, appointment: { reference: appointment.reference, starts_at: appointment.starts_at, cuando_local: createdWhen, status: appointment.status }, ...(missingIntake.length ? { ask_intake_details: true, intake_prompt: `La reserva ya quedó creada. En este mismo mensaje, al confirmar la hora, pide una sola vez lo que falta: ${missingIntake.join(' y ')}. Nada más: ni edad, ni ocupación, ni antecedentes, ni síntomas — eso lo conversa Francisco en la consulta. Si no lo manda, no insistas. Cuando lo mande, guárdalo con update_customer_profile.` } : {}) };
    }
    if (name === 'cancel_appointment') {
      const owned = await resolveOwnedAppointment(packageData, dashboard, args.reference, context.callerPhone); if (owned.error) return appointmentOutsideSystem(owned, 'cancel', args);
      if (!isActiveAgendaAppointment(owned.appointment)) return { error: 'invalid_status', message: 'Esa reserva ya no se puede cancelar.' };
      await updateAgendaAppointment(packageData, owned.appointment.id, 'cancelled');
      // El dueño se entera de toda hora que se libera: la de Claudia (09-10-2026) se anuló y él no
      // supo nada hasta revisar el Calendar.
      const cancelledWhen = new Intl.DateTimeFormat('es-CL', { timeZone: config.timezone || 'America/Santiago', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(owned.appointment.starts_at));
      return { ok: true, action: 'cancelled', reference: owned.appointment.reference, cuando_local: cancelledWhen, owner_alert: `El cliente anuló su hora ${owned.appointment.reference} (${cancelledWhen}). El horario quedó libre.` };
    }
    if (name === 'reschedule_appointment') {
      const owned = await resolveOwnedAppointment(packageData, dashboard, args.reference, context.callerPhone); if (owned.error) return appointmentOutsideSystem(owned, 'reschedule', args);
      if (!isActiveAgendaAppointment(owned.appointment)) return { error: 'invalid_status', message: 'Esa reserva ya no se puede reagendar.' };
      const current = owned.appointment;
      const tz = config.timezone || 'America/Santiago';
      const whenFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
      const hourFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const newIso = args.date && args.time ? localDateTimeToIso(args.date, args.time, tz) : asIso(args.new_starts_at, tz);
      if (!newIso) return { error: 'invalid_datetime', message: 'Falta el día (YYYY-MM-DD) o la hora (HH:MM) nueva.' };
      const newTime = new Date(newIso).getTime();
      const newDay = dayFmt.format(new Date(newIso));
      const original = { reference: current.reference, cuando_local: whenFmt.format(new Date(current.starts_at)) };
      // Alternativas reales del mismo día, con la misma disponibilidad que usa get_availability:
      // lo que se ofrece después de un rechazo tiene que poder tomarse.
      const alternativesSameDay = async () => {
        const slots = await getAvailableSlots(packageData, { service: current.service, resource: current.resource, date: newDay }).catch(() => []);
        return slots.filter(iso => new Date(iso).getTime() !== newTime)
          .sort((a, b) => Math.abs(new Date(a).getTime() - newTime) - Math.abs(new Date(b).getTime() - newTime))
          .slice(0, 3).sort().map(iso => hourFmt.format(new Date(iso)));
      };
      const unchanged = async (reason, extra = {}) => ({
        error: reason, original_unchanged: true, original, dia_pedido: newDay,
        alternativas_mismo_dia: await alternativesSameDay(),
        guidance: 'La reserva original sigue igual, no se perdió. Díselo claro y ofrécele las alternativas reales de este día; si no le sirven, consulta otro día con get_availability. Nunca la canceles para cambiarla.',
        ...extra
      });
      if (newTime === new Date(current.starts_at).getTime()) {
        return { ok: true, action: 'already_matched', reference: current.reference, cuando_local: original.cuando_local, message: 'La reserva ya está en ese horario; no hubo que cambiar nada.' };
      }
      if (newTime < Date.now()) return unchanged('Esa hora ya pasó.');
      // Se verifica contra la disponibilidad real ANTES de escribir. Si la hora nueva se cruza con la
      // propia reserva (moverla media hora el mismo día), la disponibilidad la ve ocupada por ella
      // misma: en ese caso decide la función atómica de la base.
      const duration = Number((dashboard.catalog.services || []).find(item => normName(item.name) === normName(current.service))?.duration_minutes) || 60;
      const overlapsItself = Math.abs(newTime - new Date(current.starts_at).getTime()) < duration * 60_000;
      if (!overlapsItself) {
        const slots = await getAvailableSlots(packageData, { service: current.service, resource: current.resource, date: newDay }).catch(() => null);
        if (Array.isArray(slots) && !slots.some(iso => new Date(iso).getTime() === newTime)) {
          return unchanged(`Las ${hourFmt.format(new Date(newIso))} de ese día no están disponibles.`);
        }
      }
      if (context.dryRun === true) {
        return { ok: true, action: 'rescheduled', dry_run: true, reference: current.reference, cuando_local: whenFmt.format(new Date(newIso)), received: args };
      }
      let appointment;
      try {
        appointment = await rescheduleAgendaAppointment(packageData, { id: current.id, new_starts_at: newIso, requester_phone: context.callerPhone });
      } catch (error) {
        const message = String(error.message || 'No se pudo cambiar la hora.');
        const availabilityProblem = /ocupad|disponib|bloquead|aviso m[ií]nimo|anticipaci|pasado|conflict|overlap|solap/i.test(message);
        return unchanged(message, availabilityProblem ? {} : {
          owner_alert: `No pude cambiar la hora de ${current.reference} (${original.cuando_local}) a ${whenFmt.format(new Date(newIso))}: ${message.slice(0, 160)}. La reserva original sigue igual.`,
          guidance: 'Hubo un problema técnico al cambiarla. Dile que su hora original sigue igual y que Francisco ya quedó avisado para dejarle el cambio; no le ofrezcas otras horas.'
        });
      }
      const riskHandoff = appointment.risk_window
        ? await requestHandoff(`La reagenda ${appointment.reference || current.reference} al ${appointment.starts_at} requiere confirmar disponibilidad humana: ${appointment.risk_window.reason || 'franja de riesgo configurada'}.`, context)
        : null;
      return {
        ok: true,
        action: appointment.risk_window ? 'rescheduled_needs_manual_confirmation' : 'rescheduled',
        reference: appointment.reference || current.reference,
        starts_at: appointment.starts_at,
        cuando_local: whenFmt.format(new Date(appointment.starts_at)),
        status: appointment.status,
        ...(appointment.risk_window ? {} : { owner_alert: `El cliente cambió su hora ${appointment.reference || current.reference}: de ${original.cuando_local} a ${whenFmt.format(new Date(appointment.starts_at))}.` }),
        ...(riskHandoff?.event_id ? { event_id: riskHandoff.event_id } : {}),
        ...(appointment.risk_window ? { message: 'La nueva hora quedó pendiente de confirmación humana porque cae en una franja de riesgo.' } : {})
      };
    }
    if (name === 'request_human_handoff') {
      return requestHandoff(args.reason, context);
    }
    // Aviso blando: NO toca el estado de la conversación (el agente sigue atendiendo). Quien crea
    // el ticket de la Bandeja y manda el aviso al dueño es el llamador (server.js), igual que con
    // el handoff en preview — acá sólo se confirma al modelo que el aviso quedó pedido.
    if (name === 'ignorar_mensaje_ajeno') {
      return { ok: true, action: 'silence', message: 'No se envía nada en este turno.' };
    }
    if (name === 'no_intervenir') {
      return { ok: true, action: 'silence', message: 'No se envía nada en este turno.' };
    }
    if (name === 'avisar_al_dueno') {
      return { ok: true, action: 'owner_alerted', message: 'El dueño quedó avisado. Sigue atendiendo y ofreciendo hora con normalidad; no digas que la conversación quedó en pausa ni que dejarás de responder.' };
    }
    return { error: 'unknown_tool' };
  } catch (error) {
    return { error: 'tool_failed', message: error.message };
  }
}
