-- ============ shareable read-only dashboard link (all projects) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor.
-- (Fresh installs: already included in supabase-setup.sql.)

create table if not exists public.app_settings (
  key   text primary key,
  value text
);
alter table public.app_settings enable row level security;   -- no policies: only the functions below can use it
revoke all on public.app_settings from anon, authenticated;

create or replace function public._dashboard_ok(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token is not null and length(p_token) >= 20
     and exists (select 1 from public.app_settings where key = 'dashboard_share_token' and value = p_token)
$$;

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

create or replace function public.shared_dashboard(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._dashboard_ok(p_token) then return null; end if;
  return jsonb_build_object('projects', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
      select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date, p.created_at,
             coalesce(nullif(o.display_name,''), o.username) as owner_name,
             (select count(*) from public.comments c where c.project_id = p.id) as comment_count,
             (select count(*) from public.topologies t where t.project_id = p.id) as topology_count
      from public.projects p left join public.profiles o on o.id = p.owner_id) x), '[]'::jsonb));
end $$;

create or replace function public.shared_dashboard_project(p_token text, p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._dashboard_ok(p_token) then return null; end if;
  return public._project_payload(p_id);
end $$;

create or replace function public.shared_dashboard_comment(p_token text, p_id bigint, p_author text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._dashboard_ok(p_token) then raise exception 'This link is invalid or has been disabled'; end if;
  if not exists (select 1 from public.projects where id = p_id) then raise exception 'Project not found'; end if;
  p_author := btrim(coalesce(p_author, '')); p_body := btrim(coalesce(p_body, ''));
  if p_author = '' or char_length(p_author) > 50 then raise exception 'Name is required (max 50 characters)'; end if;
  if p_body = '' or char_length(p_body) > 2000 then raise exception 'Comment is required (max 2000 characters)'; end if;
  if (select count(*) from public.comments where is_guest and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many guest comments, try again later';
  end if;
  insert into public.comments (project_id, user_id, author, is_guest, body) values (p_id, null, p_author, true, p_body);
end $$;

create or replace function public.admin_get_dashboard_share() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.my_role(),'') <> 'admin' then raise exception 'Admin only'; end if;
  return (select value from public.app_settings where key = 'dashboard_share_token');
end $$;

create or replace function public.admin_set_dashboard_share(p_enabled boolean) returns text
language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if coalesce(public.my_role(),'') <> 'admin' then raise exception 'Admin only'; end if;
  if p_enabled then
    tok := encode(extensions.gen_random_bytes(24), 'hex');
    insert into public.app_settings (key, value) values ('dashboard_share_token', tok)
      on conflict (key) do update set value = excluded.value;
    return tok;
  end if;
  delete from public.app_settings where key = 'dashboard_share_token';
  return null;
end $$;

revoke execute on function public._dashboard_ok(text) from public, anon, authenticated;
revoke execute on function public._project_payload(bigint) from public, anon, authenticated;
revoke execute on function public.admin_get_dashboard_share() from public, anon;
revoke execute on function public.admin_set_dashboard_share(boolean) from public, anon;
grant execute on function public.shared_dashboard(text) to anon, authenticated;
grant execute on function public.shared_dashboard_project(text, bigint) to anon, authenticated;
grant execute on function public.shared_dashboard_comment(text, bigint, text, text) to anon, authenticated;
grant execute on function public.admin_get_dashboard_share() to authenticated;
grant execute on function public.admin_set_dashboard_share(boolean) to authenticated;
