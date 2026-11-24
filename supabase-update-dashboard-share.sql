-- ============ shareable read-only dashboard link ============
-- Admin link = all projects. Project owner link = only that owner's projects.
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run, also if you ran an older version).
-- (Fresh installs: already included in supabase-setup.sql.)

create table if not exists public.dashboard_shares (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  token      text not null unique,
  created_at timestamptz not null default now()
);
alter table public.dashboard_shares enable row level security;   -- no policies: only the functions below can use it
revoke all on public.dashboard_shares from anon, authenticated;

-- keep an admin link created by the earlier version of this feature
do $$
begin
  if to_regclass('public.app_settings') is not null then
    insert into public.dashboard_shares (user_id, token)
    select (select id from public.profiles where role = 'admin' order by created_at limit 1), value
    from public.app_settings
    where key = 'dashboard_share_token'
      and exists (select 1 from public.profiles where role = 'admin')
    on conflict do nothing;
  end if;
end $$;

drop function if exists public._dashboard_ok(text);
drop function if exists public.admin_get_dashboard_share();
drop function if exists public.admin_set_dashboard_share(boolean);

-- The functions below are the ORIGINAL versions of this feature. Later updates (progress, documents, comments, privacy, guest comments...)
-- replace them with newer versions, so they are only (re)created while the database is still at that early stage.
-- This makes it harmless to run this file again later: it never puts an old function back over a newer one.
do $setup$
begin
  if to_regclass('public.tasks') is null then
    execute $fn$
create or replace function public._project_payload(pid bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not exists (select 1 from public.projects where id = pid) then return null; end if;
  select jsonb_build_object(
    'project', (select to_jsonb(x) from (
        select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date,
               coalesce(nullif(o.display_name,''), o.username) as owner_name
        from public.projects p left join public.profiles o on o.id = p.owner_id where p.id = pid) x),
    'topologies', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from (
        select id, name, path, mime, size, created_at from public.topologies where project_id = pid) t), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from (
        select id, author, is_guest, body, created_at from public.comments where project_id = pid) c), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- can this share token see this project? (admin link: all; owner link: only that owner's projects)
create or replace function public._dashboard_can_see(p_token text, pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token is not null and length(p_token) >= 20 and exists (
    select 1 from public.dashboard_shares s
    join public.profiles u on u.id = s.user_id
    where s.token = p_token
      and (u.role = 'admin'
           or (u.role = 'owner' and exists (select 1 from public.projects p where p.id = pid and p.owner_id = u.id))))
$$;

create or replace function public.shared_dashboard(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid; urole text; uname text;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  select s.user_id, u.role, coalesce(nullif(u.display_name,''), u.username) into uid, urole, uname
  from public.dashboard_shares s join public.profiles u on u.id = s.user_id where s.token = p_token;
  if uid is null or urole not in ('admin','owner') then return null; end if;
  return jsonb_build_object(
    'who', uname,
    'all', urole = 'admin',
    'projects', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date, p.created_at,
               coalesce(nullif(o.display_name,''), o.username) as owner_name,
               (select count(*) from public.comments c where c.project_id = p.id) as comment_count,
               (select count(*) from public.topologies t where t.project_id = p.id) as topology_count
        from public.projects p left join public.profiles o on o.id = p.owner_id
        where urole = 'admin' or p.owner_id = uid) x), '[]'::jsonb));
end $$;

create or replace function public.shared_dashboard_project(p_token text, p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._dashboard_can_see(p_token, p_id) then return null; end if;
  return public._project_payload(p_id);
end $$;

create or replace function public.shared_dashboard_comment(p_token text, p_id bigint, p_author text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._dashboard_can_see(p_token, p_id) then raise exception 'This link is invalid or has been disabled'; end if;
  p_author := btrim(coalesce(p_author, '')); p_body := btrim(coalesce(p_body, ''));
  if p_author = '' or char_length(p_author) > 50 then raise exception 'Name is required (max 50 characters)'; end if;
  if p_body = '' or char_length(p_body) > 2000 then raise exception 'Comment is required (max 2000 characters)'; end if;
  if (select count(*) from public.comments where is_guest and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many guest comments, try again later';
  end if;
  insert into public.comments (project_id, user_id, author, is_guest, body) values (p_id, null, p_author, true, p_body);
end $$;

-- the signed-in admin / project owner manages their own dashboard link
create or replace function public.get_my_dashboard_share() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.my_role(),'') not in ('admin','owner') then raise exception 'Only admins and project owners can share a dashboard'; end if;
  return (select token from public.dashboard_shares where user_id = auth.uid());
end $$;

create or replace function public.set_my_dashboard_share(p_enabled boolean) returns text
language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if coalesce(public.my_role(),'') not in ('admin','owner') then raise exception 'Only admins and project owners can share a dashboard'; end if;
  if p_enabled then
    tok := encode(extensions.gen_random_bytes(24), 'hex');
    insert into public.dashboard_shares (user_id, token) values (auth.uid(), tok)
      on conflict (user_id) do update set token = excluded.token, created_at = now();
    return tok;
  end if;
  delete from public.dashboard_shares where user_id = auth.uid();
  return null;
end $$;
    $fn$;
  end if;
end $setup$;
revoke execute on function public._project_payload(bigint) from public, anon, authenticated;
revoke execute on function public._dashboard_can_see(text, bigint) from public, anon, authenticated;
revoke execute on function public.get_my_dashboard_share() from public, anon;
revoke execute on function public.set_my_dashboard_share(boolean) from public, anon;
grant execute on function public.shared_dashboard(text) to anon, authenticated;
grant execute on function public.shared_dashboard_project(text, bigint) to anon, authenticated;
grant execute on function public.shared_dashboard_comment(text, bigint, text, text) to anon, authenticated;
grant execute on function public.get_my_dashboard_share() to authenticated;
grant execute on function public.set_my_dashboard_share(boolean) to authenticated;
