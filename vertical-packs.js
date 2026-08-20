const sharedAgendaCapabilities = [
  'whatsapp_support',
  'approved_knowledge',
  'live_availability',
  'appointment_requests',
  'customer_intake',
  'human_handoff',
  'client_console'
];

const sharedAgendaDefaults = {
  enabled: true,
  pack_version: '1.1.0',
  booking_mode: 'appointment',
  timezone: 'America/Santiago',
  confirmation_mode: 'manual',
  reminder_hours: 24,
  cancellation_policy: 'Las cancelaciones y reprogramaciones se revisan según disponibilidad.',
  locations: [],
  services: [],
  resources: [],
  risk_windows: [],
  rules: {
    slot_interval_minutes: 15,
    minimum_notice_hours: 2,
    maximum_advance_days: 60,
    human_handoff_on_conflict: true
  }
};

const sharedKnowledgeQuestions = [
  '¿Qué servicios se pueden reservar y cuál es su duración y precio vigente?',
  '¿En qué sedes, modalidades o zonas se presta cada servicio?',
  '¿Qué profesionales o recursos pueden realizar cada servicio?',
  '¿Cuál es el horario real, incluyendo pausas, feriados y excepciones?',
  '¿Qué política de confirmación, cancelación y reprogramación se debe comunicar?',
  '¿Qué casos debe derivar inmediatamente a una persona?'
];

