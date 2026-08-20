import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlRoot = path.join(runtimeRoot, 'supabase');
const db = new PGlite();

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema storage;
  create table storage.buckets(id text primary key, name text not null, public boolean not null default false);
`);

const baseSql = (await fs.readFile(path.join(sqlRoot, 'agenda-v1.sql'), 'utf8'))
  .replace(/^create extension if not exists (pgcrypto|btree_gist);\s*$/gmi, '');
await db.exec(baseSql);

const migrationRoot = path.join(sqlRoot, 'migrations');
const migrationFiles = (await fs.readdir(migrationRoot)).filter(name => name.endsWith('.sql')).sort();
assert.ok(migrationFiles.includes('20260807_zavu_delivery_v1.sql'));
for (let pass = 1; pass <= 2; pass++) {
  for (const file of migrationFiles) await db.exec(await fs.readFile(path.join(migrationRoot, file), 'utf8'));
}

const markers = await db.query(`select version from public.za_schema_migrations order by version`);
assert.equal(markers.rows.filter(row => row.version === '2026-08-07.zavu-delivery-v1').length, 1);

const first = await db.query(`select * from public.za_claim_webhook_event($1, 'zavu', 'message.inbound', 300)`, ['evt-1']);
assert.equal(first.rows[0].acquired, true);
const duplicateInFlight = await db.query(`select * from public.za_claim_webhook_event($1, 'zavu', 'message.inbound', 300)`, ['evt-1']);
assert.equal(duplicateInFlight.rows[0].acquired, false);
assert.equal(duplicateInFlight.rows[0].status, 'processing');
const lease = first.rows[0].lease_token;
const checkpoint = await db.query(`select public.za_checkpoint_webhook_event($1, $2, $3::jsonb, 300) as ok`, ['evt-1', lease, JSON.stringify({ agent_reply: { text: 'respuesta durable' } })]);
assert.equal(checkpoint.rows[0].ok, true);
const completed = await db.query(`select public.za_complete_webhook_event($1, $2, 'completed', $3::jsonb, null) as ok`, ['evt-1', lease, JSON.stringify({ provider_message_id: 'provider-1' })]);
assert.equal(completed.rows[0].ok, true);
const duplicateDone = await db.query(`select * from public.za_claim_webhook_event($1, 'zavu', 'message.inbound', 300)`, ['evt-1']);
assert.equal(duplicateDone.rows[0].acquired, false);
assert.equal(duplicateDone.rows[0].status, 'completed');
assert.equal(duplicateDone.rows[0].reply.agent_reply.text, 'respuesta durable');

const failed = await db.query(`select * from public.za_claim_webhook_event('evt-retry', 'zavu', 'message.inbound', 300)`);
await db.query(`select public.za_complete_webhook_event('evt-retry', $1, 'failed', '{}'::jsonb, 'timeout')`, [failed.rows[0].lease_token]);
const reclaimed = await db.query(`select * from public.za_claim_webhook_event('evt-retry', 'zavu', 'message.inbound', 300)`);
assert.equal(reclaimed.rows[0].acquired, true);
assert.equal(reclaimed.rows[0].attempts, 2);

const conversation = await db.query(`insert into public.za_conversations(channel, external_id) values ('whatsapp', '+56911111111') returning id`);
const conversationId = conversation.rows[0].id;
await db.query(`insert into public.za_conversation_messages(conversation_id, direction, content, client_message_id, provider_message_id, delivery_status)
  values ($1, 'outbound', 'hola', 'zavu:out:evt-1', 'provider-1', 'queued')`, [conversationId]);
await db.query(`insert into public.za_conversation_messages(conversation_id, direction, content, client_message_id, delivery_status)
  values ($1, 'outbound', 'hola', 'zavu:out:evt-1', 'sent') on conflict (client_message_id) do nothing`, [conversationId]);
const uniqueMessages = await db.query(`select count(*)::integer as count from public.za_conversation_messages where client_message_id = 'zavu:out:evt-1'`);
assert.equal(uniqueMessages.rows[0].count, 1);
await db.query(`update public.za_conversation_messages set delivery_status = 'delivered', delivered_at = now() where provider_message_id = 'provider-1'`);

await db.query(`select * from public.za_request_handoff($1, 'ayuda', '+56911111111', 'zavu:evt-1:handoff-outbox')`, [conversationId]);
await db.query(`select * from public.za_request_handoff($1, 'ayuda', '+56911111111', 'zavu:evt-1:handoff-outbox')`, [conversationId]);
const uniqueOutbox = await db.query(`select count(*)::integer as count from public.za_outbox_events where operation_key = 'zavu:evt-1:handoff-outbox'`);
assert.equal(uniqueOutbox.rows[0].count, 1);

await db.close();
console.log(`Supabase efímero: base + ${migrationFiles.length} migración(es), aplicadas 2x: OK`);
