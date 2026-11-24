-- ============ per-user privacy + admin share links for chosen users ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-logs.sql (it is update 6 of 13).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- 1) A Project Owner can only see their OWN projects (and their tasks, documents, topologies, comments).
--    Admins and Reviewers can still see every project. This is enforced by the database itself.
-- 2) Admins can create several share links, each one for ALL users' projects or only for the users they choose.
-- 3) Admins and reviewers cannot own or create projects: a project always belongs to a Project Owner, who creates it.

-- ---------- 1) who can see which project ----------
create or replace function public.can_see_project(pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_role()
    when 'admin' then true
    when 'reviewer' then true
    when 'owner' then exists (select 1 from public.projects where id = pid and owner_id = auth.uid())
    else false end
$$;

drop policy if exists profiles_read    on public.profiles;
drop policy if exists projects_read    on public.projects;
drop policy if exists topo_read        on public.topologies;
drop policy if exists comments_read    on public.comments;
drop policy if exists comments_insert  on public.comments;
drop policy if exists tasks_read       on public.tasks;
drop policy if exists docs_read        on public.documents;
drop policy if exists topo_obj_read    on storage.objects;
drop policy if exists doc_obj_read     on storage.objects;

-- a project owner only reads their own profile; admins and reviewers read all (reviewers need the owner names)
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.my_role() in ('admin', 'reviewer'));
create policy projects_read on public.projects for select to authenticated
  using (public.my_role() in ('admin', 'reviewer') or (public.my_role() = 'owner' and owner_id = auth.uid()));
create policy topo_read     on public.topologies for select to authenticated using (public.can_see_project(project_id));
create policy comments_read on public.comments  for select to authenticated using (public.can_see_project(project_id));
create policy comments_insert on public.comments for insert to authenticated
  with check (public.can_see_project(project_id) and user_id = auth.uid() and is_guest = false);
create policy tasks_read    on public.tasks      for select to authenticated using (public.can_see_project(project_id));
create policy docs_read     on public.documents  for select to authenticated using (public.can_see_project(project_id));
create policy topo_obj_read on storage.objects for select to authenticated
  using (bucket_id = 'topologies' and public.can_see_project(split_part(name, '/', 1)::bigint));
create policy doc_obj_read  on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.can_see_project(split_part(name, '/', 1)::bigint));

-- ---------- 2) admin share links for chosen users ----------
create table if not exists public.admin_share_links (
  id         bigint generated always as identity primary key,
  token      text not null unique,
  label      text not null default '' check (char_length(label) <= 80),
  scope_all  boolean not null default true,
  owner_ids  uuid[] not null default '{}',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.admin_share_links enable row level security;   -- no policies: only the functions below can use it
revoke all on public.admin_share_links from anon, authenticated;

-- move an older "whole dashboard" admin link into the new table, then remove the old row
insert into public.admin_share_links (token, label, scope_all, created_by)
select ds.token, 'All projects (original link)', true, ds.user_id
from public.dashboard_shares ds join public.profiles p on p.id = ds.user_id
where p.role = 'admin'
on conflict (token) do nothing;
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'audit_dashboard_shares') then
    alter table public.dashboard_shares disable trigger audit_dashboard_shares;
  end if;
  delete from public.dashboard_shares ds using public.profiles p where p.id = ds.user_id and p.role = 'admin';
  if exists (select 1 from pg_trigger where tgname = 'audit_dashboard_shares') then
    alter table public.dashboard_shares enable trigger audit_dashboard_shares;
  end if;
end $$;

-- which project ids may this share token see?
create or replace function public._dash_project_ids(p_token text) returns setof bigint
language plpgsql stable security definer set search_path = public as $$
declare l public.admin_share_links%rowtype; uid uuid; urole text;
begin
  if p_token is null or length(p_token) < 20 then return; end if;
  select * into l from public.admin_share_links where token = p_token;
  if found then
    if l.scope_all then return query select id from public.projects;
    else return query select id from public.projects where owner_id = any (l.owner_ids); end if;
    return;
  end if;
  select ds.user_id, u.role into uid, urole
  from public.dashboard_shares ds join public.profiles u on u.id = ds.user_id where ds.token = p_token;
  if uid is null then return; end if;
  if urole = 'admin' then return query select id from public.projects;
  elsif urole = 'owner' then return query select id from public.projects where owner_id = uid; end if;
