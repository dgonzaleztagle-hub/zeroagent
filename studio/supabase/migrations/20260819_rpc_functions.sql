-- Studio (ZeroAgent) — funciones RPC para las 12 operaciones multi-tabla/atómicas.
-- Escritas releyendo el código EXACTO de cada sitio en server.js (no de memoria/resumen) — ver
-- plan: C:\Users\dgonz\.claude\plans\parallel-chasing-bee.md. Estilo: mismo patrón que
-- runtime-template/supabase/agenda-v1.sql (za_request_appointment) — plpgsql security definer,
-- RAISE EXCEPTION con el mismo texto que ya usa server.js, REVOKE/GRANT service_role.
-- Lógica que vive solo en JS (tablas de vertical packs, cleanText/canonicalDomain/canonicalPhone,
-- scoreProspect) NO se duplica acá — Node sigue calculando esos valores derivados y se los pasa
-- ya resueltos a la función. Las RPC solo poseen la parte atómica/multi-tabla.

create extension if not exists unaccent;

-- Reemplaza server.js:2269-2312 (POST /api/clients)
create or replace function public.studio_create_client(
  p_id text, p_name text, p_niche text, p_desc text,
  p_agent_name text, p_agent_tone text, p_agent_avatar_color text, p_agent_role text,
  p_agent_whatsapp text, p_agent_system_prompt text, p_vertical_key text,
  p_agenda_config jsonb, p_welcome_text text, p_welcome_time text
) returns public.clients
language plpgsql security definer set search_path = public as $$
declare v_client public.clients;
begin
  if not (p_id ~* '^[a-z0-9][a-z0-9._-]{1,79}$') or trim(coalesce(p_name,'')) = '' then
    raise exception 'El cliente requiere nombre y un ID seguro de 2 a 80 caracteres.';
  end if;
  insert into public.clients(id, name, niche, "desc", agent_name, agent_tone, agent_avatar_color, agent_role, agent_whatsapp, agent_system_prompt, vertical_key)
  values (p_id, p_name, p_niche, p_desc, p_agent_name, p_agent_tone, p_agent_avatar_color, p_agent_role, p_agent_whatsapp, p_agent_system_prompt, p_vertical_key)
  returning * into v_client;
  insert into public.agenda_configs(client_id, config_json, updated_at) values (p_id, p_agenda_config, now());
  insert into public.chats(client_id, sender, text, "time") values (p_id, 'agent', p_welcome_text, p_welcome_time);
  return v_client;
