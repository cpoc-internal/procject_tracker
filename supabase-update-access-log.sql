-- ============ access log: the public IP address where share links and the app are opened ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-github.sql (it is update 12 of 14).
-- If you ever re-run an older update file that redefines shared_project / shared_dashboard / shared_dashboard_project,
-- just run THIS file again: it detects that and puts the logging back.
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- What is recorded (admins read it on the Activity log page; everything is deleted after 72 hours like the rest of the log):
--   * a share link is opened (project link, dashboard link, or a project opened from a dashboard link): time, IP address, browser/device
--   * a signed-in person opens the app (once per 30 minutes per address), signs in, or a sign-in fails
--   * every other log entry now also carries the IP address / device of the request that caused it
-- The IP address is the one the Supabase gateway sees ("cf-connecting-ip" / "x-real-ip" / "x-forwarded-for"). It is the PUBLIC address:
-- behind a company proxy, VPN or home router many people share one address, and a visitor using a VPN shows the VPN's address.
-- The address is read on the database side, so the browser cannot skip or fake it (only a very determined client that talks to the API
-- directly could add a misleading forwarded header; the gateway's own address field is preferred).
-- IP addresses are personal data in many countries: tell your users and visitors that access is recorded (the app shows a short notice
-- on share links). The 72-hour retention of the log applies to these addresses too.

alter table public.activity_logs add column if not exists ip text;
alter table public.activity_logs add column if not exists agent text;
alter table public.activity_logs add column if not exists hits integer not null default 1;     -- how many times the same thing was opened (repeat openings are counted, not listed again)
alter table public.activity_logs add column if not exists last_seen timestamptz;               -- the time of the most recent opening
create index if not exists activity_logs_ip_idx on public.activity_logs (ip);

-- the caller's public IP address (only if it is a real address) and browser string, from the API request headers
create or replace function public._client_ip() returns text
language plpgsql stable set search_path = public as $$
declare h json; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then return null; end;
  if h is null then return null; end if;
  v := coalesce(nullif(btrim(h->>'cf-connecting-ip'), ''), nullif(btrim(h->>'x-real-ip'), ''),
                nullif(btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''));
  if v is null then return null; end if;
  begin perform v::inet; exception when others then return null; end;
  return v;
end $$;

create or replace function public._client_agent() returns text
language plpgsql stable set search_path = public as $$
declare h json;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then return null; end;
  if h is null then return null; end if;
  return nullif(left(coalesce(h->>'user-agent', ''), 200), '');
end $$;

-- the internal writer now stores the address and device of the request that caused the entry
create or replace function public._log(p_action text, p_target text, p_details text, p_actor text default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); who text;
begin
  if p_actor is not null then who := p_actor;
  elsif uid is not null then
    select coalesce(nullif(display_name, ''), username) into who from public.profiles where id = uid;
  end if;
  insert into public.activity_logs (actor_id, actor, action, target, details, ip, agent)
  values (uid, coalesce(who, 'system'), p_action, left(coalesce(p_target, ''), 200), left(coalesce(p_details, ''), 600),
          public._client_ip(), public._client_agent());
  delete from public.activity_logs where created_at < now() - interval '72 hours';   -- 72-hour retention
end $$;
revoke execute on function public._log(text, text, text, text) from public, anon, authenticated;

-- "somebody opened something" entries: the same address + person + target is listed once per 30 minutes (further openings are counted in "hits"),
-- and one address can create at most 300 such entries an hour (so the log cannot be flooded)
create or replace function public._access_log(p_action text, p_target text, p_details text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_ip text := public._client_ip(); who text; uid uuid := auth.uid(); tgt text := left(coalesce(p_target, ''), 200);
        rid bigint; seen timestamptz;
begin
  if uid is not null then select coalesce(nullif(display_name, ''), username) into who from public.profiles where id = uid; end if;
  who := coalesce(who, 'Visitor');
  -- the same person + address opening the same thing again within 30 minutes: do not add a new line, count it on the existing one
  -- (openings less than 2 minutes apart count as one: a page that reloads itself must not inflate the number)
  select l.id, coalesce(l.last_seen, l.created_at) into rid, seen
  from public.activity_logs l
  where l.action = p_action and l.actor = who and l.target = tgt and l.ip is not distinct from v_ip and l.created_at > now() - interval '30 minutes'
  order by l.created_at desc limit 1;
  if rid is not null then
    if seen < now() - interval '2 minutes' then update public.activity_logs set hits = hits + 1, last_seen = now() where id = rid; end if;
    return;
  end if;
  if v_ip is not null and (select count(*) from public.activity_logs l where l.ip = v_ip and l.created_at > now() - interval '1 hour'
                              and (l.action like 'visit.%' or l.action in ('app.open', 'login.failed'))) >= 300 then return; end if;
  perform public._log(p_action, tgt, p_details, who);
end $$;
revoke execute on function public._access_log(text, text, text) from public, anon, authenticated;

-- events sent by the signed-in app: now also "app.open"
create or replace function public.log_event(p_action text, p_target text default '', p_details text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is null then return; end if;
  if p_action not in ('login', 'logout', 'password.change', 'project.view', 'document.view', 'user.password_reset', 'app.open') then return; end if;
  if p_action = 'user.password_reset' and public.my_role() <> 'admin' then return; end if;
  if p_action = 'app.open' then perform public._access_log(p_action, p_target, p_details); return; end if;
  perform public._log(p_action, p_target, p_details);
end $$;
revoke execute on function public.log_event(text, text, text) from public, anon;
grant execute on function public.log_event(text, text, text) to authenticated;

-- a failed sign-in (called by the login page; Supabase Auth itself cannot tell us). At most 20 per address per hour.
create or replace function public.log_login_failed() returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_ip text := public._client_ip();
begin
  if v_ip is null then return; end if;
  if (select count(*) from public.activity_logs l where l.action = 'login.failed' and l.ip = v_ip and l.created_at > now() - interval '1 hour') >= 20 then return; end if;
  perform public._log('login.failed', '', 'wrong username or password', 'Visitor');
end $$;
revoke execute on function public.log_login_failed() from public;
grant execute on function public.log_login_failed() to anon, authenticated;

-- which link was used: "project link", `dashboard link "Customer review"` or "dashboard link of Ana Lopez" (never the secret address itself)
create or replace function public._link_name(p_token text) returns text
language plpgsql stable security definer set search_path = public as $$
declare s text;
begin
  if p_token is null then return ''; end if;
  select coalesce(nullif(l.label, ''), 'link #' || l.id) into s from public.admin_share_links l where l.token = p_token;
  if found then return 'dashboard link "' || s || '"'; end if;
  select coalesce(nullif(u.display_name, ''), u.username) into s from public.dashboard_shares d join public.profiles u on u.id = d.user_id where d.token = p_token;
  if found then return 'dashboard link of ' || s; end if;
  if exists (select 1 from public.projects where share_token = p_token) then return 'project link'; end if;
  return '';
end $$;
revoke execute on function public._link_name(text) from public, anon, authenticated;

-- ---------- log every opening of a share link, inside the database (cannot be skipped by calling the API directly) ----------
-- Each public function is renamed to _..._core (nobody can call it any more) and replaced by a wrapper with the same name that
-- calls the core and records the visit. The marker ACCESS-LOG-WRAPPER lets this file recognise its own wrapper when re-run.

do $w1$
begin
  if position('ACCESS-LOG-WRAPPER' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.shared_project(text)')), '')) = 0 then
    drop function if exists public._shared_project_core(text);
    alter function public.shared_project(text) rename to _shared_project_core;
  end if;
end $w1$;
create or replace function public.shared_project(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r jsonb;
begin
  -- ACCESS-LOG-WRAPPER
  r := public._shared_project_core(p_token);
  if r is not null then perform public._access_log('visit.project', coalesce(r->'project'->>'name', ''), public._link_name(p_token));
  elsif p_token is not null and length(p_token) > 0 then perform public._access_log('visit.invalid', '', 'a link that does not exist or has been disabled'); end if;
  return r;
end $$;

do $w2$
begin
  if position('ACCESS-LOG-WRAPPER' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.shared_dashboard(text)')), '')) = 0 then
    drop function if exists public._shared_dashboard_core(text);
    alter function public.shared_dashboard(text) rename to _shared_dashboard_core;
  end if;
end $w2$;
create or replace function public.shared_dashboard(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r jsonb;
begin
  -- ACCESS-LOG-WRAPPER
  r := public._shared_dashboard_core(p_token);
  if r is not null then
    perform public._access_log('visit.dashboard', coalesce(nullif(r->>'label', ''), r->>'who', ''),
      public._link_name(p_token) || case when (r->>'all')::boolean then ' (all projects)' else ' (selected owners)' end);
  elsif p_token is not null and length(p_token) > 0 then perform public._access_log('visit.invalid', '', 'a link that does not exist or has been disabled'); end if;
  return r;
end $$;

do $w3$
begin
  if position('ACCESS-LOG-WRAPPER' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.shared_dashboard_project(text, bigint)')), '')) = 0 then
    drop function if exists public._shared_dashboard_project_core(text, bigint);
    alter function public.shared_dashboard_project(text, bigint) rename to _shared_dashboard_project_core;
  end if;
end $w3$;
create or replace function public.shared_dashboard_project(p_token text, p_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r jsonb;
begin
  -- ACCESS-LOG-WRAPPER
  r := public._shared_dashboard_project_core(p_token, p_id);
  if r is not null then perform public._access_log('visit.dashboard.project', coalesce(r->'project'->>'name', ''), 'opened from the ' || public._link_name(p_token));
  elsif p_token is not null and length(p_token) > 0 then perform public._access_log('visit.invalid', '', 'a link that does not exist or has been disabled'); end if;
  return r;
end $$;

revoke execute on function public._shared_project_core(text) from public, anon, authenticated;
revoke execute on function public._shared_dashboard_core(text) from public, anon, authenticated;
revoke execute on function public._shared_dashboard_project_core(text, bigint) from public, anon, authenticated;
revoke execute on function public.shared_project(text) from public;
revoke execute on function public.shared_dashboard(text) from public;
revoke execute on function public.shared_dashboard_project(text, bigint) from public;
grant execute on function public.shared_project(text) to anon, authenticated;
grant execute on function public.shared_dashboard(text) to anon, authenticated;
grant execute on function public.shared_dashboard_project(text, bigint) to anon, authenticated;
