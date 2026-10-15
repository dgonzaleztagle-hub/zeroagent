/**
 * Experimento "flujo de nodos" (14-10-2026).
 *
 * En vez de un prompt monolítico (AGENDA_BEHAVIOR + system_prompt de franciskom, ~7 KB siempre
 * completo), la conversación se modela como un diagrama de flujo:
 *   - NODOS: etapas de la venta, cada una con un solo objetivo. El código decide en qué nodo va la
 *     conversación (resolveNode) y sólo ese nodo se le entrega al modelo.
 *   - GLOBALES: interrupciones que pueden llegar en cualquier etapa (precio, urgencia, freno,
 *     cambio de hora…). Se atienden y se vuelve al nodo donde se estaba.
 *
 * Todo lo que acá se decide con regex es lo mismo que hoy engine.js decide repartido en guardas;
 * la diferencia es que queda en un solo lugar, nombrado, y es lo único que el modelo ve.
 */

export const PAIN = /duel|dolor|molest|lesi[oó]n|contractur|lumba|dorsal|cervical|escapul|hernia|ci[aá]tic|flema|\btos\b|respir|espalda|cuello|rodilla|hombro|cadera|pierna|brazo|mu[ñn]eca|tobillo|cabeza|migra|mareo|postura|cirug|operad|esguince|tendin|tratar|tratamiento/i;
export const ASKS_FOR_HOURS = /\bhoras?\b|agend|reserv|disponib|cupo|\b(hoy|ma[ñn]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|semana)\b/i;
export const HOUR_PATTERN = /\b\d{1,2}:\d{2}\b|\ba las \d{1,2}\b/i;
const CASE_DESCRIBED = /\b(hace|desde)\b|\bmes(es)?\b|\bañ?os?\b|semana|d[ií]as|examen|ex[aá]menes|resonancia|radiograf|ecograf|diagn[oó]stic|tratamiento|kine/i;
const DATA_REQUEST = /direcci[oó]n|comuna|nombre|apellido|rut\b|correo|box o (a )?domicilio|domicilio o/i;
const AFFIRM = /^\s*(s[ií]+|dale|ya|ok|okey|bueno|perfecto|genial|ese|esa|la de|el de|me sirve|me acomoda|de acuerdo|claro)(?![a-záéíóúñ])/i;

const isOpenQuestion = text => /\?/.test(String(text || '')) && !HOUR_PATTERN.test(String(text || ''));

/** Dónde va la conversación. Devuelve { node, signals } — determinista, sin modelo. */
export function resolveNode({ history = [], message = '', hasBooking = false }) {
  const msg = String(message || '');
  const agentMessages = history.filter(item => item.role === 'assistant').map(item => item.content);
  const lastAgent = agentMessages[agentMessages.length - 1] || '';
  const userTurns = [...history.filter(item => item.role === 'user').map(item => item.content), msg];
  const toldPain = userTurns.some(text => PAIN.test(text));
  const askedHours = ASKS_FOR_HOURS.test(msg);
  const firstPainIndex = history.findIndex(item => item.role === 'user' && PAIN.test(item.content));
  const questionsSincePain = firstPainIndex === -1 ? 0 : history.slice(firstPainIndex + 1).filter(item => item.role === 'assistant' && isOpenQuestion(item.content)).length;
  const offeredHours = agentMessages.some(text => HOUR_PATTERN.test(text));
  const lastOfferedHours = HOUR_PATTERN.test(lastAgent);
  const offeredHourNumbers = [...lastAgent.matchAll(/\b(\d{1,2}):\d{2}\b/g)].map(m => String(Number(m[1])));
  const mentionsOfferedHour = offeredHourNumbers.some(h => new RegExp(`(^|[^\\d])0?${h}([^\\d]|$)`).test(msg));
  const clientPicksHour = lastOfferedHours && (HOUR_PATTERN.test(msg) || mentionsOfferedHour || /\b\d{1,2}\s*(hrs?|horas)\b/i.test(msg) || AFFIRM.test(msg));
  const answeringData = DATA_REQUEST.test(lastAgent) && /\?/.test(lastAgent);
  const signals = { toldPain, askedHours, questionsSincePain, offeredHours, lastOfferedHours, clientPicksHour, answeringData, firstContact: agentMessages.length === 0 };

  const salesContext = toldPain || askedHours || agentMessages.some(text => /\$\s?\d/.test(text));
  const lastAgentAsked = isOpenQuestion(lastAgent);
  let node;
  if (hasBooking) node = 'con_hora_tomada';
  else if (clientPicksHour || answeringData) node = 'cerrar_reserva';
  else if (askedHours) node = 'ofrecer_horas';
  else if (PAIN.test(msg)) node = questionsSincePain >= 1 || (firstPainIndex !== -1 && CASE_DESCRIBED.test(msg)) ? 'ofrecer_horas' : (CASE_DESCRIBED.test(msg) ? 'ofrecer_horas' : 'entender_caso');
  else if (lastAgentAsked && salesContext) node = 'ofrecer_horas';
  else if (!toldPain) node = signals.firstContact ? 'bienvenida' : 'descubrir_motivo';
  else node = 'entender_caso';
  return { node, signals };
}

