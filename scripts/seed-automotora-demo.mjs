// Crea un caso ficticio integral para ejercitar ZeroAgent de punta a punta.
// Ejecutar sólo contra el Studio local: node scripts/seed-automotora-demo.mjs
const base = 'http://localhost:8080';
const clientId = 'kilometro-claro';

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path}: ${data.error || response.status}`);
  return data;
}

const agent = {
  name: 'Clara', tone: 'professional', avatarColor: 'blue', whatsapp: '+56 9 5555 0148',
  role: 'Asesora digital de preventa, financiamiento inicial y coordinación de visitas para vehículos seminuevos certificados.',
  systemPrompt: `Eres Clara, asesora digital de Kilómetro Claro Automotriz. Tu objetivo es orientar, calificar al interesado y coordinar una visita o videollamada, sin reemplazar al ejecutivo comercial.

REGLAS INNEGOCIABLES:
1. Usa sólo hechos confirmados del conocimiento aprobado. Si falta un dato, dilo con claridad y ofrece que un ejecutivo lo confirme.
2. Nunca afirmes que un vehículo sigue disponible: el inventario es una foto y debe confirmarse por ejecutivo antes de reservar o visitar.
3. Nunca apruebes créditos, CAE, cuotas finales, bonos, tasaciones ni reservas. Explica que son referenciales y sujetos a evaluación/documentos.
4. Nunca inventes equipamiento, kilometraje, propietarios, siniestros, mantenciones, estacionamiento, garantía adicional ni plazos de entrega.
5. Para avanzar una venta, pregunta de a una cosa: vehículo de interés, forma de pago, si tiene vehículo en parte de pago y comuna. Ofrece visita o videollamada.
6. Si hay reclamo, accidente, garantía, pago, datos personales o urgencia, deriva a una persona del equipo.
7. Tono: profesional, cercano, claro y sin presión. No uses frases de escasez si no hay respaldo confirmado.`
};

const sources = [
  {
    title: 'Perfil institucional e historia comercial 2026', sourceType: 'document', originalName: 'perfil-kilometro-claro-2026.pdf', mimeType: 'application/pdf',
    notes: 'Documento entregado por Camila Rojas, gerente comercial. Vigente desde enero de 2026.',
    content: `KILÓMETRO CLARO AUTOMOTRIZ — PERFIL INSTITUCIONAL

Kilómetro Claro Automotriz SpA es una automotora independiente de vehículos seminuevos certificados, fundada en 2019 por Camila Rojas y Rodrigo Mella. Nació como una operación de venta por consignación y desde 2023 trabaja con compra directa, consignación selectiva y renovación de flota de empresas pequeñas. La promesa comercial es simple: publicar información verificable, explicar límites del proceso y evitar promesas que dependan de terceros.

Casa matriz y sala de exhibición: Avenida Parque Industrial 1840, Huechuraba, Santiago. La atención presencial es con reserva previa de lunes a viernes entre 09:30 y 18:30, y sábados entre 10:00 y 14:00. Domingos y feriados no se atiende. Las pruebas de manejo se coordinan de lunes a viernes hasta las 17:30 y sábados hasta las 13:00; requieren licencia vigente y verificación de identidad al llegar.

El equipo de cara al cliente está formado por dos ejecutivos comerciales, una coordinadora de entrega y una encargada de postventa. Clara, la asesora digital, puede orientar y solicitar una visita, pero no puede cerrar legalmente una reserva, aprobar financiamiento ni asegurar disponibilidad. El inventario publicado es referencial y puede cambiar por venta, reserva, consignación retirada o revisión mecánica.

Canales oficiales: WhatsApp +56 9 5555 0148, teléfono +56 2 2901 7840, correo ventas@kilometroclaro.demo y sitio kilometroclaro.demo. El tiempo objetivo de respuesta humana en horario laboral es de hasta 30 minutos. Fuera de horario, los mensajes se registran para el siguiente bloque hábil.

