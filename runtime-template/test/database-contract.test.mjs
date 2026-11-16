import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('RPC reales: idempotencia, ocupación, identidad y rollback conservan la agenda', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema storage; create table storage.buckets(id text primary key, name text not null, public boolean not null default false);`);
    const root = new URL('../supabase/', import.meta.url);
    const base = (await fs.readFile(new URL('agenda-v1.sql', root), 'utf8')).replace(/^create extension if not exists (pgcrypto|btree_gist);\s*$/gmi, '');
    await db.exec(base);
    for (const file of (await fs.readdir(new URL('migrations/', root))).filter(name => name.endsWith('.sql')).sort())
      await db.exec(await fs.readFile(new URL(`migrations/${file}`, root), 'utf8'));
    const loc = (await db.query(`insert into public.za_locations(name) values ('Sede QA') returning id`)).rows[0].id;
    const service = (await db.query(`insert into public.za_services(name,duration_minutes,price_clp) values ('Servicio QA',60,25000) returning id`)).rows[0].id;
    const resource = (await db.query(`insert into public.za_resources(name,location_id) values ('Profesional QA',$1) returning id`, [loc])).rows[0].id;
    await db.query(`insert into public.za_resource_services(resource_id,service_id) values ($1,$2)`, [resource, service]);
    await db.query(`insert into public.za_availability_rules(resource_id,day_of_week,starts_at,ends_at)
      select $1,day,'08:00'::time,'20:00'::time from generate_series(0,6) day`, [resource]);
    const start = (await db.query(`select (date_trunc('day',now()+interval '7 days')+interval '15 hours')::text as at`)).rows[0].at;
    const later = hours => new Date(new Date(start).getTime() + hours * 3600000).toISOString();
    const book = (phone, at) => db.query(`select * from public.za_request_appointment(
      p_customer_name := 'Persona QA',p_customer_phone := $1,p_service_id := $2,p_resource_id := $3,
      p_starts_at := $4,p_source := 'whatsapp',p_location_id := $5,p_confirmation_mode := 'automatic')`, [phone, service, resource, at, loc]);
    const first = (await book('+56900000001', start)).rows[0];
    assert.equal((await book('+56900000001', start)).rows[0].id, first.id, 'Repetir la solicitud no duplica la cita');
    await assert.rejects(book('+56900000002', start), /ocupado/);
    await assert.rejects(book('+56900000002', later(0.5)), /ocupado/);
    assert.equal((await db.query(`select count(*)::int as n from public.za_appointments`)).rows[0].n, 1);
    const second = (await book('+56900000002', later(2))).rows[0];
    await assert.rejects(db.query(`select * from public.za_reschedule_appointment($1,$2,$3)`, [first.id, later(3), '+56900000002']), /no pertenece/);
    await assert.rejects(db.query(`select * from public.za_reschedule_appointment($1,$2,$3)`, [first.id, second.starts_at, '+56900000001']), /ocupado/);
    const unchanged = (await db.query(`select starts_at,status from public.za_appointments where id=$1`, [first.id])).rows[0];
    assert.equal(new Date(unchanged.starts_at).getTime(), new Date(first.starts_at).getTime(), 'Una reagenda fallida no mueve la original');
    assert.equal(unchanged.status, 'confirmed');
    await db.query(`select * from public.za_transition_appointment($1,'cancelled','confirmed')`, [second.id]);
    const replacement = (await book('+56900000003', later(2))).rows[0];
    assert.notEqual(replacement.id, second.id, 'La cancelación libera el horario');
    await assert.rejects(db.query(`select * from public.za_transition_appointment($1,'confirmed','cancelled')`, [second.id]), /permitida|estado/);
    const permissions = await db.query(`select has_function_privilege('anon',p.oid,'execute') as allowed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='za_request_appointment'`);
    assert.ok(permissions.rows.length);
    assert.ok(permissions.rows.every(row => !row.allowed), 'Nadie anónimo puede mutar la agenda');
  } finally { await db.close(); }
});