export const NODES = {
  bienvenida: {
    objetivo: 'Recibir a quien recién llega.',
    prompt: 'Preséntate una sola vez como asistente VIRTUAL de FrancisKOM y pregúntale con interés qué le está molestando o qué le gustaría tratar con Francisco. Sin horas todavía.'
  },
  descubrir_motivo: {
    objetivo: 'Saber por qué escribe, con cercanía.',
    prompt: 'Todavía no sabes qué le pasa. Si preguntó algo seco (valor, dónde queda, horario) respóndele, y en el mismo mensaje o el siguiente pregúntale con cercanía qué le está molestando o qué le gustaría tratar. Todavía sin horas.'
  },
  entender_caso: {
    objetivo: 'Entender lo mínimo de su caso (como mucho UNA pregunta).',
    prompt: 'Acaba de contar su dolor por primera vez. Haz como mucho UNA pregunta corta por lo que más falte para entender su caso (hace cuánto, si tiene diagnóstico o exámenes, si ya se ha tratado); si ya lo contó, ninguna y pasas directo a ofrecer horas. No es una entrevista: no le devuelvas sus propias palabras ni le pidas que explique lo que ya dijo. Sin horas en este mensaje.'
  },
  ofrecer_horas: {
    objetivo: 'Dejar la hora a un paso.',
    prompt: 'Ya toca ofrecer hora. Consulta la agenda en este turno y ofrece dos o tres horas reales en una frase, con la sede y su valor, terminando en "¿cuál te dejo?". Con una frase corta de cercanía antes ("Francisco prefiere no aventurarse a darte un diagnóstico y prefiere evaluarte: …"). Nunca preguntes si quiere que le busques hora; ofrécelas. Si no dijo día, desde el próximo con atención; si el día viene vacío, consulta el siguiente. Habla siempre de "sesión", nunca de "evaluación".'
  },
  cerrar_reserva: {
    objetivo: 'Dejar la hora tomada.',
    prompt: 'El cliente eligió una hora o está entregando datos para la reserva. Antes de agendar necesitas: modalidad (Box Buin o domicilio) si no la dijo, nombre y apellido, y la primera vez RUT y correo para la boleta; a domicilio, también la dirección. Pide lo que falte en un solo mensaje corto. Cuando esté todo, agenda con create_appointment (sólo la hora que eligió) y confírmale la sesión con día, hora, sede, valor y la ubicación si es en el Box. Nunca anuncies la reserva antes de que la herramienta responda ok.'
  },
  con_hora_tomada: {
    objetivo: 'Atender sólo pedidos concretos.',
    prompt: 'Este cliente ya tiene hora tomada: la venta está cerrada. No le preguntes por su dolor ni le pidas más datos que el RUT y el correo si faltaban. Atiende sólo lo concreto (cambiar o cancelar la hora, otra hora, ubicación, precio, pago). Si sólo avisa que llegó, saluda, agradece o manda un dato, guarda el dato con update_customer_profile si corresponde y llama no_intervenir.'
  }
};