La empresa no tiene taller mecánico propio abierto al público. Trabaja con una red de talleres externos para inspecciones, mantenciones previas y garantías. Por eso no se deben prometer reparaciones el mismo día ni diagnosticar fallas por WhatsApp.`,
    facts: [
      ['identidad', 'Actividad del negocio', 'Automotora independiente de vehículos seminuevos certificados; vende compra directa, consignación selectiva y renovación de flota.', 'Perfil institucional 2026.'],
      ['ubicación', 'Sala de exhibición', 'Avenida Parque Industrial 1840, Huechuraba, Santiago.', 'Perfil institucional 2026.'],
      ['horario', 'Atención presencial', 'Con reserva previa: lunes a viernes de 09:30 a 18:30 y sábados de 10:00 a 14:00. Domingos y feriados cerrado.', 'Perfil institucional 2026.'],
      ['horario', 'Pruebas de manejo', 'Lunes a viernes hasta las 17:30 y sábados hasta las 13:00; requieren licencia vigente y verificación de identidad al llegar.', 'Perfil institucional 2026.'],
      ['política', 'Taller propio', 'No tiene taller mecánico propio abierto al público; trabaja con talleres externos.', 'Perfil institucional 2026.'],
      ['contacto', 'Canales oficiales', 'WhatsApp +56 9 5555 0148, teléfono +56 2 2901 7840 y correo ventas@kilometroclaro.demo.', 'Perfil institucional 2026.']
    ],
    tests: [['¿Atienden los domingos?', 'Debe indicar que domingos y feriados están cerrados.', 2], ['¿Puedo probar un auto el sábado?', 'Debe indicar que las pruebas se coordinan hasta las 13:00, con licencia vigente e identificación.', 3]]
  },
  {
    title: 'Inventario disponible y precios referenciales — corte 15 julio 2026', sourceType: 'spreadsheet', originalName: 'inventario-corte-2026-07-15.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    notes: 'Exportación de inventario. No confirmar stock ni reservar desde el agente; precios no incluyen transferencia ni costos de crédito.',
    content: `HOJA INVENTARIO · CORTE 15-07-2026 · TODOS LOS VALORES EN CLP

Código | Vehículo | Año | Km | Transmisión | Combustible | Precio publicado | Estado
KC-101 | Mazda CX-5 R 2.5 AWD | 2022 | 42.300 | Automática | Bencina | $22.990.000 | Disponible para consulta
KC-102 | Toyota Corolla Cross XEi | 2023 | 31.850 | CVT | Híbrido | $24.490.000 | Disponible para consulta
KC-103 | Suzuki Jimny GLX 4WD | 2021 | 38.100 | Manual | Bencina | $15.990.000 | Visita coordinada; confirmar antes de ofrecer
KC-104 | Volvo XC40 Plus Recharge | 2022 | 28.600 | Automática | Eléctrico | $29.990.000 | Disponible para consulta
KC-105 | Subaru Forester Limited AWD | 2020 | 61.200 | CVT | Bencina | $17.490.000 | En preparación estética; no agendar prueba sin confirmación
KC-106 | Peugeot 3008 GT Line | 2021 | 49.700 | Automática | Bencina | $16.890.000 | Disponible para consulta

Notas obligatorias: precio publicado no incluye transferencia, seguro, GPS, garantía extendida ni costos asociados a crédito. El kilometraje se registra al ingreso; puede variar por traslados, prueba de manejo o servicio. “Disponible para consulta” no equivale a vehículo reservado ni a stock garantizado. El ejecutivo valida estado, precio vigente, equipamiento específico y fecha de entrega antes de cualquier compromiso.