const packs = {
  custom: {
    key: 'custom',
    label: 'Configuración a medida',
    category: 'custom',
    status: 'foundation',
    description: 'Parte sin una solución activa y se configura desde cero.',
    examples: [],
    capabilities: [],
    terminology: { customer: 'cliente', customers: 'clientes', appointment: 'reserva', appointments: 'reservas', intake: 'ficha de atención' },
    intake_fields: [],
    required_knowledge: [],
    agenda_defaults: { ...sharedAgendaDefaults, enabled: false },
    guardrails: ['Usa sólo información aprobada y deriva cuando falte un dato operativo.']
  },
  'agenda-general': {
    key: 'agenda-general',
    label: 'Agenda para servicios',
    category: 'agenda',
    status: 'ready',
    description: 'Base reutilizable para cualquier negocio que atiende por hora.',
    examples: ['talleres', 'asesorías', 'centros de atención', 'servicios profesionales'],
    capabilities: sharedAgendaCapabilities,
    terminology: { customer: 'cliente', customers: 'clientes', appointment: 'reserva', appointments: 'reservas', intake: 'ficha de atención' },
    intake_fields: [
      { key: 'full_name', label: 'Nombre', required: true, sensitivity: 'contact' },
      { key: 'phone', label: 'Teléfono', required: true, sensitivity: 'contact' },
      { key: 'email', label: 'Email', required: false, sensitivity: 'contact' },
      { key: 'notes', label: 'Notas de atención', required: false, sensitivity: 'business' }
    ],
    required_knowledge: sharedKnowledgeQuestions,
    agenda_defaults: sharedAgendaDefaults,
    guardrails: ['No inventes precios, horarios ni disponibilidad.', 'Una reserva sólo existe después de que la herramienta lo confirme.']
  },
  barberia: {
    key: 'barberia',
    label: 'Barberías y peluquerías',
    category: 'agenda',
    status: 'ready',
    description: 'Agenda por servicio y profesional, clientes recurrentes y atención rápida por WhatsApp.',
    examples: ['barberías', 'peluquerías', 'salones de cabello'],
    capabilities: sharedAgendaCapabilities,
    terminology: { customer: 'cliente', customers: 'clientes', appointment: 'hora', appointments: 'horas', intake: 'preferencias del cliente' },
    intake_fields: [
      { key: 'full_name', label: 'Nombre', required: true, sensitivity: 'contact' },
      { key: 'phone', label: 'Teléfono', required: true, sensitivity: 'contact' },
      { key: 'preferred_resource', label: 'Profesional preferido', required: false, sensitivity: 'business' },
      { key: 'notes', label: 'Preferencias', required: false, sensitivity: 'business' }
    ],
    required_knowledge: [
      ...sharedKnowledgeQuestions,
      '¿Qué servicios se pueden combinar y cuánto tiempo adicional requieren?',
      '¿El cliente puede elegir profesional o se asigna cualquiera disponible?'
    ],
    agenda_defaults: { ...sharedAgendaDefaults, rules: { ...sharedAgendaDefaults.rules, minimum_notice_hours: 1 } },
    guardrails: ['No prometas un profesional ni una hora sin consultar disponibilidad viva.']
  },
  'spa-estetica': {
    key: 'spa-estetica',
    label: 'Spa y estética',
    category: 'agenda',
    status: 'ready',
    description: 'Agenda de tratamientos, cabinas/profesionales y admisión con restricciones relevantes.',
    examples: ['spa', 'centros de estética', 'manicure', 'masajes'],
    capabilities: sharedAgendaCapabilities,
    terminology: { customer: 'cliente', customers: 'clientes', appointment: 'sesión', appointments: 'sesiones', intake: 'ficha de admisión' },
    intake_fields: [
      { key: 'full_name', label: 'Nombre', required: true, sensitivity: 'contact' },
      { key: 'phone', label: 'Teléfono', required: true, sensitivity: 'contact' },
      { key: 'restrictions', label: 'Alergias o restricciones informadas', required: false, sensitivity: 'sensitive', confirm_before_save: true },
      { key: 'notes', label: 'Objetivo de la atención', required: false, sensitivity: 'business' }
    ],
    required_knowledge: [
      ...sharedKnowledgeQuestions,
      '¿Qué contraindicaciones requieren evaluación humana antes de reservar?',
      '¿Qué preparación y cuidados previos se pueden informar para cada tratamiento?'
    ],
    agenda_defaults: sharedAgendaDefaults,
    guardrails: ['No diagnostiques ni asegures resultados.', 'Deriva contraindicaciones, embarazo, alergias o dudas clínicas a una persona.']
  },
  'salud-clinica': {
    key: 'salud-clinica',
    label: 'Salud y clínicas',
    category: 'agenda',
    status: 'ready',
    description: 'Admisión, agenda y seguimiento operativo para profesionales y centros de salud.',
    examples: ['kinesiología', 'odontología', 'psicología', 'centros médicos'],
    capabilities: [...sharedAgendaCapabilities, 'patient_intake', 'clinical_handoff'],
    terminology: { customer: 'paciente', customers: 'pacientes', appointment: 'cita', appointments: 'citas', intake: 'ficha de admisión del paciente' },
    intake_fields: [
      { key: 'full_name', label: 'Nombre', required: true, sensitivity: 'contact' },
      { key: 'phone', label: 'Teléfono', required: true, sensitivity: 'contact' },
      { key: 'age', label: 'Edad', required: false, sensitivity: 'sensitive', confirm_before_save: true },
      { key: 'occupation', label: 'Ocupación', required: false, sensitivity: 'sensitive', confirm_before_save: true },
      { key: 'medical_history', label: 'Antecedentes informados', required: false, sensitivity: 'health', confirm_before_save: true },
      { key: 'symptoms', label: 'Motivo o síntomas informados', required: false, sensitivity: 'health', confirm_before_save: true }
    ],
    required_knowledge: [
      ...sharedKnowledgeQuestions,
      '¿Qué señales de alarma requieren suspender la conversación y derivar?',
      '¿Qué información de admisión se puede recopilar y cuál debe confirmar el paciente?',
      '¿Qué coberturas o convenios se pueden informar sin prometer reembolso?'
    ],
    agenda_defaults: sharedAgendaDefaults,
    guardrails: [
      'No diagnostiques, prescribas ni prometas resultados.',
      'Los datos de salud se registran como información declarada por el paciente y se confirman antes de guardarlos.',
      'Deriva urgencias, señales de alarma y cualquier duda clínica.'
    ]
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getVerticalPack(key = 'custom') {
  return clone(packs[key] || packs.custom);
}

export function listVerticalPacks() {
  return Object.values(packs).map(pack => {
    const { agenda_defaults: _agendaDefaults, ...publicPack } = pack;
    return clone(publicPack);
  });
}

export function verticalAgendaDefaults(key = 'custom') {
  return clone((packs[key] || packs.custom).agenda_defaults);
}
