import { candidateMatchesLatestSelection } from './booking-selection.js';
// Autoriza mutaciones antes de llegar al adaptador de agenda. No hace red ni escribe datos.
export function authorizeToolCall(ctx) {
  let { name, args, hourChosenByClient, dayDiscussedGuard, message, history, businessTimeZone, nowDate, dayLabel, modalityEstablished, onsiteNames, offersBothModes, bookableCatalog, normalizeText, HOME_VISIT, mentionsOnsite, cancelRequestedByClient, ownerAlert } = ctx;
  let denial;
  const answerTool = result => { denial = result; };
  if (name === 'create_appointment' || name === 'reschedule_appointment') {
    const selection = candidateMatchesLatestSelection({ history, message, date: args.date, time: args.time, now: nowDate, timeZone: businessTimeZone });
    if (!selection.ok) return { allowed: false, ownerAlert, result: { ok: false, action: 'selection_not_current', message: 'No se hizo ningún cambio: esa fecha u hora no corresponde a la última elección inequívoca del cliente. Conserva su elección más reciente; si la rechazó, preguntó por alternativas o no queda clara, pide confirmación del día y la hora juntos antes de reservar.' } };
  }
        // Una hora se toma o se cambia sólo si el cliente la eligió: tiene que estar en su mensaje o en
        // el último mensaje del agente que él está respondiendo. Rodolfo (14-09-2026) mandó su
        // dirección ("Eduardo Ríos Mackenna 1544, Buin") y el modelo agendó a "Eduardo" a las 19:00,
        // una hora que nadie había elegido en ese intercambio.
        if ((name === 'create_appointment' || name === 'reschedule_appointment') && !hourChosenByClient(args?.time)) {
          answerTool({ ok: false, action: 'confirm_first', message: `Todavía no hay una hora elegida por el cliente para ${args?.time || 'esa hora'}: el cliente no la escribió ni la aceptó con claridad (ofrecer una lista de horas no es elegir una). No se agendó nada. Ofrécele las horas reales y espera que elija.` });
          return { allowed: false, result: denial, ownerAlert };
        }
        const bookingDate = String(args?.date || args?.starts_at || args?.new_starts_at || '');
        if ((name === 'create_appointment' || name === 'reschedule_appointment') && !dayDiscussedGuard({ date: bookingDate, message, history, timeZone: businessTimeZone, now: nowDate })) {
          answerTool({ ok: false, action: 'day_not_discussed', message: `No se hizo ningún cambio: ${dayLabel(bookingDate.slice(0, 10), businessTimeZone, nowDate)} no es un día que se haya conversado con el cliente. Relee qué día eligió (si escribió el número del día, es ese y no otro día de la misma semana) y vuelve a llamar la herramienta con esa fecha. Si de verdad no está claro, pregúntale el día en una frase, sin ofrecer otro.` });
          return { allowed: false, result: denial, ownerAlert };
        }
        if (name === 'create_appointment' && !modalityEstablished()) {
          answerTool({ ok: false, action: 'ask_modality_first', message: `No se agendó nada todavía: falta saber si la sesión es en ${onsiteNames.join(' o ') || 'la consulta'} o a domicilio. Pregúntaselo en una frase corta, manteniendo la hora que eligió ("¿la sesión sería en ${onsiteNames[0] || 'la consulta'} o a domicilio?"), y agenda cuando conteste. Si es a domicilio, pide también la dirección.` });
          return { allowed: false, result: denial, ownerAlert };
        }
        // "La sesión es en mi casa" no basta para agendar: sin dirección la hora queda sin traslado
        // calculado y Francisco no sabe adónde ir (replay D-b2, 11-10-2026: agendó a domicilio sin
        // dirección). Y quien pidió domicilio no queda agendado en el box.
        if (name === 'create_appointment' && offersBothModes) {
          const chosenService = bookableCatalog.find(item => normalizeText(item.name) === normalizeText(args?.service))
            || bookableCatalog.find(item => args?.service && normalizeText(item.name).includes(normalizeText(args.service)));
          const lastModeText = [...history.filter(item => item.role === 'user').map(item => item.content), String(message || '')]
            .reverse().find(text => HOME_VISIT.test(text) || mentionsOnsite(text));
          const wantsHome = Boolean(lastModeText && HOME_VISIT.test(lastModeText));
          if (wantsHome && chosenService && chosenService.delivery_mode !== 'mobile') {
            answerTool({ ok: false, action: 'wrong_mode', message: `No se agendó nada: el cliente pidió la sesión a domicilio y "${chosenService.name}" es en la consulta. Usa el servicio a domicilio del catálogo y su dirección.` });
            return { allowed: false, result: denial, ownerAlert };
          }
          if (chosenService?.delivery_mode === 'mobile' && !/\d|s\/n|sin n[uú]mero/i.test(String(args?.address || ''))) {
            answerTool({ ok: false, action: 'ask_address', message: 'No se agendó nada todavía: para una sesión a domicilio falta la dirección (calle, número y comuna). Si ya te la dio en esta conversación, pásala en address; si no, pídesela en una frase corta, manteniendo la hora que eligió.' });
            return { allowed: false, result: denial, ownerAlert };
          }
        }
        if (name === 'cancel_appointment' && !cancelRequestedByClient()) {
          ownerAlert = ownerAlert || `Tiene hora tomada y escribió: "${String(message || '').slice(0, 200)}". El bot no la anuló porque no lo pidió con esas palabras; revisa si la mantiene.`;
          answerTool({ ok: false, action: 'kept_booking', message: (HOME_VISIT.test(String(message || '')) ? 'Si lo que dice es que la sesión es en su casa: no le ofrezcas anular; dile que le avisas a el equipo para dejarla a domicilio y pídele la dirección (calle, número y comuna). ' : '') + 'No se anuló nada: el cliente no pidió anular su hora. Si pide tiempo para confirmar o tiene un inconveniente ("te confirmo mañana", "tengo turno"), dile en una frase que se la dejas guardada y que te avise; el equipo ya quedó avisado. Si de verdad parece que ya no le sirve o que se equivocó de sede o de lugar, nómbrale su hora, dale en el mismo mensaje lo que sí buscaba (por ejemplo, cómo se agenda en la otra sede) y pregúntale "¿te la anulo?"; espera su respuesta. No le preguntes por su dolor.' });
          return { allowed: false, result: denial, ownerAlert };
        }

  return { allowed: true, ownerAlert };
}