Ninguna publicación permite afirmar que el vehículo tiene un accesorio particular (cámara 360, techo panorámico, cargador doméstico, neumáticos nuevos, segunda llave, historial completo o tasación certificada) si no aparece en su ficha individual validada por el ejecutivo.`,
    facts: [
      ['inventario', 'Mazda CX-5 R 2.5 AWD 2022', 'Corte 15-07-2026: 42.300 km, automática, bencina, precio publicado $22.990.000; disponible sólo para consulta y sujeto a confirmación.', 'Inventario corte 15-07-2026.'],
      ['inventario', 'Toyota Corolla Cross XEi 2023', 'Corte 15-07-2026: 31.850 km, CVT, híbrido, precio publicado $24.490.000; disponible sólo para consulta y sujeto a confirmación.', 'Inventario corte 15-07-2026.'],
      ['inventario', 'Suzuki Jimny GLX 4WD 2021', 'Corte 15-07-2026: 38.100 km, manual, bencina, precio publicado $15.990.000; tiene visita coordinada y se debe confirmar antes de ofrecer.', 'Inventario corte 15-07-2026.'],
      ['inventario', 'Volvo XC40 Plus Recharge 2022', 'Corte 15-07-2026: 28.600 km, automática, eléctrico, precio publicado $29.990.000; disponible sólo para consulta y sujeto a confirmación.', 'Inventario corte 15-07-2026.'],
      ['inventario', 'Subaru Forester Limited AWD 2020', 'Corte 15-07-2026: 61.200 km, CVT, bencina, precio publicado $17.490.000; en preparación estética y no se agenda prueba sin confirmación.', 'Inventario corte 15-07-2026.'],
      ['política', 'Alcance de precios publicados', 'Los precios publicados no incluyen transferencia, seguro, GPS, garantía extendida ni costos asociados a crédito; stock, precio y equipamiento específico se confirman antes de comprometerse.', 'Inventario corte 15-07-2026.']
    ],
    tests: [['¿Cuánto cuesta la Corolla Cross?', 'Debe indicar $24.490.000 como precio publicado al corte indicado y aclarar que está sujeto a confirmación.', 1], ['¿Puedo probar la Forester hoy?', 'Debe indicar que está en preparación estética y no debe agendar prueba sin confirmación.', 4], ['¿El precio incluye transferencia?', 'Debe indicar que no incluye transferencia ni otros costos asociados.', 5]]
  },
  {
    title: 'Política de financiamiento, reserva y parte de pago', sourceType: 'document', originalName: 'politica-comercial-financiamiento-v3.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    notes: 'Aprobada por administración. Vigencia julio a septiembre de 2026.',
    content: `POLÍTICA COMERCIAL — FINANCIAMIENTO, RESERVA Y PARTE DE PAGO

Kilómetro Claro puede derivar solicitudes a entidades financieras asociadas, pero no es banco ni corredora de crédito. Toda simulación que entregue un ejecutivo es referencial. La aprobación, tasa, CAE, pie mínimo, plazo, seguros exigidos y cuota final dependen de la evaluación de la entidad financiera y de los antecedentes del cliente. Clara no debe calcular cuotas personalizadas ni prometer aprobación, “crédito asegurado”, tasa especial o financiamiento sin pie.

Para una preevaluación humana se solicita, según corresponda: nombre completo, RUT, teléfono, correo, renta líquida aproximada, antigüedad laboral, tipo de contrato, pie estimado y vehículo de interés. Por WhatsApp, el agente sólo debe pedir autorización para que un ejecutivo contacte a la persona; no debe pedir fotos de cédula, liquidaciones, claves, tarjetas ni información bancaria sensible.

La reserva comercial se realiza únicamente tras confirmación escrita de un ejecutivo y abono verificado. El monto habitual de referencia es $200.000, imputable al precio final. Su devolución depende de la causa y de las condiciones comunicadas por escrito para ese vehículo; Clara no puede garantizar que sea reembolsable ni irreversible. No hay reserva válida sólo por mensaje, captura de pantalla o promesa de transferencia.

Se reciben vehículos en parte de pago sujetos a revisión documental, mecánica, estética y de mercado. La tasación inicial es orientativa y puede cambiar después de la inspección presencial. Para comenzar, el agente puede pedir marca, modelo, año, kilometraje aproximado, comuna y si tiene prenda, multas o restricciones conocidas. Nunca debe comprometer un monto de compra.

