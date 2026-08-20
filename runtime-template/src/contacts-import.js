// Parsers para importar una lista de contactos externa (export de iPhone/Android u hoja de cálculo)
// al CRM de Agenda. Separado de agenda.js porque el formato de entrada no tiene nada que ver con
// la lógica de negocio del upsert — cualquier fuente nueva (Google Contacts, Excel) solo necesita
// un parser más acá, reusando importAgendaCustomers tal cual.

function unfoldVCardLines(content) {
  const raw = content.split(/\r\n|\n|\r/);
  const lines = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

function vCardPropValue(line) {
  const idx = line.indexOf(':');
  return idx === -1 ? '' : line.slice(idx + 1).trim();
}

export function parseVCard(content) {
  const lines = unfoldVCardLines(String(content || ''));
  const contacts = [];
  let current = null;
  for (const line of lines) {
    // iOS/macOS agrupa una propiedad con su etiqueta personalizada con un prefijo "item1.", "item2."
    // (ej. `item1.TEL;type=pref:+56...`). Sin quitarlo, "TEL" nunca matchea el startsWith de abajo
    // y el teléfono queda vacío — un contacto real (con teléfono) se descartaba como "sin teléfono".
    const unwrapped = line.replace(/^item\d+\./i, '');
    const upper = unwrapped.toUpperCase();
    if (upper.startsWith('BEGIN:VCARD')) { current = { full_name: '', phone: '', email: '' }; continue; }
    if (upper.startsWith('END:VCARD')) { if (current) contacts.push(current); current = null; continue; }
    if (!current) continue;
    if (upper.startsWith('FN:') || upper.startsWith('FN;')) { current.full_name = vCardPropValue(unwrapped); continue; }
    if (!current.full_name && (upper.startsWith('N:') || upper.startsWith('N;'))) {
      const parts = vCardPropValue(unwrapped).split(';').filter(Boolean);
      current.full_name = parts.reverse().join(' ').trim();
      continue;
    }
    if (!current.phone && (upper.startsWith('TEL:') || upper.startsWith('TEL;'))) { current.phone = vCardPropValue(unwrapped); continue; }
    if (!current.email && (upper.startsWith('EMAIL:') || upper.startsWith('EMAIL;'))) { current.email = vCardPropValue(unwrapped); continue; }
  }
  return contacts;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',' || ch === ';') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map(cell => cell.trim());
}

const CSV_HEADER_ALIASES = {
  full_name: ['nombre', 'name', 'full_name', 'fullname', 'nombre completo'],
  phone: ['telefono', 'teléfono', 'phone', 'celular', 'fono', 'móvil', 'movil'],
  email: ['email', 'correo', 'e-mail', 'mail']
};

function matchHeader(headerCell) {
  const normalized = headerCell.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return field;
  }
  return null;
}

export function parseCsv(content) {
  const lines = String(content || '').split(/\r\n|\n|\r/).filter(line => line.trim() !== '');
  if (!lines.length) return [];
  const headerCells = splitCsvLine(lines[0]);
  const fieldByColumn = headerCells.map(matchHeader);
  const hasHeader = fieldByColumn.includes('full_name') || fieldByColumn.includes('phone');
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const columns = hasHeader ? fieldByColumn : ['full_name', 'phone', 'email'];
  return dataLines.map(line => {
    const cells = splitCsvLine(line);
    const contact = { full_name: '', phone: '', email: '' };
    columns.forEach((field, i) => { if (field && cells[i] !== undefined) contact[field] = cells[i]; });
    return contact;
  });
}

export function parseContactsFile(format, content) {
  if (format === 'vcard') return parseVCard(content);
  if (format === 'csv') return parseCsv(content);
  throw new Error('Formato de archivo no soportado (usa vcard o csv).');
}