end $$;

create or replace function public._dashboard_can_see(p_token text, pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public._dash_project_ids(p_token) as x(id) where x.id = pid)
$$;

create or replace function public.shared_dashboard(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l public.admin_share_links%rowtype; who text; allp boolean; owners jsonb := '[]'::jsonb; uid uuid; urole text;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  select * into l from public.admin_share_links where token = p_token;
  if found then
    allp := l.scope_all;
    select coalesce(nullif(display_name, ''), username) into who from public.profiles where id = l.created_by;
    if not allp then
      select coalesce(jsonb_agg(coalesce(nullif(display_name, ''), username) order by username), '[]'::jsonb) into owners
      from public.profiles where id = any (l.owner_ids);
    end if;
  else
    select ds.user_id, u.role, coalesce(nullif(u.display_name, ''), u.username) into uid, urole, who
    from public.dashboard_shares ds join public.profiles u on u.id = ds.user_id where ds.token = p_token;
    if uid is null or urole not in ('admin', 'owner') then return null; end if;
    allp := urole = 'admin';
    if not allp then owners := jsonb_build_array(who); end if;
  end if;
  return jsonb_build_object(
    'who', coalesce(who, ''),
    'all', allp,
    'owners', owners,
    'label', coalesce(l.label, ''),
    'projects', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date, p.created_at,
               p.progress_mode, p.progress,
               (select count(*) from public.tasks k where k.project_id = p.id) as task_total,
               (select count(*) from public.tasks k where k.project_id = p.id and k.done) as task_done,
               (select coalesce(sum(k.percent), 0) from public.tasks k where k.project_id = p.id) as task_pct,
               coalesce(nullif(o.display_name, ''), o.username) as owner_name,
               (select count(*) from public.comments c where c.project_id = p.id) as comment_count,
               (select count(*) from public.topologies t where t.project_id = p.id) as topology_count
        from public.projects p left join public.profiles o on o.id = p.owner_id
        where p.id in (select pid from public._dash_project_ids(p_token) as d(pid))) x), '[]'::jsonb));
end $$;

-- owners manage their own link; admins use the new functions below
create or replace function public.get_my_dashboard_share() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.my_role(), '') <> 'owner' then raise exception 'Only project owners have a personal dashboard link'; end if;
  return (select token from public.dashboard_shares where user_id = auth.uid());
end $$;
create or replace function public.set_my_dashboard_share(p_enabled boolean) returns text
language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if coalesce(public.my_role(), '') <> 'owner' then raise exception 'Only project owners have a personal dashboard link'; end if;
  if p_enabled then
    tok := encode(extensions.gen_random_bytes(24), 'hex');
    insert into public.dashboard_shares (user_id, token) values (auth.uid(), tok)
      on conflict (user_id) do update set token = excluded.token, created_at = now();
    return tok;
  end if;
  delete from public.dashboard_shares where user_id = auth.uid();
  return null;
end $$;

-- ---------- 3) admins (and reviewers) cannot own projects ----------
create or replace function public.projects_owner_check() returns trigger
language plpgsql as $$
declare must_check boolean;
begin
  if new.owner_id is null then return new; end if;
  if tg_op = 'INSERT' then must_check := true;
  else must_check := new.owner_id is distinct from old.owner_id; end if;
  if must_check and not exists (select 1 from public.profiles where id = new.owner_id and role = 'owner') then
    raise exception 'A project must belong to a Project Owner (admins and reviewers cannot own projects)';
  end if;
  return new;
end $$;
drop trigger if exists projects_owner_check on public.projects;
create trigger projects_owner_check before insert or update on public.projects for each row execute function public.projects_owner_check();
-- only Project Owners create projects, always for themselves (admins and reviewers cannot create projects)
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated
  with check (public.my_role() = 'owner' and owner_id = auth.uid());

-- admin: manage share links (all users or chosen users)
create or replace function public._need_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'Only admins can manage share links'; end if;
end $$;

create or replace function public._clean_owner_ids(p_ids uuid[]) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(id), '{}'::uuid[]) from public.profiles where id = any (coalesce(p_ids, '{}'::uuid[])) and role = 'owner'
$$;