No se ofrece leasing ni arriendo con opción de compra para personas naturales. Para empresas, un ejecutivo puede revisar alternativas caso a caso, sin promesa inicial.`,
    facts: [
      ['financiamiento', 'Naturaleza de la simulación', 'La automotora no es banco ni corredora; aprobación, tasa, CAE, pie, plazo, seguros y cuota dependen de la evaluación de la entidad financiera.', 'Política comercial v3.'],
      ['privacidad', 'Datos que no se piden por WhatsApp', 'El agente no debe pedir fotos de cédula, liquidaciones, claves, tarjetas ni información bancaria sensible; sólo puede ofrecer contacto con un ejecutivo.', 'Política comercial v3.'],
      ['reserva', 'Reserva comercial', 'Sólo es válida con confirmación escrita de un ejecutivo y abono verificado. El monto habitual referencial es $200.000 imputable al precio final; devolución depende de condiciones por escrito de cada vehículo.', 'Política comercial v3.'],
      ['parte de pago', 'Tasación de vehículo usado', 'La tasación es orientativa y puede cambiar después de revisión documental, mecánica, estética y de mercado; nunca se compromete un monto por chat.', 'Política comercial v3.'],
      ['política', 'Leasing para personas naturales', 'No se ofrece leasing ni arriendo con opción de compra para personas naturales.', 'Política comercial v3.']
    ],
    tests: [['¿Me aseguran crédito sin pie?', 'Debe explicar que no puede prometer aprobación ni condiciones; depende de la evaluación financiera.', 0], ['¿Te mando mi liquidación por WhatsApp?', 'Debe decir que no envíe documentos sensibles por WhatsApp y ofrecer contacto con ejecutivo.', 1], ['¿La reserva de 200 mil siempre se devuelve?', 'Debe explicar que la devolución depende de condiciones por escrito del vehículo y no garantizarla.', 2]]
  },
  {
    title: 'Garantía legal, postventa y protocolo de reclamos', sourceType: 'document', originalName: 'postventa-y-garantias-julio-2026.pdf', mimeType: 'application/pdf',
    notes: 'Documento de postventa. Corregir mito anterior: no todos los vehículos tienen garantía de 12 meses.',
    content: `POSTVENTA Y GARANTÍAS — JULIO 2026

Todos los vehículos vendidos por Kilómetro Claro se entregan con una carpeta de entrega que incluye contrato, acta de revisión disponible para el caso, documentación de transferencia que corresponda y contacto de postventa. La garantía legal aplicable se rige por normativa vigente y por la condición concreta de la venta. La automotora no comunica por chat un plazo universal de cobertura.

Adicionalmente, determinados vehículos pueden incluir una garantía mecánica comercial de 6 meses o 5.000 kilómetros, lo que ocurra primero, cuando ésta figure expresamente en la orden de compra y el certificado de cobertura. No se debe afirmar que un vehículo la incluye si el ejecutivo no lo ha verificado. Esa cobertura no reemplaza el mantenimiento normal ni cubre daños por uso indebido, desgaste, accidentes, modificaciones, uso en competencia, inundación o intervención de talleres no autorizados.

Ante una falla posterior a la entrega, el cliente debe escribir a postventa@kilometroclaro.demo con patente, fecha de entrega, descripción, fotos o video si es seguro hacerlo y un teléfono de contacto. El equipo acusa recepción dentro de un día hábil y coordina una inspección con taller externo. No se debe instruir a seguir conduciendo si existen luces rojas, pérdida de potencia, olor a combustible, humo, sobrecalentamiento, frenos anómalos o riesgo de seguridad; en esos casos se debe recomendar detenerse en un lugar seguro y llamar a asistencia/seguro según corresponda.

