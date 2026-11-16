// Cada envío consulta el control de nuevo, incluso si el turno comenzó estando activo.
// Un fallo de lectura o un estado desconocido nunca autoriza una salida automática.
export async function deliverAutomatic({ readControl, send }, phone, text, options) {
  const current = await readControl();
  if (current?.control?.mode !== 'active') throw new Error('AGENT_PAUSED_BEFORE_SEND');
  return send(phone, text, options);
}
