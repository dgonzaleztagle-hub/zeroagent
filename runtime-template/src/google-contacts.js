import { getGoogleAccessToken } from './google-calendar.js';
import { importAgendaCustomers } from './agenda.js';

// Trae TODOS los contactos de la cuenta de Google ya conectada (misma conexión que Calendar,
// mismo OAuth, un scope más: contacts.readonly). Solo lectura — nunca escribimos en la libreta
// del negocio. people.connections.list pagina de a 1000; casi ningún negocio tiene más de una
// página, pero seguimos nextPageToken igual por si acaso.
async function fetchAllGoogleContacts(accessToken) {
  const results = [];
  let pageToken = '';
  do {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,phoneNumbers,emailAddresses');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Google respondió ${response.status} al listar contactos.`);
    for (const person of body.connections || []) {
      const full_name = person.names?.[0]?.displayName || '';
      const phone = person.phoneNumbers?.[0]?.value || '';
      const email = person.emailAddresses?.[0]?.value || '';
      // Sin nombre o sin teléfono no sirve para el CRM (el teléfono es la clave de match) —
      // importAgendaCustomers ya los reporta en skipped, pero filtrar acá evita mandarle basura.
      if (full_name && phone) results.push({ full_name, phone, email: email || undefined });
    }
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return results;
}

// Sincroniza la libreta completa de Google del negocio contra el CRM (crear + actualizar nombre
// por teléfono, mismo comportamiento que la importación manual por CSV/vCard — ver
// importAgendaCustomers en agenda.js). Se agregan como segmento "frío" por defecto: no sabemos
// cuáles de los contactos de Google son pacientes reales vs. familia/proveedores, así que no
// asumimos "cliente" solo por estar en la libreta.
export async function syncGoogleContacts(packageData) {
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) throw new Error('Conecta Google Calendar antes de sincronizar contactos.');
  const contacts = await fetchAllGoogleContacts(accessToken);
  return importAgendaCustomers(packageData, contacts);
}
