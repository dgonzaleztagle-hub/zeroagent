import { executeAgendaTool } from '../../src/agenda-tools.js';
import { asIso, isActiveAgendaAppointment } from '../../src/agenda.js';

// Agenda de prueba explícita y congelada. Ejecuta la herramienta REAL y sustituye únicamente
// lecturas y escrituras externas. A diferencia de consultar producción, el mismo input conserva
// el mismo reloj, disponibilidad y resultados entre corridas.
export function createFrozenAgenda(packageData, { now = '2026-11-16T15:00:00Z', busy = [], facts } = {}) {
  const config = packageData.solutions.agenda.config;
  const catalog = structuredClone({ services: config.services, resources: config.resources, locations: config.locations });
  const appointments = []; const effects = [];
  let sequence = 0; let currentNow = new Date(now);
  const readModel = {
    getBusyIntervals: async () => structuredClone(busy),
    getAvailableSlots: async (_pkg, { service, resource, date }) => {
      const svc = catalog.services.find(item => item.name === service);
      const res = catalog.resources.find(item => item.name === resource);
      if (!svc || !res || !(res.services || []).includes(service)) throw new Error('Catálogo inválido');
      const noon = asIso(`${date}T12:00`, config.timezone);
      if (!noon || new Date(noon).getUTCDay() === 0) return [];
      const slots = [];
      const duration = Number(svc.duration_minutes) || 60;
      for (let minute = 8 * 60; minute + duration <= 20 * 60; minute += 30) {
        const at = asIso(`${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, config.timezone);
        const start = Date.parse(at); const end = start + duration * 60000;
        if (start <= currentNow.getTime()) continue;
        if (busy.some(item => start < Date.parse(item.end) && end > Date.parse(item.start))) continue;
        if (appointments.some(item => item.resource === resource && isActiveAgendaAppointment(item, currentNow.getTime()) && start < Date.parse(item.ends_at) && end > Date.parse(item.starts_at))) continue;
        slots.push(at);
      }
      return slots;
    }
  };
  const services = {
    liveInjectedFacts: async () => structuredClone(facts || packageData.knowledge?.confirmed_facts || []),
    getAgendaDashboard: async () => ({ catalog: structuredClone(catalog), appointments: structuredClone(appointments) }),
    listUpcomingAppointmentsForPhone: async (_pkg, phone) => structuredClone(appointments.filter(item => item.customer_phone === phone && isActiveAgendaAppointment(item, currentNow.getTime()))),
    executeAgendaTool: async (pkg, name, args, context) => {
      currentNow = context.now ? new Date(context.now) : currentNow;
      const result = await executeAgendaTool(pkg, name, args, { ...context, now: currentNow, dryRun: true, readModel, agendaSnapshot: { catalog, appointments } });
      if (result.ok && result.action === 'created') {
        const service = catalog.services.find(item => item.name === args.service);
        const appointment = { ...result.appointment, id: `frozen-${++sequence}`, reference: `ZA-FROZEN-${sequence}`, customer_phone: context.callerPhone,
          service: args.service, resource: args.resource, location: args.location, ends_at: new Date(Date.parse(result.appointment.starts_at) + (Number(service?.duration_minutes) || 60) * 60000).toISOString() };
        result.appointment = appointment; appointments.push(appointment);
      }
      if (result.ok && ['cancelled', 'rescheduled'].includes(result.action)) {
        const appointment = appointments.find(item => item.reference === result.reference && item.customer_phone === context.callerPhone);
        if (appointment && result.action === 'cancelled') appointment.status = 'cancelled';
        if (appointment && result.action === 'rescheduled') {
          const duration = Date.parse(appointment.ends_at) - Date.parse(appointment.starts_at);
          appointment.starts_at = asIso(`${args.date}T${args.time}`, config.timezone);
          appointment.ends_at = new Date(Date.parse(appointment.starts_at) + duration).toISOString();
        }
      }
      // Tras confirmar el efecto en ESTA agenda, el contrato observable es el de una operación
      // confirmada. El marcador dry_run del adaptador real sólo significa «no escribir remoto»;
      // pasarlo al auditor confundiría el resultado congelado con una operación no ejecutada.
      if (result.ok && ['created', 'cancelled', 'rescheduled'].includes(result.action)) delete result.dry_run;
      effects.push({ name, args: structuredClone(args), result: structuredClone(result), simulated: true });
      return result;
    }
  };
  return { services, appointments, effects, readModel, catalog, now };
}