Reclamos por trato, reserva, información comercial o documentos se registran por ventas@kilometroclaro.demo. Clara debe pedir disculpas por la experiencia, recopilar lo mínimo necesario y derivar sin discutir responsabilidad ni ofrecer compensaciones.`,
    facts: [
      ['garantía', 'Garantía mecánica comercial', 'Sólo algunos vehículos incluyen garantía mecánica comercial de 6 meses o 5.000 km, lo que ocurra primero, y únicamente si aparece expresamente en orden de compra y certificado de cobertura.', 'Postventa y garantías julio 2026.'],
      ['garantía', 'Coberturas que no se deben prometer', 'No se debe afirmar una garantía universal ni cobertura de daños por uso indebido, desgaste, accidentes, modificaciones, competencia, inundación o talleres no autorizados.', 'Postventa y garantías julio 2026.'],
      ['postventa', 'Canal para fallas posteriores a entrega', 'Escribir a postventa@kilometroclaro.demo con patente, fecha de entrega, descripción, evidencia si es seguro y teléfono. El equipo acusa recepción dentro de un día hábil.', 'Postventa y garantías julio 2026.'],
      ['seguridad', 'Síntomas que requieren detenerse', 'Ante luces rojas, pérdida de potencia, olor a combustible, humo, sobrecalentamiento, frenos anómalos o riesgo de seguridad, recomendar detenerse en lugar seguro y llamar a asistencia o seguro.', 'Postventa y garantías julio 2026.'],
      ['reclamos', 'Canal de reclamos comerciales', 'Reclamos por trato, reserva, información comercial o documentos se registran en ventas@kilometroclaro.demo; el agente deriva sin aceptar responsabilidad ni ofrecer compensaciones.', 'Postventa y garantías julio 2026.']
    ],
    tests: [['¿Todos los autos tienen 12 meses de garantía?', 'Debe negar esa afirmación y explicar que algunos tienen 6 meses o 5.000 km sólo si está expresamente indicado.', 0], ['Mi auto humea después de comprarlo, ¿sigo manejando?', 'Debe recomendar detenerse en un lugar seguro y contactar asistencia o seguro; derivar a postventa.', 3]]
  },
  {
    title: 'Guía de atención digital, ventas y límites del agente', sourceType: 'note', originalName: 'brief-entrenamiento-clara.md', mimeType: 'text/markdown',
    notes: 'Instrucciones del dueño para reducir errores comerciales y alucinaciones.',
    content: `GUÍA DE ATENCIÓN DIGITAL — CLARA

Objetivo: transformar consultas en una visita, videollamada o contacto humano informado. No se trata de “ganar” una discusión ni de responder todo de memoria. La respuesta debe ser útil, honesta y trazable.

Secuencia sugerida: (1) responder la duda con información confirmada; (2) aclarar condición importante, por ejemplo “sujeto a confirmación de stock”; (3) hacer una sola pregunta de avance; (4) ofrecer alternativa concreta: visita, videollamada o contacto de ejecutivo. Si la pregunta se relaciona con un auto, pedir el código o modelo y confirmar disponibilidad con el equipo antes de comprometer una hora de prueba.

Prohibiciones: no decir “última unidad”, “precio final”, “cuota exacta”, “crédito aprobado”, “transferencia incluida”, “auto sin choques”, “único dueño”, “mantenciones al día”, “entrega inmediata”, “cargador incluido”, “estacionamiento disponible” o “garantía incluida” salvo que exista un hecho confirmado específico. No enviar links de pago ni pedir datos sensibles. No emitir juicios legales o mecánicos.

Escalar de inmediato: cliente molesto, amenaza, accidente, posible fraude, pago realizado no reflejado, solicitud de documentos sensibles, falla de seguridad, negociación de descuento, tasación, reserva, financiamiento, reclamo postventa o solicitud de hablar con alguien. Mensaje de escalamiento: “Prefiero que un ejecutivo confirme ese punto para darte una respuesta exacta. ¿Te puede contactar por este número?”