create or replace function public._scope_text(p_all boolean, p_ids uuid[]) returns text
language sql stable security definer set search_path = public as $$
  select case when p_all then 'all users' else 'users: ' || coalesce((select string_agg(coalesce(nullif(display_name, ''), username), ', ' order by username)
         from public.profiles where id = any (p_ids)), '') end
$$;

create or replace function public.admin_list_share_links() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._need_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'token', token, 'label', label, 'scope_all', scope_all,
            'owner_ids', to_jsonb(owner_ids), 'created_at', created_at) order by id desc) from public.admin_share_links), '[]'::jsonb);
end $$;

create or replace function public.admin_create_share_link(p_label text, p_all boolean, p_owner_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; tok text; nid bigint;
begin
  perform public._need_admin();
  ids := public._clean_owner_ids(p_owner_ids);
  if not coalesce(p_all, false) and array_length(ids, 1) is null then raise exception 'Choose at least one user, or All users'; end if;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.admin_share_links (token, label, scope_all, owner_ids, created_by)
  values (tok, left(btrim(coalesce(p_label, '')), 80), coalesce(p_all, false), case when coalesce(p_all, false) then '{}' else ids end, auth.uid())
  returning id into nid;
  perform public._log('dashboard.share.enable', left(btrim(coalesce(p_label, '')), 80), public._scope_text(coalesce(p_all, false), ids));
  return jsonb_build_object('id', nid, 'token', tok);
end $$;

create or replace function public.admin_update_share_link(p_id bigint, p_label text, p_all boolean, p_owner_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  perform public._need_admin();
  ids := public._clean_owner_ids(p_owner_ids);
  if not coalesce(p_all, false) and array_length(ids, 1) is null then raise exception 'Choose at least one user, or All users'; end if;
  update public.admin_share_links set label = left(btrim(coalesce(p_label, '')), 80), scope_all = coalesce(p_all, false),
    owner_ids = case when coalesce(p_all, false) then '{}' else ids end where id = p_id;
  perform public._log('dashboard.share.update', left(btrim(coalesce(p_label, '')), 80), public._scope_text(coalesce(p_all, false), ids));
end $$;

create or replace function public.admin_regenerate_share_link(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  perform public._need_admin();
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  update public.admin_share_links set token = tok, created_at = now() where id = p_id;
  perform public._log('dashboard.share.regenerate', (select label from public.admin_share_links where id = p_id), '');
  return tok;
end $$;

create or replace function public.admin_delete_share_link(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare lbl text;
begin
  perform public._need_admin();
  select label into lbl from public.admin_share_links where id = p_id;
  delete from public.admin_share_links where id = p_id;
  perform public._log('dashboard.share.disable', coalesce(lbl, ''), '');
end $$;

revoke execute on function public.can_see_project(bigint) from public, anon;
grant  execute on function public.can_see_project(bigint) to authenticated;
revoke execute on function public._dash_project_ids(text) from public, anon, authenticated;
revoke execute on function public._dashboard_can_see(text, bigint) from public, anon, authenticated;
revoke execute on function public._need_admin() from public, anon, authenticated;
revoke execute on function public._clean_owner_ids(uuid[]) from public, anon, authenticated;
revoke execute on function public._scope_text(boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.shared_dashboard(text) to anon, authenticated;
revoke execute on function public.get_my_dashboard_share() from public, anon;
revoke execute on function public.set_my_dashboard_share(boolean) from public, anon;
grant execute on function public.get_my_dashboard_share() to authenticated;
grant execute on function public.set_my_dashboard_share(boolean) to authenticated;
revoke execute on function public.admin_list_share_links() from public, anon;
revoke execute on function public.admin_create_share_link(text, boolean, uuid[]) from public, anon;
revoke execute on function public.admin_update_share_link(bigint, text, boolean, uuid[]) from public, anon;
revoke execute on function public.admin_regenerate_share_link(bigint) from public, anon;
revoke execute on function public.admin_delete_share_link(bigint) from public, anon;
grant execute on function public.admin_list_share_links() to authenticated;
grant execute on function public.admin_create_share_link(text, boolean, uuid[]) to authenticated;
grant execute on function public.admin_update_share_link(bigint, text, boolean, uuid[]) to authenticated;
grant execute on function public.admin_regenerate_share_link(bigint) to authenticated;
grant execute on function public.admin_delete_share_link(bigint) to authenticated;
