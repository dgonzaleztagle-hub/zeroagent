const amount = value => Number(String(value).replace(/[^0-9]/g, ''));
const norm = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const generic = new Set(['sesion', 'atencion', 'servicio', 'tratamiento', 'general', 'del', 'con', 'para']);

function amountsFor(services) {
  const values = new Set();
  for (const service of services) {
    const noteAmounts = [...String(service.price_note || '').matchAll(/\$\s*([\d.,]+)/g)].map(match => amount(match[1]));
    // Un desglose explícito tiene prioridad sobre el total contable price_clp.
    if (noteAmounts.length) noteAmounts.forEach(value => values.add(value));
    else if (Number(service.price_clp) > 0) values.add(Number(service.price_clp));
  }
  return values;
}

// Los importes del catálogo vivo son los usados para reservar y confirmar. No se permite que
// un precio antiguo en un mensaje/hecho se convierta en una cotización nueva del asistente.
export function unexpectedCatalogPrices(text, catalog = {}) {
  const services = catalog.services || [];
  const allowed = amountsFor(services);
  if (!allowed.size) return [];
  const unexpected = [];
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const words = norm(sentence);
    const named = services.filter(service => {
      const tokens = norm(service.name).split(/[^a-z0-9]+/).filter(token => token.length >= 3 && !generic.has(token));
      return tokens.length && tokens.every(token => new RegExp(`\\b${token}\\b`).test(words));
    });
    const valid = named.length ? amountsFor(named) : allowed;
    for (const match of sentence.matchAll(/\$\s*([\d.,]+)/g)) if (!valid.has(amount(match[1]))) unexpected.push(amount(match[1]));
  }
  return unexpected;
}