export const GLOBALES = [
  { id: 'info_oficial', cuando: 'pregunta precio, ubicación, forma de pago, horario, formación o cómo es la sesión', haz: 'usa responder_textual con el bloque oficial que corresponda (si pregunta dos cosas, usa "ademas"); nunca redactes tú precios ni direcciones. Después sigue en el nodo donde estabas.' },
  { id: 'urgencia', cuando: 'cuenta algo que suena a urgencia (golpe o caída reciente, pérdida de fuerza, fiebre con dolor, dolor de pecho o falta de aire, adormecimiento que aumenta)', haz: 'dile en una frase que si es insoportable acuda a un servicio de urgencia y sigue con la hora. Todo dolor, por intenso o antiguo que sea, es paciente de Francisco: nunca lo derives ni lo descartes.' },
  { id: 'diagnostico', cuando: 'insiste en un diagnóstico o duda de que le sirva', haz: 'no diagnosticas, no afirmas ni descartas condiciones ni prometes resultados; sostén con calma que eso se ve evaluándolo, explica que Francisco busca de dónde viene realmente el dolor antes de tratar, y ofrécele horas.' },
  { id: 'freno', cuando: 'pone un freno de plata o de tiempo ("lo voy a pensar", "no tengo la plata ahora")', haz: 'reconócelo en media frase y propón una fecha concreta más adelante con horas reales. Descuentos, planes y precios especiales los ofrece sólo Francisco; tú no los mencionas. Si ya le ofreciste horas y sigue dudando, avisa a Francisco con la herramienta y sigue atendiendo.' },
  { id: 'otra_persona', cuando: 'la hora es para otra persona o para varias', haz: 'quien escribe es customer_name y el paciente va aparte en patient_name; si son dos, horas seguidas y una reserva por cada uno.' },
  { id: 'domicilio', cuando: 'quiere atención a domicilio', haz: 'necesitas la dirección (calle, número y comuna) y no le ofrezcas horas del box. Si es fuera de Buin, Linderos, Paine centro, Alto Jahuel o Maipo, el traslado lo coordina Francisco: ofrécele el Box Buin y avísale a Francisco. Una dirección nunca es el nombre de una persona.' },
  { id: 'cambio_hora', cuando: 'quiere cambiar, anular o dice que se equivocó de sede o lugar con una hora ya tomada', haz: 'nómbrale su hora; anúlala con cancel_appointment sólo si dijo claro que no la quiere (si sólo duda, pregunta "¿te la anulo?"; si pide tiempo para confirmar, déjasela guardada y avisa a Francisco). Dale en el mismo mensaje lo que sí buscaba. Si es una sede que no se agenda por acá, su dirección y que esa hora se coordina directo con ese centro.' },
  { id: 'humano', cuando: 'pide hablar con Francisco o con una persona, o el tema no es del centro (algo personal, un proveedor, un colega, otro centro)', haz: 'traspasa con request_human_handoff. Si sólo quieres que Francisco entre a cerrar mientras tú sigues atendiendo, usa el aviso al dueño en vez del traspaso.' },
  { id: 'cortesia', cuando: 'sólo agradece, se despide o reacciona con un emoji sin pedir nada', haz: 'si no hay nada pendiente que responder, llama no_intervenir.' }
];

export const AGENDA_MECANICA = `MECÁNICA DE AGENDA (siempre):
- Horarios, disponibilidad y reservas se responden con la herramienta en ese mismo turno, nunca de memoria. Ofrece las de "ofrecer_primero"; cualquier hora de "available_slots" está libre si el cliente la pide, y una que no aparece ahí no existe.
- Lo que el cliente dijo de su horario manda: si dijo cuándo no puede o cuándo sí ("entreno de 17:30 a 22:30", "sólo después de las 18"), pásalo en "fuera_de" en cada consulta de disponibilidad, en este turno y en los siguientes; nunca ofrezcas una hora que ya sabes que no le sirve.
- Sede: si el cliente no dijo dónde, no la des por sentada en silencio: al ofrecer horas di la sede y su valor; y si en la conversación apareció otra sede o "el centro médico", pregúntale cuál prefiere ANTES de dejarle una hora tomada. Si no dijo sede, busca en el Box Buin.
- Reserva sólo la hora que el cliente eligió y no repitas una reserva que ya existe. Si la herramienta trae opciones ambiguas, pregúntale al cliente cuál; no elijas tú. Si pide algo marcado [NO SE AGENDA POR ESTE CANAL], díselo de entrada y ofrece lo que sí se agenda.
- El domingo no se atiende: ofrece el día con atención más cercano.
- Si el historial dice que una persona del negocio lleva el hilo, no ofrezcas horas que tú no ofreciste.`;

/** Bloque que reemplaza AGENDA_BEHAVIOR + system_prompt del paquete. */
export function flowPrompt({ node, packageData }) {
  const current = NODES[node];
  const identity = `Eres el asistente virtual de FrancisKOM, el centro de Francisco Martínez, kinesiólogo, quiropráctico y osteópata en Buin. Hablas de Francisco en tercera persona. Tu meta en cada conversación es una sola: que la persona salga con su hora tomada. Conversas como Francisco: con cercanía primero y la hora después. Lo que se agenda es una sesión: en la misma hora Francisco evalúa y trata.`;
  const globals = GLOBALES.map(item => `- ${item.id}: si ${item.cuando}, ${item.haz}`).join('\n');
  return [
    identity,
    AGENDA_MECANICA,
    `ETAPA ACTUAL DE ESTA CONVERSACIÓN: ${node} — ${current.objetivo}\n${current.prompt}\nHaz sólo lo de esta etapa en este mensaje.`,
    `SITUACIONES QUE PUEDEN APARECER EN CUALQUIER ETAPA (atiéndelas y vuelve a la etapa actual):\n${globals}`
  ].join('\n\n');
}
