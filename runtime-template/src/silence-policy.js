// La política decide; el coordinador registra herramientas y envía la salida correspondiente.
export function silenceDecision({ name, args = {}, literalSent, allowSilence, ownerHandled, state, toolTrace = [], message = '' }) {
  if (name === 'no_intervenir' && toolTrace.some(item => item.name === 'cancel_appointment' && item.result?.action === 'kept_booking'))
    return { result: { ok: false, action: 'answer_instead', message: 'No te quedes callado: el cliente dijo algo sobre su hora y no se anuló nada. Respóndele en una frase y, si dudas qué quiso decir, pregúntale si quiere mantenerla o anularla.' } };
  if (name === 'ignorar_mensaje_ajeno' && args.origen !== 'respuesta_automatica' && args.origen !== 'otra_organizacion')
    return { result: { ok: false, action: 'answer_instead', message: 'Es una persona que consulta o pide algo: respóndele (si es algo que el negocio no hace, díselo con amabilidad). No te quedes callado.' } };
  if (name === 'ignorar_mensaje_ajeno' && !literalSent && !state.hasBooking)
    return { silent: true, reason: String(args.reason || 'mensaje ajeno').slice(0, 300) };
  if (name === 'no_intervenir' && !literalSent && state.changedBooking)
    return { result: { ok: false, action: 'confirm_change', message: 'Acabas de cambiar su reserva en este turno: confírmaselo al cliente en una o dos frases (qué quedó y cuándo). No puedes quedarte callado.' } };
  if (name === 'no_intervenir' && !literalSent && !ownerHandled && state.hasBooking && state.postponesConfirmation)
    return { ownerAlert: `Tiene hora tomada y quedó de confirmar después: "${String(message).slice(0, 200)}". La hora sigue guardada.`, result: { ok: false, action: 'acknowledge_hold', message: 'No te quedes callado: el cliente pide tiempo para confirmar su hora. Dile en una frase que se la dejas guardada y que te avise. No la anules ni le ofrezcas otras horas.' } };
  if (name === 'no_intervenir' && allowSilence && !ownerHandled && !literalSent && state.bringsNewRequest)
    return { result: { ok: false, action: 'new_request', message: 'El cliente hace una consulta nueva para ti (pregunta o pide hora, precio o disponibilidad): respóndela y avanza hacia la hora, aunque parte del hilo lo haya atendido otra persona.' } };
  if (name === 'no_intervenir' && allowSilence && !literalSent)
    return { silent: true, reason: String(args.reason || '').slice(0, 300) };
  return null;
}