end; $$;
revoke all on function public.studio_create_client(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.studio_create_client(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text) to service_role;

-- Reemplaza server.js:2314-2335 (PUT /api/clients/:id/vertical)
create or replace function public.studio_update_client_vertical(
  p_client_id text, p_vertical_key text, p_apply_agenda_defaults boolean, p_agenda_config jsonb
) returns public.clients
language plpgsql security definer set search_path = public as $$
declare v_client public.clients; v_now timestamptz := now();
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then raise exception 'Cliente no encontrado.'; end if;
  update public.clients set vertical_key = p_vertical_key where id = p_client_id returning * into v_client;
  if p_apply_agenda_defaults then
    insert into public.agenda_configs(client_id, config_json, updated_at) values (p_client_id, p_agenda_config, v_now)
    on conflict(client_id) do update set config_json = excluded.config_json, updated_at = excluded.updated_at;
  end if;
  return v_client;
end; $$;
revoke all on function public.studio_update_client_vertical(text,text,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.studio_update_client_vertical(text,text,boolean,jsonb) to service_role;

-- Reemplaza server.js:1420-1444 (POST /api/prospecting/prospects/:id/convert)
-- p_vertical_labels: mapa {vertical_key: label} de prospectingVerticals (server.js) — Node lo
-- pasa completo en cada llamada en vez de duplicar esa tabla acá, para que la fuente de verdad
-- del label siga siendo el código JS.
create or replace function public.studio_convert_prospect_to_client(p_prospect_id text, p_vertical_labels jsonb default '{}'::jsonb)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_prospect public.prospects;
  v_base text; v_client_id text; v_suffix integer := 2;
  v_now timestamptz := now();
  v_niche text; v_role text; v_welcome text;
begin
  select * into v_prospect from public.prospects where id = p_prospect_id;
  if not found then raise exception 'Prospecto no encontrado.'; end if;
  if v_prospect.converted_client_id is not null then raise exception 'Este prospecto ya tiene un proyecto.'; end if;

  v_base := regexp_replace(regexp_replace(lower(unaccent(coalesce(v_prospect.name,''))), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g');
  if v_base = '' then v_base := 'cliente'; end if;
  v_client_id := v_base;
  while exists(select 1 from public.clients where id = v_client_id) loop
    v_client_id := v_base || '-' || v_suffix;
    v_suffix := v_suffix + 1;
  end loop;

  v_niche := nullif(v_prospect.category, '');
  if v_niche is null then v_niche := p_vertical_labels ->> v_prospect.vertical; end if;
  if v_niche is null then v_niche := 'Negocio local'; end if;
  v_role := case when v_prospect.vertical = 'agenda' then 'Resolver consultas y gestionar reservas.' else 'Resolver consultas y captar oportunidades.' end;
  v_welcome := 'Hola, soy el asistente de ' || v_prospect.name || '. ¿En qué puedo ayudarte?';

  insert into public.clients(id, name, niche, "desc", agent_name, agent_tone, agent_avatar_color, agent_role, agent_whatsapp, agent_system_prompt, project_stage, next_action)
  values (v_client_id, v_prospect.name, v_niche, trim(both from ('Prospecto originado en Prospección. ' || coalesce(v_prospect.address,''))),
    'Asistente de ' || v_prospect.name, 'friendly', 'emerald', v_role, v_prospect.phone,
    'Eres el asistente de ' || v_prospect.name || '. Usa únicamente conocimiento aprobado y deriva lo que no puedas confirmar.',
    'intake', 'Enviar entrevista guiada al dueño');

  insert into public.chats(client_id, sender, text, "time") values (v_client_id, 'agent', v_welcome, to_char(v_now, 'HH24:MI'));
  update public.prospects set status = 'won', converted_client_id = v_client_id, updated_at = v_now where id = p_prospect_id;
  insert into public.prospect_activities(id, prospect_id, kind, summary, metadata_json, created_at)
  values (gen_random_uuid()::text, p_prospect_id, 'converted', 'Convertido en proyecto ZeroAgent.', jsonb_build_object('client_id', v_client_id), v_now);

  return v_client_id;
end; $$;
revoke all on function public.studio_convert_prospect_to_client(text,jsonb) from public, anon, authenticated;
grant execute on function public.studio_convert_prospect_to_client(text,jsonb) to service_role;

-- Reemplaza server.js:1175-1220 (upsertProspect). cleanText/canonicalDomain/canonicalPhone/
-- scoreProspect siguen corriendo en Node — esta función recibe los valores YA derivados y
-- solo posee el lookup-de-duplicado + upsert + activity, que es la parte con riesgo real de
-- carrera (dos importaciones casi simultáneas del mismo prospecto).
-- BUG ENCONTRADO PROBANDO EN VIVO (19-08-2026): server.js:1186-1188 hace
-- `candidate.whatsapp = whatsapp || null` (mismo patrón para instagram/facebook) — cuando el dato
-- viene vacío, manda NULL explícito a una columna `NOT NULL DEFAULT ''` (server.js:1023-1025 y la
-- migración ALTER TABLE de la línea 1063). Un INSERT con NULL explícito en Postgres viola la
-- constraint de inmediato (probado: "null value in column instagram violates not-null
-- constraint"). Es un bug preexistente del código original, no introducido acá — se corrige acá
-- con coalesce(...,'') en vez de reproducirlo, porque el resto de las columnas de texto opcionales
-- de esta misma tabla (address, source_url, etc.) ya usan '' consistentemente para "sin dato".
create or replace function public.studio_upsert_prospect(
  p_search_id text, p_vertical text, p_category text, p_location text, p_address text, p_website text,
  p_domain text, p_phone text, p_phone_key text, p_email text, p_whatsapp text, p_instagram text, p_facebook text,
  p_source text, p_source_url text, p_rating real, p_review_count integer,
  p_name text, p_name_key text, p_score integer, p_fit text, p_signals jsonb, p_suggested_message text
) returns table(id text, created boolean)
language plpgsql security definer set search_path = public as $$
declare v_id text; v_now timestamptz := now(); v_existing text;
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(nullif(p_domain,''), nullif(p_phone_key,''), p_name_key || '|' || p_location)));
  if p_domain <> '' then select prospects.id into v_existing from public.prospects where domain = p_domain limit 1; end if;
  if v_existing is null and p_phone_key <> '' then select prospects.id into v_existing from public.prospects where phone_key = p_phone_key limit 1; end if;
  if v_existing is null then select prospects.id into v_existing from public.prospects where lower(name) = p_name_key and lower(location) = lower(p_location) limit 1; end if;

  if v_existing is not null then
    update public.prospects set search_id = p_search_id, vertical = p_vertical, category = p_category, location = p_location,
      address = p_address, website = p_website, domain = p_domain, phone = p_phone, phone_key = p_phone_key, email = p_email,
      whatsapp = coalesce(p_whatsapp,''), instagram = coalesce(p_instagram,''), facebook = coalesce(p_facebook,''), source = p_source, source_url = p_source_url,
      rating = p_rating, review_count = p_review_count, score = p_score, fit = p_fit, signals_json = p_signals,
      suggested_message = p_suggested_message, updated_at = v_now
      where prospects.id = v_existing;
    return query select v_existing, false;
    return;
  end if;

  v_id := gen_random_uuid()::text;
  insert into public.prospects(id, search_id, name, vertical, category, location, address, website, domain, phone, phone_key,
    email, whatsapp, instagram, facebook, source, source_url, rating, review_count, score, fit, signals_json, suggested_message, status, created_at, updated_at)
  values (v_id, p_search_id, p_name, p_vertical, p_category, p_location, p_address, p_website, p_domain, p_phone, p_phone_key,
    p_email, coalesce(p_whatsapp,''), coalesce(p_instagram,''), coalesce(p_facebook,''), p_source, p_source_url, p_rating, p_review_count, p_score, p_fit, p_signals, p_suggested_message, 'new', v_now, v_now);
  insert into public.prospect_activities(id, prospect_id, kind, summary, metadata_json, created_at)
  values (gen_random_uuid()::text, v_id, 'discovered', 'Encontrado mediante ' || p_source || '.', jsonb_build_object('search_id', p_search_id), v_now);
  return query select v_id, true;
end; $$;
revoke all on function public.studio_upsert_prospect(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,real,integer,text,text,integer,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.studio_upsert_prospect(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,real,integer,text,text,integer,text,jsonb,text) to service_role;

-- Reemplaza server.js:1673-1715 (POST /api/intake-jobs/:jobId/apply)
create or replace function public.studio_apply_intake_proposal(p_job_id text)
returns table(facts_created integer, tests_created integer)
language plpgsql security definer set search_path = public as $$
declare
  v_job public.intake_jobs;
  v_facts jsonb; v_tests jsonb;
  v_fact jsonb; v_test jsonb;
  v_fact_ids text[] := '{}';
  v_now timestamptz := now();
  v_linked_index integer; v_linked_fact_id text; v_new_id text;
begin
  select * into v_job from public.intake_jobs where id = p_job_id;
  if not found then raise exception 'Tarea no encontrada.'; end if;
  if v_job.status = 'applied' then raise exception 'Esta propuesta ya fue aplicada.'; end if;
  if v_job.proposal_json is null then raise exception 'No hay una propuesta para aplicar.'; end if;

  v_facts := coalesce(
    v_job.proposal_json #> '{knowledge_proposal,facts}',
    v_job.proposal_json #> '{knowledge_proposal,items}',
    v_job.proposal_json -> 'knowledge_items',
    '[]'::jsonb
  );
  v_tests := coalesce(v_job.proposal_json -> 'test_proposals', v_job.proposal_json -> 'tests', '[]'::jsonb);
  if jsonb_typeof(v_facts) <> 'array' or jsonb_typeof(v_tests) <> 'array' then
    raise exception 'La propuesta debe usar listas para hechos y pruebas.';
  end if;

  for v_fact in select * from jsonb_array_elements(v_facts) loop
    if coalesce(v_fact->>'category','') = '' or coalesce(v_fact->>'subject','') = '' or coalesce(v_fact->>'value','') = '' then
      raise exception 'Hay hechos o pruebas incompletos en la propuesta.';
    end if;
  end loop;
  for v_test in select * from jsonb_array_elements(v_tests) loop
    if coalesce(v_test->>'question','') = '' or coalesce(v_test->>'expected_behavior', v_test->>'expectedBehavior', '') = '' then
      raise exception 'Hay hechos o pruebas incompletos en la propuesta.';
    end if;
  end loop;

  for v_fact in select * from jsonb_array_elements(v_facts) loop
    v_new_id := 'knowledge-' || gen_random_uuid()::text;
    v_fact_ids := array_append(v_fact_ids, v_new_id);
    insert into public.knowledge_items(id, client_id, source_id, category, subject, value, status, notes, confirmed_at)
    values (v_new_id, v_job.client_id, v_job.source_id, trim(v_fact->>'category'), trim(v_fact->>'subject'), trim(v_fact->>'value'),
      'approved', trim(coalesce(v_fact->>'notes', v_fact->>'evidence', '')), v_now);
  end loop;

  for v_test in select * from jsonb_array_elements(v_tests) loop
    v_linked_index := case when jsonb_typeof(v_test->'fact_index') = 'number' then (v_test->>'fact_index')::integer
                            when jsonb_typeof(v_test->'factIndex') = 'number' then (v_test->>'factIndex')::integer
                            else null end;
    v_linked_fact_id := case when v_linked_index is not null and v_linked_index >= 0 and v_linked_index < coalesce(array_length(v_fact_ids,1),0)
                              then v_fact_ids[v_linked_index + 1] else null end;
    insert into public.agent_tests(id, client_id, knowledge_item_id, question, expected_behavior, created_at)
    values ('test-' || gen_random_uuid()::text, v_job.client_id, v_linked_fact_id, trim(v_test->>'question'),
      trim(coalesce(v_test->>'expected_behavior', v_test->>'expectedBehavior')), v_now);
  end loop;

  update public.intake_jobs set status = 'applied', completed_at = v_now where id = p_job_id;
  update public.source_files set status = 'approved', reviewed_at = v_now where id = v_job.source_id and client_id = v_job.client_id;

  return query select jsonb_array_length(v_facts), jsonb_array_length(v_tests);
end; $$;
revoke all on function public.studio_apply_intake_proposal(text) from public, anon, authenticated;
grant execute on function public.studio_apply_intake_proposal(text) to service_role;

-- Reemplaza server.js:2415-2462 (POST /api/clients/:id/chats/:chatId/feedback).
-- La escritura de task.json a disco NO puede ser parte de esto (no es Postgres) — Node la hace
-- DESPUÉS de que esta función confirme éxito, usando job_id/source_content/instructions que
-- devuelve acá. Ver plan: esto relocaliza el riesgo de estado inconsistente, no lo elimina.
create or replace function public.studio_record_chat_feedback(
  p_client_id text, p_chat_id bigint, p_rating text, p_correction_text text
) returns table(feedback_id text, source_id text, job_id text, source_content text, instructions text)
language plpgsql security definer set search_path = public as $$
declare
  v_chat public.chats;
  v_now timestamptz := now();
  v_feedback_id text; v_source_id text; v_job_id text;
  v_source_content text; v_instructions text;
begin
  if p_rating not in ('up','down') then raise exception 'Evaluación inválida.'; end if;
  if p_rating = 'down' and trim(coalesce(p_correction_text,'')) = '' then
    raise exception 'Indica cómo debió responder antes de registrar una corrección.';
  end if;
  select * into v_chat from public.chats where id = p_chat_id and client_id = p_client_id;
  if not found then raise exception 'Mensaje no encontrado.'; end if;
  if v_chat.sender <> 'agent' then raise exception 'Sólo se evalúan respuestas del agente.'; end if;

  v_feedback_id := 'feedback-' || gen_random_uuid()::text;
  if p_rating = 'down' then
    v_source_id := 'source-' || gen_random_uuid()::text;
    v_job_id := 'job-' || gen_random_uuid()::text;
    v_source_content := 'Respuesta original del agente:' || chr(10) || v_chat.text || chr(10) || chr(10)
      || 'Corrección indicada por el propietario:' || chr(10) || trim(p_correction_text);
    v_instructions := 'Analizar esta corrección de conversación. Proponer el dato, regla o flujo necesario y una prueba de regresión; no aplicar cambios automáticamente.';
    insert into public.source_files(id, client_id, title, source_type, notes, content, status, version_number, created_at)
    values (v_source_id, p_client_id, 'Corrección de conversación · ' || to_char(v_now, 'YYYY-MM-DD'), 'note',
      'Generada desde revisión manual de una respuesta del agente.', v_source_content, 'pending_ide', 1, v_now);
    insert into public.intake_jobs(id, client_id, source_id, kind, status, instructions, created_at)
    values (v_job_id, p_client_id, v_source_id, 'review_conversation_feedback', 'pending_ide', v_instructions, v_now);
  end if;
  insert into public.conversation_feedback(id, client_id, chat_id, rating, correction_text, source_id, created_at)
  values (v_feedback_id, p_client_id, p_chat_id, p_rating, trim(coalesce(p_correction_text,'')), v_source_id, v_now);

  return query select v_feedback_id, v_source_id, v_job_id, v_source_content, v_instructions;
end; $$;
revoke all on function public.studio_record_chat_feedback(text,bigint,text,text) from public, anon, authenticated;
grant execute on function public.studio_record_chat_feedback(text,bigint,text,text) to service_role;

-- Reemplaza server.js:2465-2474 (DELETE /api/clients/:id/chats)
create or replace function public.studio_clear_client_chats(p_client_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.conversation_feedback where client_id = p_client_id;
  delete from public.chats where client_id = p_client_id;
end; $$;
revoke all on function public.studio_clear_client_chats(text) from public, anon, authenticated;
grant execute on function public.studio_clear_client_chats(text) to service_role;

-- Reemplaza server.js:2744-2759 (POST /api/clients/:id/ai-budget/recharge). SELECT...FOR UPDATE
-- cierra la carrera de lectura-luego-escritura que existe hoy en SQLite (getAiBudgetOverview lee,
-- después un upsert+insert sin guardia). El overview completo (gasto del ciclo, % usado) se sigue
-- calculando en Node con una lectura simple después de esto — no hace falta que viva en la RPC.
create or replace function public.studio_recharge_ai_budget(
  p_client_id text, p_amount_clp real, p_notes text
) returns public.ai_budget_configs
language plpgsql security definer set search_path = public as $$
declare v_config public.ai_budget_configs; v_now timestamptz := now();
begin
  if p_amount_clp is null or p_amount_clp <= 0 then raise exception 'Indica un monto de recarga válido.'; end if;
  select * into v_config from public.ai_budget_configs where client_id = p_client_id for update;
  insert into public.ai_budget_configs(client_id, provider, model, cycle_budget_clp, usd_clp, cycle_started_at, paused, updated_at)
  values (p_client_id, coalesce(v_config.provider, 'openai'), coalesce(v_config.model, 'gpt-4o-mini'), p_amount_clp,
    coalesce(v_config.usd_clp, 922), v_now, false, v_now)
  on conflict(client_id) do update set cycle_budget_clp = excluded.cycle_budget_clp, cycle_started_at = excluded.cycle_started_at,
    paused = false, updated_at = excluded.updated_at
  returning * into v_config;
  insert into public.ai_budget_events(id, client_id, kind, amount_clp, notes, created_at)
  values ('budget-' || gen_random_uuid()::text, p_client_id, 'recharge_reset', p_amount_clp, trim(coalesce(p_notes,'')), v_now);
  return v_config;
end; $$;
revoke all on function public.studio_recharge_ai_budget(text,real,text) from public, anon, authenticated;
grant execute on function public.studio_recharge_ai_budget(text,real,text) to service_role;

-- Reemplaza server.js:2879-2891 (solo los DELETE — seedDatabase() se queda como REST plano en Node)
create or replace function public.studio_reset_database()
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.prospect_activities where true;
  delete from public.prospects where true;
  delete from public.prospecting_searches where true;
  delete from public.commercial_leads where true;
  delete from public.intake_jobs where true;
  delete from public.agent_versions where true;
  delete from public.agent_tests where true;
  delete from public.knowledge_items where true;
  delete from public.source_files where true;
  delete from public.conversation_feedback where true;
  delete from public.chats where true;
  delete from public.documents where true;
  delete from public.clients where true;
end; $$;
revoke all on function public.studio_reset_database() from public, anon, authenticated;
grant execute on function public.studio_reset_database() to service_role;

-- Reemplaza server.js:2834-2873 (POST /api/settings/import). Preserva audit_events.id y chats.id
-- explícitos (OVERRIDING SYSTEM VALUE + resync de la secuencia) porque chats.id SÍ tiene una FK
-- entrante real (conversation_feedback.chat_id) — perderlos rompería esas referencias. El orden
-- DENTRO de source_files no importa: replaces_source_id quedó DEFERRABLE INITIALLY DEFERRED en el
-- schema, el chequeo corre recién al terminar esta función (transacción implícita de la RPC).
create or replace function public.studio_restore_snapshot(p_snapshot jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce((p_snapshot->>'snapshot_version')::int, 0) <> 2 then
    raise exception 'El archivo no es un respaldo ZeroAgent v2 completo. No se modificó la base de datos.';
  end if;

  delete from public.prospect_activities where true;
  delete from public.prospects where true;
  delete from public.prospecting_searches where true;
  delete from public.commercial_leads where true;
  delete from public.onboarding_files where true;
  delete from public.onboarding_responses where true;
  delete from public.onboarding_sessions where true;
  delete from public.agenda_configs where true;
  delete from public.client_infrastructure where true;
  delete from public.ai_budget_events where true;
  delete from public.ai_usage_records where true;
  delete from public.ai_budget_configs where true;
  delete from public.conversation_feedback where true;
  delete from public.chats where true;
  delete from public.agent_tests where true;
  delete from public.knowledge_items where true;
  delete from public.documents where true;
  delete from public.agent_versions where true;
  delete from public.intake_jobs where true;
  delete from public.source_files where true;
  delete from public.audit_events where true;
  delete from public.clients where true;

  insert into public.clients select * from jsonb_populate_recordset(null::public.clients, p_snapshot#>'{tables,clients}');

  insert into public.audit_events(id, action, entity_type, entity_id, details_json, created_at) overriding system value
    select id, action, entity_type, entity_id, details_json, created_at from jsonb_populate_recordset(null::public.audit_events, p_snapshot#>'{tables,audit_events}');
  perform setval(pg_get_serial_sequence('public.audit_events','id'), coalesce((select max(id) from public.audit_events), 1));

  insert into public.source_files select * from jsonb_populate_recordset(null::public.source_files, p_snapshot#>'{tables,source_files}');
  insert into public.intake_jobs select * from jsonb_populate_recordset(null::public.intake_jobs, p_snapshot#>'{tables,intake_jobs}');
  insert into public.agent_versions select * from jsonb_populate_recordset(null::public.agent_versions, p_snapshot#>'{tables,agent_versions}');
  insert into public.documents select * from jsonb_populate_recordset(null::public.documents, p_snapshot#>'{tables,documents}');
  insert into public.knowledge_items select * from jsonb_populate_recordset(null::public.knowledge_items, p_snapshot#>'{tables,knowledge_items}');
  insert into public.agent_tests select * from jsonb_populate_recordset(null::public.agent_tests, p_snapshot#>'{tables,agent_tests}');

  insert into public.chats(id, client_id, sender, text, "time") overriding system value
    select id, client_id, sender, text, "time" from jsonb_populate_recordset(null::public.chats, p_snapshot#>'{tables,chats}');
  perform setval(pg_get_serial_sequence('public.chats','id'), coalesce((select max(id) from public.chats), 1));

  insert into public.conversation_feedback select * from jsonb_populate_recordset(null::public.conversation_feedback, p_snapshot#>'{tables,conversation_feedback}');
  insert into public.ai_budget_configs select * from jsonb_populate_recordset(null::public.ai_budget_configs, p_snapshot#>'{tables,ai_budget_configs}');
  insert into public.ai_usage_records select * from jsonb_populate_recordset(null::public.ai_usage_records, p_snapshot#>'{tables,ai_usage_records}');
  insert into public.ai_budget_events select * from jsonb_populate_recordset(null::public.ai_budget_events, p_snapshot#>'{tables,ai_budget_events}');
  insert into public.client_infrastructure select * from jsonb_populate_recordset(null::public.client_infrastructure, p_snapshot#>'{tables,client_infrastructure}');
  insert into public.agenda_configs select * from jsonb_populate_recordset(null::public.agenda_configs, p_snapshot#>'{tables,agenda_configs}');
  insert into public.onboarding_sessions select * from jsonb_populate_recordset(null::public.onboarding_sessions, p_snapshot#>'{tables,onboarding_sessions}');
  insert into public.onboarding_responses select * from jsonb_populate_recordset(null::public.onboarding_responses, p_snapshot#>'{tables,onboarding_responses}');
  insert into public.onboarding_files select * from jsonb_populate_recordset(null::public.onboarding_files, p_snapshot#>'{tables,onboarding_files}');
  insert into public.commercial_leads select * from jsonb_populate_recordset(null::public.commercial_leads, p_snapshot#>'{tables,commercial_leads}');
  insert into public.prospecting_searches select * from jsonb_populate_recordset(null::public.prospecting_searches, p_snapshot#>'{tables,prospecting_searches}');
  insert into public.prospects select * from jsonb_populate_recordset(null::public.prospects, p_snapshot#>'{tables,prospects}');
  insert into public.prospect_activities select * from jsonb_populate_recordset(null::public.prospect_activities, p_snapshot#>'{tables,prospect_activities}');
end; $$;
revoke all on function public.studio_restore_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.studio_restore_snapshot(jsonb) to service_role;

-- Reemplaza server.js:2125-2224 (POST /api/clients/:id/sources), solo la parte DB. El decode de
-- base64 a storage_path y la escritura de task.json a disco se quedan en Node — storage_path se
-- calcula ANTES de llamar (Node ya escribió el archivo si vino fileData) y se pasa como parámetro.
-- p_source_id: Node lo genera ANTES de llamar (mismo id que usa para nombrar la carpeta en disco
-- del archivo subido) y se lo pasa acá — si la RPC generara su propio id, quedaría desincronizado
-- del nombre de carpeta que Node ya escribió a disco. Encontrado al escribir el endpoint real.
-- El advisory lock por replaces_source_id cierra la carrera de version_number que el plan flagged
-- (dos subidas casi simultáneas de la misma fuente podían leer el mismo version_number).
create or replace function public.studio_add_source_version(
  p_client_id text, p_source_id text, p_title text, p_source_type text, p_original_name text, p_storage_path text,
  p_mime_type text, p_size_bytes integer, p_notes text, p_content text, p_replaces_source_id text
) returns table(source_id text, job_id text, version_number integer, instructions text)
language plpgsql security definer set search_path = public as $$
declare
  v_source_id text := p_source_id;
  v_job_id text := 'job-' || gen_random_uuid()::text;
  v_now timestamptz := now();
  v_previous_version integer;
  v_version_number integer;
  v_instructions text;
begin
  if trim(coalesce(p_title,'')) = '' or p_source_type not in ('spreadsheet','document','website','note','other') then
    raise exception 'Título o tipo de fuente inválido.';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then raise exception 'Cliente no encontrado.'; end if;

  if p_replaces_source_id is not null then
    perform pg_advisory_xact_lock(hashtext(p_replaces_source_id));
    -- calificado con el alias de la tabla: "version_number" también es el nombre de una columna
    -- de retorno de esta función (returns table(...)), sin calificar es ambiguo (probado en vivo).
    select source_files.version_number into v_previous_version from public.source_files where id = p_replaces_source_id and client_id = p_client_id;
  end if;
  v_version_number := case when v_previous_version is not null then v_previous_version + 1 else 1 end;

  insert into public.source_files(id, client_id, title, source_type, original_name, storage_path, mime_type,
    size_bytes, notes, content, status, version_number, replaces_source_id, created_at)
  values (v_source_id, p_client_id, trim(p_title), p_source_type, p_original_name, p_storage_path, p_mime_type,
    coalesce(p_size_bytes, 0), trim(coalesce(p_notes,'')), trim(coalesce(p_content,'')), 'pending_ide', v_version_number, p_replaces_source_id, v_now);

  v_instructions := case when p_source_type = 'spreadsheet'
    then 'Interpretar hojas y columnas; proponer cambios estructurados sin aplicarlos automáticamente.'
    else 'Extraer información relevante; identificar datos faltantes o contradictorios y proponer cambios sin aplicarlos automáticamente.' end;

  insert into public.intake_jobs(id, client_id, source_id, kind, status, instructions, created_at)
  values (v_job_id, p_client_id, v_source_id, 'interpret_source', 'pending_ide', v_instructions, v_now);

  return query select v_source_id, v_job_id, v_version_number, v_instructions;
end; $$;
revoke all on function public.studio_add_source_version(text,text,text,text,text,text,text,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.studio_add_source_version(text,text,text,text,text,text,text,integer,text,text,text) to service_role;

-- Reemplaza server.js:1746-1776 (POST /api/clients/:id/knowledge-items)
create or replace function public.studio_create_knowledge_item(
  p_client_id text, p_category text, p_subject text, p_value text, p_notes text,
  p_source_id text, p_test_question text, p_expected_behavior text
) returns table(item_id text, test_id text)
language plpgsql security definer set search_path = public as $$
declare
  v_item_id text := 'knowledge-' || gen_random_uuid()::text;
  v_test_id text;
  v_now timestamptz := now();
begin
  if trim(coalesce(p_category,'')) = '' or trim(coalesce(p_subject,'')) = '' or trim(coalesce(p_value,'')) = '' then
    raise exception 'Categoría, asunto y valor son obligatorios.';
  end if;
  if (trim(coalesce(p_test_question,'')) <> '' or trim(coalesce(p_expected_behavior,'')) <> '')
     and (trim(coalesce(p_test_question,'')) = '' or trim(coalesce(p_expected_behavior,'')) = '') then
    raise exception 'Para guardar una prueba se requieren pregunta y comportamiento esperado.';
  end if;

  insert into public.knowledge_items(id, client_id, source_id, category, subject, value, status, notes, confirmed_at)
  values (v_item_id, p_client_id, p_source_id, trim(p_category), trim(p_subject), trim(p_value), 'approved', trim(coalesce(p_notes,'')), v_now);

  if trim(coalesce(p_test_question,'')) <> '' or trim(coalesce(p_expected_behavior,'')) <> '' then
    v_test_id := 'test-' || gen_random_uuid()::text;
    insert into public.agent_tests(id, client_id, knowledge_item_id, question, expected_behavior, created_at)
    values (v_test_id, p_client_id, v_item_id, trim(p_test_question), trim(p_expected_behavior), v_now);
  end if;

  return query select v_item_id, v_test_id;
end; $$;
revoke all on function public.studio_create_knowledge_item(text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.studio_create_knowledge_item(text,text,text,text,text,text,text,text) to service_role;
