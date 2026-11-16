import { resolveConversationPolicy } from './conversation-policy.js';
/**
 * Capa de comportamiento BASE para cualquier agente ZeroAgent, de cualquier vertical
 * (Ventas, Soporte, Captación, Atención, Agenda…).
 *
 * Es el curamiento generalista: la relevancia y la decisión las toma el razonamiento del modelo
 * sobre el conocimiento confirmado, nunca una batería de palabras clave. Las verticales con
 * operaciones deterministas (p. ej. Agenda) agregan su propio overlay encima de esta base.
 *
 * Bloque ESTÁTICO y agnóstico del negocio → cacheable como prefijo; su costo por turno es marginal.
 */
export const BASE_BEHAVIOR = resolveConversationPolicy().base_behavior;
