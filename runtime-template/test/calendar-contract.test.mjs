import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createGoogleCalendarEvent, updateGoogleCalendarEventTime, deleteGoogleCalendarEvent, getGoogleCalendarBusyIntervals } from '../src/google-calendar.js';

test('adaptador Calendar real: rutas, invitación, cambios, borrado y errores sin conectarse a Google', async () => {
  const previousFetch = globalThis.fetch;
  const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AI_CREDENTIALS_ENCRYPTION_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
  const previousEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const key = randomBytes(32); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update('synthetic-refresh', 'utf8'), cipher.final()]);
  const settings = { refresh_token_ciphertext: encrypted.toString('base64'), refresh_token_iv: iv.toString('base64'), refresh_token_tag: cipher.getAuthTag().toString('base64'),
    google_calendar_id: 'main', calendar_ids: ['main', 'work', 'personal', 'dead'].map(id => ({ id })), calendar_routes: { 'delivery:onsite': 'work' }, travel_buffer_minutes: 15 };
  Object.assign(process.env, { SUPABASE_URL: 'https://calendar-contract.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', AI_CREDENTIALS_ENCRYPTION_KEY: key.toString('base64'), GOOGLE_OAUTH_CLIENT_ID: 'synthetic', GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic' });
  const requests = []; let oauthFails = false; let transientBusy = false; let mutationStatus = 200;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input); const method = options.method || 'GET'; requests.push({ url, method, body: options.body });
    if (url.startsWith('https://calendar-contract.invalid/rest/v1/za_google_calendar_settings')) return Response.json([settings]);
    if (url === 'https://oauth2.googleapis.com/token') return oauthFails ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ access_token: 'synthetic-access' });
    if (url.endsWith('/freeBusy')) return Response.json({ calendars: { main: { busy: [] }, work: { busy: [] }, personal: { busy: [{ start: '2026-11-26T15:00:00Z', end: '2026-11-26T16:00:00Z' }] }, dead: { errors: [{ reason: transientBusy ? 'backendError' : 'notFound' }] } } });
    if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/')) {
      if (mutationStatus !== 200) return Response.json({ error: { message: 'Synthetic calendar failure' } }, { status: mutationStatus });
      return Response.json({ id: 'synthetic-event', colorId: '10' });
    }
    throw new Error('Unexpected external IO');
  };
  try {
    const busy = await getGoogleCalendarBusyIntervals('2026-11-26T00:00:00Z', '2026-11-27T00:00:00Z');
    assert.equal(Date.parse(busy[0].start), Date.parse('2026-11-26T14:45:00Z'));
    assert.equal(Date.parse(busy[0].end), Date.parse('2026-11-26T16:15:00Z'));
    transientBusy = true;
    await assert.rejects(getGoogleCalendarBusyIntervals('2026-11-26T00:00:00Z', '2026-11-27T00:00:00Z'), /no pudo leer/);
    transientBusy = false;
    const created = await createGoogleCalendarEvent({ summary: 'Cita QA', description: 'Sintético', startIso: '2026-11-26T15:00:00Z', endIso: '2026-11-26T16:00:00Z', attendeeEmail: 'qa@example.invalid', deliveryMode: 'onsite', colorId: '10' });
    assert.equal(created.calendarId, 'work');
    const createRequest = requests.find(r => r.method === 'POST' && r.url.includes('/calendars/work/events'));
    assert.ok(createRequest.url.endsWith('sendUpdates=all'));
    assert.deepEqual(JSON.parse(createRequest.body).attendees, [{ email: 'qa@example.invalid' }]);
    await updateGoogleCalendarEventTime(created.eventId, { startIso: '2026-11-27T15:00:00Z', endIso: '2026-11-27T16:00:00Z', calendarId: created.calendarId });
    assert.ok(requests.some(r => r.method === 'PATCH' && r.url.includes('/work/events/synthetic-event')));
    await deleteGoogleCalendarEvent(created.eventId, created.calendarId);
    assert.ok(requests.some(r => r.method === 'DELETE' && r.url.includes('/work/events/synthetic-event')));
    mutationStatus = 404;
    await deleteGoogleCalendarEvent(created.eventId, created.calendarId);
    await updateGoogleCalendarEventTime(created.eventId, { startIso: '2026-11-27T15:00:00Z', endIso: '2026-11-27T16:00:00Z', calendarId: created.calendarId });
    mutationStatus = 500;
    await assert.rejects(deleteGoogleCalendarEvent(created.eventId, created.calendarId), /Synthetic calendar failure/);
    oauthFails = true;
    await assert.rejects(getGoogleCalendarBusyIntervals('2026-11-26T00:00:00Z', '2026-11-27T00:00:00Z'), /invalid_grant/);
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of names) { if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name]; }
  }
});