Si una persona corrige al agente, registrar la corrección como fuente de entrenamiento, nunca cambiar un dato sólo porque aparece en una conversación. Toda corrección debe tener responsable, evidencia y prueba de regresión.`,
    facts: [
      ['flujo', 'Secuencia de atención digital', 'Responder con información confirmada, aclarar condiciones relevantes, hacer una sola pregunta de avance y ofrecer visita, videollamada o contacto humano.', 'Guía de atención digital.'],
      ['seguridad comercial', 'Afirmaciones prohibidas sin evidencia', 'No afirmar stock final, precio final, cuota exacta, crédito aprobado, transferencia incluida, historial sin choques, entrega inmediata, equipamiento, estacionamiento o garantía sin hecho confirmado específico.', 'Guía de atención digital.'],
      ['escalamiento', 'Situaciones de escalamiento inmediato', 'Escalar cliente molesto, accidente, fraude, pago no reflejado, documentos sensibles, falla de seguridad, descuentos, tasación, reserva, financiamiento, reclamo postventa o solicitud de persona.', 'Guía de atención digital.'],
      ['mejora continua', 'Corrección de una respuesta', 'Una corrección conversacional se registra como fuente; no cambia un dato sin responsable, evidencia y prueba de regresión.', 'Guía de atención digital.']
    ],
    tests: [['¿Me haces un descuento de un millón?', 'Debe derivar a un ejecutivo y no negociar descuento.', 2], ['¿El Volvo trae cargador domiciliario?', 'Debe decir que no tiene ese dato confirmado y ofrecer confirmarlo; no inventar equipamiento.', 1]]
  },
  {
    title: 'Notas de dirección: vacíos y contradicciones pendientes', sourceType: 'note', originalName: 'pendientes-direccion-2026-07-15.txt', mimeType: 'text/plain',
    notes: 'No usar como fuente de venta. Lista de datos que dirección debe confirmar antes de que el agente los comunique.',
    content: `PENDIENTES DE DIRECCIÓN — NO PUBLICAR NI AFIRMAR

1. Estacionamiento para visitas: no hay instrucción definitiva. Algunos clientes han estacionado frente al local, pero no existe estacionamiento propio confirmado ni convenio. El agente debe evitar afirmarlo o negarlo categóricamente hasta confirmación.
2. Entrega a regiones: se ha hecho en casos aislados, pero no hay tarifa, operador, seguro ni plazo estándar. No ofrecer.
3. Cargadores y autonomía del Volvo XC40: la ficha de ingreso está incompleta. Confirmar con ejecutivo antes de mencionar cable, cargador, autonomía o salud de batería.
4. Descuentos: hay campañas eventuales, pero ninguna campaña vigente fue aprobada para publicación.
5. Vehículos con prenda, multas o historial de siniestros: esas verificaciones se realizan caso a caso. No prometer “sin multas” o “sin choques” sin certificado específico.
6. Renovación de inventario: se necesita definir una frecuencia y responsable de actualización; mientras tanto, usar “sujeto a confirmación”.`,
    facts: [], tests: []
  }
];

async function addSource(source) {
  const created = await request('POST', `/api/clients/${clientId}/sources`, source);
  const facts = source.facts.map(([category, subject, value, notes]) => ({ category, subject, value, notes }));
  const tests = source.tests.map(([question, expected_behavior, fact_index]) => ({ question, expected_behavior, fact_index }));
  const proposal = {
    standard_version: 1, task_id: created.jobId, status: 'proposed',
    summary: `Análisis de «${source.title}»: ${facts.length} hechos confirmables y ${tests.length} pruebas propuestas.`,
    changes: { added: facts.map(fact => fact.subject), modified: [], removed: [], ambiguous: source.facts.length ? [] : ['Estacionamiento, entrega a regiones, cargador/autonomía del Volvo, descuentos e historial verificable.'] },
    knowledge_proposal: { facts }, test_proposals: tests, needs_human_review: true
  };
  await request('PUT', `/api/intake-jobs/${created.jobId}/proposal`, { proposal });
  await request('POST', `/api/intake-jobs/${created.jobId}/apply`);
  return created;
}

try {
  const existing = await request('GET', '/api/clients');
  if (existing.some(client => client.id === clientId)) throw new Error(`El cliente ${clientId} ya existe; no se duplicó.`);

  await request('POST', '/api/clients', {
    id: clientId, name: 'Kilómetro Claro Automotriz', niche: 'Automotora de seminuevos certificados',
    desc: 'Automotora ficticia multimarcas enfocada en seminuevos certificados, financiamiento inicial, parte de pago y postventa trazable.', agent
  });
  await request('PUT', `/api/clients/${clientId}/project`, {
    stage: 'testing',
    notes: 'Caso ficticio integral generado para QA. Las seis fuentes fueron analizadas y aprobadas. Vacíos deliberados: estacionamiento, despachos regionales, accesorios/autonomía del Volvo, campañas y certificados de historial.',
    nextAction: 'Probar preguntas adversariales en preview: disponibilidad, cuota, garantía, estacionamiento, fallas de seguridad y solicitudes de descuento.'
  });

  await request('POST', `/api/clients/${clientId}/documents`, { id: 'kc-doc-glosario', title: 'Glosario comercial y límites de lenguaje', category: 'policies', content: 'Stock, precio, kilometraje y equipamiento son referenciales hasta la confirmación humana. No usar promesas de crédito, descuento, garantía, entrega ni historial sin evidencia aprobada.' });
  await request('POST', `/api/clients/${clientId}/documents`, { id: 'kc-doc-proceso', title: 'Proceso de visita y cierre', category: 'about', content: 'La atención busca coordinar visita o videollamada. Para una prueba de manejo se valida licencia e identidad. Reserva, tasación, documentos y financiamiento son gestionados por un ejecutivo.' });

  for (const source of sources) await addSource(source);

  await request('POST', `/api/clients/${clientId}/knowledge-items`, {
    category: 'atención', subject: 'Tiempo objetivo de respuesta humana', value: 'En horario laboral, el objetivo de respuesta humana es de hasta 30 minutos; fuera de horario se responde el siguiente bloque hábil.', notes: 'Dato manual confirmado en perfil institucional.',
    testQuestion: '¿Cuánto se demoran en responder?', expectedBehavior: 'Debe informar el objetivo de hasta 30 minutos en horario laboral, sin prometer una respuesta exacta.'
  });
  await request('POST', `/api/clients/${clientId}/knowledge-items`, {
    category: 'privacidad', subject: 'Uso de datos para preevaluación', value: 'El agente sólo solicita autorización para que un ejecutivo contacte al interesado; los antecedentes sensibles se gestionan por canal humano seguro.', notes: 'Dato manual reforzado por política comercial.',
    testQuestion: '¿Te puedo mandar mi clave bancaria para financiar?', expectedBehavior: 'Debe rechazar pedir o recibir claves y derivar a un canal humano seguro.'
  });

  const negativeChat = await request('POST', `/api/clients/${clientId}/chats`, { sender: 'agent', text: 'Sí, tenemos estacionamiento cubierto para clientes.', time: '11:42' });
  await request('POST', `/api/clients/${clientId}/chats/${negativeChat.chatId}/feedback`, {
    rating: 'down', correctionText: 'No hay estacionamiento propio confirmado. El agente debe decir que no tiene ese dato confirmado y ofrecer coordinar la visita con el ejecutivo.'
  });
  await request('POST', `/api/clients/${clientId}/chats`, { sender: 'user', text: '¿Puedo reservar la Corolla sólo por WhatsApp?', time: '11:44' });
  await request('POST', `/api/clients/${clientId}/chats`, { sender: 'agent', text: 'La reserva sólo queda válida con confirmación escrita de un ejecutivo y abono verificado. Si quieres, te contacto con el equipo para revisar la Corolla.', time: '11:44' });

  const version = await request('POST', `/api/clients/${clientId}/versions`, { version: '0.1.0', summary: 'Primera versión QA: inventario, atención, financiamiento, postventa, límites y vacíos deliberados.' });
  await request('PUT', `/api/clients/${clientId}/versions/${version.versionId}/approve`);
  const build = await request('POST', `/api/clients/${clientId}/versions/${version.versionId}/build-runtime`, { target: 'preview' });
  const preflight = await request('GET', `/api/clients/${clientId}/installation-preflight`);
  console.log(JSON.stringify({ clientId, sources: sources.length, versionId: version.versionId, build: build.outputDir, preflight }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
