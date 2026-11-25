-- Project Tracker: run this ONCE in Supabase -> SQL Editor -> New query -> Run.
-- Then run the "create first admin" statement at the bottom (edit username/password).

create extension if not exists pgcrypto with schema extensions;

-- ============ tables ============
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null,
  display_name text not null default '',
  role         text not null check (role in ('admin','owner','reviewer')),
  created_at   timestamptz not null default now()
);
create unique index profiles_username_lower on public.profiles (lower(username));

create table public.projects (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 5000),
  status      text not null default 'pending' check (status in ('pending','in_progress','hold','done')),
  priority    text not null default 'medium' check (priority in ('low','medium','high')),
  start_date  date,
  due_date    date,
  owner_id    uuid references public.profiles(id) on delete set null,
  share_token text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (start_date is null or due_date is null or due_date >= start_date)
);

create table public.topologies (
  id          bigint generated always as identity primary key,
  project_id  bigint not null references public.projects(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  path        text not null,
  mime        text not null,
  size        integer not null default 0,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.comments (
  id         bigint generated always as identity primary key,
  project_id bigint not null references public.projects(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  author     text not null check (char_length(author) between 1 and 60),
  is_guest   boolean not null default false,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index on public.topologies (project_id);
create index on public.comments (project_id);

-- ============ helper functions ============
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.can_edit_project(pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles u
    where u.id = auth.uid()
      and (u.role = 'admin'
           or (u.role = 'owner' and exists (select 1 from public.projects p where p.id = pid and p.owner_id = u.id)))
  )
$$;

-- ============ triggers ============
create or replace function public.projects_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id and coalesce(public.my_role(),'') <> 'admin' then
    raise exception 'Only an admin can change the project owner';
  end if;
  if new.owner_id is not null and not exists (select 1 from public.profiles where id = new.owner_id and role in ('admin','owner')) then
    raise exception 'Owner must be an admin or project owner user';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger projects_guard_trg before insert or update on public.projects
  for each row execute function public.projects_guard();

create or replace function public.comments_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.user_id = auth.uid() then
    select left(coalesce(nullif(display_name,''), username), 60) into new.author from public.profiles where id = auth.uid();
    new.is_guest := false;
  end if;
  return new;
end $$;
create trigger comments_author_trg before insert on public.comments
  for each row execute function public.comments_author();

-- ============ permissions for logged-in users (row rules below still apply) ============
-- New Supabase projects do not expose SQL-created tables to the API automatically.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- ============ row level security ============
alter table public.profiles   enable row level security;
alter table public.projects   enable row level security;
alter table public.topologies enable row level security;
alter table public.comments   enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (public.my_role() is not null);

create policy projects_read   on public.projects for select to authenticated using (public.my_role() is not null);
create policy projects_insert on public.projects for insert to authenticated
  with check (public.my_role() in ('admin','owner') and (owner_id = auth.uid() or public.my_role() = 'admin'));
create policy projects_update on public.projects for update to authenticated
  using (public.can_edit_project(id)) with check (public.my_role() in ('admin','owner'));
create policy projects_delete on public.projects for delete to authenticated using (public.can_edit_project(id));

create policy topo_read   on public.topologies for select to authenticated using (public.my_role() is not null);
create policy topo_insert on public.topologies for insert to authenticated
  with check (public.can_edit_project(project_id) and uploaded_by = auth.uid());
create policy topo_delete on public.topologies for delete to authenticated using (public.can_edit_project(project_id));

create policy comments_read   on public.comments for select to authenticated using (public.my_role() is not null);
create policy comments_insert on public.comments for insert to authenticated
  with check (public.my_role() is not null and user_id = auth.uid() and is_guest = false);
create policy comments_delete on public.comments for delete to authenticated
  using (user_id = auth.uid() or public.my_role() = 'admin');

-- ============ storage bucket for topology images ============
-- Public bucket with unguessable paths (<project id>/<uuid>.<ext>); only editors can upload/delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('topologies', 'topologies', true, 5242880, array['image/png','image/jpeg','image/gif','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/png','image/jpeg','image/gif','image/webp'];

create policy topo_obj_read on storage.objects for select to authenticated using (bucket_id = 'topologies');
create policy topo_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'topologies' and public.can_edit_project(split_part(name, '/', 1)::bigint));
create policy topo_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'topologies' and public.can_edit_project(split_part(name, '/', 1)::bigint));

-- ============ read-only share link (anonymous: view + comment only) ============
create or replace function public.shared_project(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pid bigint; res jsonb;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  select id into pid from public.projects where share_token = p_token;
  if pid is null then return null; end if;
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

create or replace function public.shared_add_comment(p_token text, p_author text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare pid bigint;
begin
  if p_token is null or length(p_token) < 20 then raise exception 'This link is invalid or has been disabled'; end if;
  select id into pid from public.projects where share_token = p_token;
  if pid is null then raise exception 'This link is invalid or has been disabled'; end if;
  p_author := btrim(coalesce(p_author, '')); p_body := btrim(coalesce(p_body, ''));
  if p_author = '' or char_length(p_author) > 50 then raise exception 'Name is required (max 50 characters)'; end if;
  if p_body = '' or char_length(p_body) > 2000 then raise exception 'Comment is required (max 2000 characters)'; end if;
  if (select count(*) from public.comments where project_id = pid and is_guest and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many guest comments, try again later';
  end if;
  insert into public.comments (project_id, user_id, author, is_guest, body) values (pid, null, p_author, true, p_body);
end $$;

grant execute on function public.shared_project(text) to anon, authenticated;
grant execute on function public.shared_add_comment(text, text, text) to anon, authenticated;

-- ============ user administration (admin only) ============
create or replace function public._create_auth_user(p_username text, p_password text) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := gen_random_uuid(); em text;
begin
  if p_username !~ '^[A-Za-z0-9._-]{3,32}$' then raise exception 'Username must be 3-32 characters: letters, numbers, . _ -'; end if;
  if p_password is null or length(p_password) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  if exists (select 1 from public.profiles where lower(username) = lower(p_username)) then raise exception 'Username already exists'; end if;
  em := lower(p_username) || '@tracker.example.com';
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
      extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(),
      '', '', '', '', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text,
      jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
  return uid;
end $$;
revoke execute on function public._create_auth_user(text, text) from public, anon, authenticated;

create or replace function public.admin_create_user(p_username text, p_display text, p_password text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if coalesce(public.my_role(),'') <> 'admin' then raise exception 'Admin only'; end if;
  if p_role not in ('admin','owner','reviewer') then raise exception 'Invalid role'; end if;
  uid := public._create_auth_user(p_username, p_password);
  insert into public.profiles (id, username, display_name, role)
  values (uid, btrim(p_username), left(coalesce(nullif(btrim(p_display),''), btrim(p_username)), 60), p_role);
end $$;

create or replace function public.admin_update_user(p_id uuid, p_role text default null, p_display text default null, p_password text default null) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.profiles;
begin
  if coalesce(public.my_role(),'') <> 'admin' then raise exception 'Admin only'; end if;
  select * into cur from public.profiles where id = p_id;
  if not found then raise exception 'User not found'; end if;
  if p_role is not null then
    if p_role not in ('admin','owner','reviewer') then raise exception 'Invalid role'; end if;
    if cur.role = 'admin' and p_role <> 'admin' and (select count(*) from public.profiles where role = 'admin') <= 1 then
      raise exception 'Cannot demote the last admin';
    end if;
    update public.profiles set role = p_role where id = p_id;
  end if;
  if p_display is not null then
    update public.profiles set display_name = left(coalesce(nullif(btrim(p_display),''), cur.username), 60) where id = p_id;
  end if;
  if p_password is not null and p_password <> '' then
    if length(p_password) < 8 then raise exception 'Password must be at least 8 characters'; end if;
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_id;
    delete from auth.sessions where user_id = p_id;
  end if;
end $$;

create or replace function public.admin_delete_user(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.profiles;
begin
  if coalesce(public.my_role(),'') <> 'admin' then raise exception 'Admin only'; end if;
  if p_id = auth.uid() then raise exception 'You cannot delete your own account'; end if;
  select * into cur from public.profiles where id = p_id;
  if not found then raise exception 'User not found'; end if;
  if cur.role = 'admin' and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'Cannot delete the last admin';
  end if;
  delete from auth.users where id = p_id;
end $$;

revoke execute on function public.admin_create_user(text, text, text, text) from public, anon;
revoke execute on function public.admin_update_user(uuid, text, text, text) from public, anon;
revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_create_user(text, text, text, text) to authenticated;
grant execute on function public.admin_update_user(uuid, text, text, text) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;

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

revoke execute on function public._project_payload(bigint) from public, anon, authenticated;
revoke execute on function public._dashboard_can_see(text, bigint) from public, anon, authenticated;
revoke execute on function public.get_my_dashboard_share() from public, anon;
revoke execute on function public.set_my_dashboard_share(boolean) from public, anon;
grant execute on function public.shared_dashboard(text) to anon, authenticated;
grant execute on function public.shared_dashboard_project(text, bigint) to anon, authenticated;
grant execute on function public.shared_dashboard_comment(text, bigint, text, text) to anon, authenticated;
grant execute on function public.get_my_dashboard_share() to authenticated;
grant execute on function public.set_my_dashboard_share(boolean) to authenticated;

-- ============ project progress bar + task checklist ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- (Fresh installs: already included in supabase-setup.sql.)
-- Run it AFTER supabase-update-dashboard-share.sql if you have not run that one yet.

alter table public.projects add column if not exists progress_mode text not null default 'auto' check (progress_mode in ('auto','manual'));
alter table public.projects add column if not exists progress integer not null default 0 check (progress between 0 and 100);

create table if not exists public.tasks (
  id         bigint generated always as identity primary key,
  project_id bigint not null references public.projects(id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 200),
  done       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tasks_project_idx on public.tasks (project_id);

-- task status: not_started (0%), in_progress (its own %, 1-99), completed (100%)
alter table public.tasks add column if not exists status  text    not null default 'not_started' check (status in ('not_started','in_progress','completed'));
alter table public.tasks add column if not exists percent integer not null default 0 check (percent between 0 and 100);

create or replace function public.tasks_normalize() returns trigger
language plpgsql as $$
begin
  if new.status = 'not_started' then new.percent := 0;
  elsif new.status = 'completed' then new.percent := 100;
  else new.percent := least(99, greatest(1, new.percent)); end if;
  new.done := (new.status = 'completed');
  return new;
end $$;
drop trigger if exists tasks_normalize on public.tasks;
create trigger tasks_normalize before insert or update on public.tasks for each row execute function public.tasks_normalize();
update public.tasks set status = 'completed' where done and status <> 'completed';   -- tasks ticked in the older version

grant select, insert, update, delete on public.tasks to authenticated;
revoke all on public.tasks from anon;
alter table public.tasks enable row level security;
drop policy if exists tasks_read   on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
drop policy if exists tasks_delete on public.tasks;
create policy tasks_read   on public.tasks for select to authenticated using (public.my_role() is not null);
create policy tasks_insert on public.tasks for insert to authenticated with check (public.can_edit_project(project_id));
create policy tasks_update on public.tasks for update to authenticated
  using (public.can_edit_project(project_id)) with check (public.can_edit_project(project_id));
create policy tasks_delete on public.tasks for delete to authenticated using (public.can_edit_project(project_id));

-- shared payload (used by both kinds of share link): project + progress + tasks + topologies + comments
create or replace function public._project_payload(pid bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not exists (select 1 from public.projects where id = pid) then return null; end if;
  select jsonb_build_object(
    'project', (select to_jsonb(x) from (
        select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date, p.progress_mode, p.progress,
               coalesce(nullif(o.display_name,''), o.username) as owner_name
        from public.projects p left join public.profiles o on o.id = p.owner_id where p.id = pid) x),
    'tasks', coalesce((select jsonb_agg(to_jsonb(k) order by k.id) from (
        select id, title, done, status, percent from public.tasks where project_id = pid) k), '[]'::jsonb),
    'topologies', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from (
        select id, name, path, mime, size, created_at from public.topologies where project_id = pid) t), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from (
        select id, author, is_guest, body, created_at from public.comments where project_id = pid) c), '[]'::jsonb)
  ) into res;
  return res;
end $$;

create or replace function public.shared_project(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pid bigint;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  select id into pid from public.projects where share_token = p_token;
  if pid is null then return null; end if;
  return public._project_payload(pid);
end $$;

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
               p.progress_mode, p.progress,
               (select count(*) from public.tasks k where k.project_id = p.id) as task_total,
               (select count(*) from public.tasks k where k.project_id = p.id and k.done) as task_done,
               (select coalesce(sum(k.percent), 0) from public.tasks k where k.project_id = p.id) as task_pct,
               coalesce(nullif(o.display_name,''), o.username) as owner_name,
               (select count(*) from public.comments c where c.project_id = p.id) as comment_count,
               (select count(*) from public.topologies t where t.project_id = p.id) as topology_count
        from public.projects p left join public.profiles o on o.id = p.owner_id
        where urole = 'admin' or p.owner_id = uid) x), '[]'::jsonb));
end $$;

revoke execute on function public._project_payload(bigint) from public, anon, authenticated;
grant execute on function public.shared_project(text) to anon, authenticated;
grant execute on function public.shared_dashboard(text) to anon, authenticated;

-- ============ project documents (PDF / Word .docx / HTML) with a web view ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-progress.sql. If you ever re-run the progress file, run this one again afterwards.
-- (Fresh installs: already included in supabase-setup.sql.)

create table if not exists public.documents (
  id          bigint generated always as identity primary key,
  project_id  bigint not null references public.projects(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 200),
  path        text not null,
  kind        text not null check (kind in ('pdf','docx','html')),
  size        integer not null default 0,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists documents_project_idx on public.documents (project_id);

grant select, insert, update, delete on public.documents to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public.documents from anon;
alter table public.documents enable row level security;
drop policy if exists docs_read   on public.documents;
drop policy if exists docs_insert on public.documents;
drop policy if exists docs_delete on public.documents;
create policy docs_read   on public.documents for select to authenticated using (public.my_role() is not null);
create policy docs_insert on public.documents for insert to authenticated
  with check (public.can_edit_project(project_id) and uploaded_by = auth.uid());
create policy docs_delete on public.documents for delete to authenticated using (public.can_edit_project(project_id));

-- storage bucket: public with unguessable paths (<project id>/<uuid>.<ext>), 20 MB limit; only editors can upload/delete
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', true, 20971520,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/html'])
on conflict (id) do update set public = true, file_size_limit = 20971520,
  allowed_mime_types = array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/html'];

drop policy if exists doc_obj_read   on storage.objects;
drop policy if exists doc_obj_insert on storage.objects;
drop policy if exists doc_obj_delete on storage.objects;
create policy doc_obj_read on storage.objects for select to authenticated using (bucket_id = 'documents');
create policy doc_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.can_edit_project(split_part(name, '/', 1)::bigint));
create policy doc_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.can_edit_project(split_part(name, '/', 1)::bigint));

-- shared payload (both kinds of share link) now also lists the documents
create or replace function public._project_payload(pid bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not exists (select 1 from public.projects where id = pid) then return null; end if;
  select jsonb_build_object(
    'project', (select to_jsonb(x) from (
        select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date, p.progress_mode, p.progress,
               coalesce(nullif(o.display_name,''), o.username) as owner_name
        from public.projects p left join public.profiles o on o.id = p.owner_id where p.id = pid) x),
    'tasks', coalesce((select jsonb_agg(to_jsonb(k) order by k.id) from (
        select id, title, done, status, percent from public.tasks where project_id = pid) k), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from (
        select id, name, path, kind, size, created_at from public.documents where project_id = pid) d), '[]'::jsonb),
    'topologies', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from (
        select id, name, path, mime, size, created_at from public.topologies where project_id = pid) t), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from (
        select id, author, is_guest, body, created_at from public.comments where project_id = pid) c), '[]'::jsonb)
  ) into res;
  return res;
end $$;
revoke execute on function public._project_payload(bigint) from public, anon, authenticated;

-- ============ edit your own comments (chat-style comments) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-documents.sql (it is update 4 of 14).
-- (Fresh installs: already included in supabase-setup.sql.)

alter table public.comments add column if not exists edited_at timestamptz;

-- a signed-in user can edit only the text of their OWN comments
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and is_guest = false);

-- whatever the request says, only the text can change; the edit time is stamped by the database
create or replace function public.comments_guard() returns trigger
language plpgsql as $$
begin
  new.project_id := old.project_id;
  new.user_id    := old.user_id;
  new.author     := old.author;
  new.is_guest   := old.is_guest;
  new.created_at := old.created_at;
  new.body       := btrim(new.body);
  if new.body is distinct from old.body then new.edited_at := now(); else new.edited_at := old.edited_at; end if;
  return new;
end $$;
drop trigger if exists comments_guard on public.comments;
create trigger comments_guard before update on public.comments for each row execute function public.comments_guard();

grant select, insert, update, delete on public.comments to authenticated;

-- shared payload (both kinds of share link): comments now also carry edited_at
create or replace function public._project_payload(pid bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not exists (select 1 from public.projects where id = pid) then return null; end if;
  select jsonb_build_object(
    'project', (select to_jsonb(x) from (
        select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date, p.progress_mode, p.progress,
               coalesce(nullif(o.display_name,''), o.username) as owner_name
        from public.projects p left join public.profiles o on o.id = p.owner_id where p.id = pid) x),
    'tasks', coalesce((select jsonb_agg(to_jsonb(k) order by k.id) from (
        select id, title, done, status, percent from public.tasks where project_id = pid) k), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from (
        select id, name, path, kind, size, created_at from public.documents where project_id = pid) d), '[]'::jsonb),
    'topologies', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from (
        select id, name, path, mime, size, created_at from public.topologies where project_id = pid) t), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from (
        select id, author, is_guest, body, created_at, edited_at from public.comments where project_id = pid) c), '[]'::jsonb)
  ) into res;
  return res;
end $$;
revoke execute on function public._project_payload(bigint) from public, anon, authenticated;

-- ============ activity log (admin only, auto-deleted after 72 hours) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-comments.sql (it is update 5 of 14).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- The database itself writes the log (triggers), so a user cannot skip or fake it from the browser.
-- Only admins can read it. Entries older than 72 hours are hidden, purged on every new entry,
-- and (when pg_cron is available) purged every hour.

create table if not exists public.activity_logs (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_id   uuid,
  actor      text not null default 'system',
  action     text not null,
  target     text not null default '',
  details    text not null default ''
);
create index if not exists activity_logs_created_idx on public.activity_logs (created_at desc);

alter table public.activity_logs enable row level security;
revoke all on public.activity_logs from anon, authenticated;
grant select on public.activity_logs to authenticated;
drop policy if exists logs_admin_read on public.activity_logs;
create policy logs_admin_read on public.activity_logs for select to authenticated
  using (public.my_role() = 'admin' and created_at > now() - interval '72 hours');

-- internal writer: not callable from the browser
create or replace function public._log(p_action text, p_target text, p_details text, p_actor text default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); who text;
begin
  if p_actor is not null then who := p_actor;
  elsif uid is not null then
    select coalesce(nullif(display_name, ''), username) into who from public.profiles where id = uid;
  end if;
  insert into public.activity_logs (actor_id, actor, action, target, details)
  values (uid, coalesce(who, 'system'), p_action, left(coalesce(p_target, ''), 200), left(coalesce(p_details, ''), 600));
  delete from public.activity_logs where created_at < now() - interval '72 hours';   -- 72-hour retention
end $$;
revoke execute on function public._log(text, text, text, text) from public, anon, authenticated;

-- events only the browser can see (sign in / out, password changes, opening a project or document)
create or replace function public.log_event(p_action text, p_target text default '', p_details text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is null then return; end if;
  if p_action not in ('login', 'logout', 'password.change', 'project.view', 'document.view', 'user.password_reset') then return; end if;
  if p_action = 'user.password_reset' and public.my_role() <> 'admin' then return; end if;
  perform public._log(p_action, p_target, p_details);
end $$;
revoke execute on function public.log_event(text, text, text) from public, anon;
grant execute on function public.log_event(text, text, text) to authenticated;

-- one trigger function records every change to projects, tasks, documents, topologies, comments, users and dashboard links
create or replace function public._audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare pname text; d text; uname text;
begin
  if TG_TABLE_NAME = 'projects' then
    if TG_OP = 'INSERT' then
      perform public._log('project.create', NEW.name, 'status ' || NEW.status || ', priority ' || NEW.priority);
    elsif TG_OP = 'UPDATE' then
      d := concat_ws('; ',
        case when NEW.name is distinct from OLD.name then 'name: ' || OLD.name || ' -> ' || NEW.name end,
        case when NEW.status is distinct from OLD.status then 'status: ' || OLD.status || ' -> ' || NEW.status end,
        case when NEW.priority is distinct from OLD.priority then 'priority: ' || OLD.priority || ' -> ' || NEW.priority end,
        case when NEW.start_date is distinct from OLD.start_date then 'start: ' || coalesce(OLD.start_date::text, 'none') || ' -> ' || coalesce(NEW.start_date::text, 'none') end,
        case when NEW.due_date is distinct from OLD.due_date then 'due: ' || coalesce(OLD.due_date::text, 'none') || ' -> ' || coalesce(NEW.due_date::text, 'none') end,
        case when NEW.owner_id is distinct from OLD.owner_id then 'owner changed' end,
        case when NEW.progress_mode is distinct from OLD.progress_mode then 'progress mode: ' || NEW.progress_mode end,
        case when NEW.progress is distinct from OLD.progress then 'manual progress: ' || OLD.progress || '% -> ' || NEW.progress || '%' end,
        case when NEW.description is distinct from OLD.description then 'description edited' end,
        case when NEW.share_token is distinct from OLD.share_token then
          case when NEW.share_token is null then 'share link disabled' when OLD.share_token is null then 'share link enabled' else 'share link regenerated' end end);
      if d <> '' then perform public._log('project.update', NEW.name, d); end if;
    else
      perform public._log('project.delete', OLD.name, '');
    end if;
    return null;

  elsif TG_TABLE_NAME = 'tasks' then
    if TG_OP = 'DELETE' then
      select name into pname from public.projects where id = OLD.project_id;
      if pname is not null then perform public._log('task.delete', pname, OLD.title); end if;   -- skip when the whole project was deleted
    else
      select name into pname from public.projects where id = NEW.project_id;
      if TG_OP = 'INSERT' then
        perform public._log('task.create', pname, NEW.title);
      else
        d := concat_ws('; ',
          case when NEW.title is distinct from OLD.title then 'title: ' || OLD.title || ' -> ' || NEW.title end,
          case when NEW.status is distinct from OLD.status then 'status: ' || OLD.status || ' -> ' || NEW.status end,
          case when NEW.status = 'in_progress' and NEW.percent is distinct from OLD.percent then 'progress: ' || NEW.percent || '%' end);
        if d <> '' then perform public._log('task.update', pname, '"' || NEW.title || '" ' || d); end if;
      end if;
    end if;
    return null;

  elsif TG_TABLE_NAME = 'documents' then
    if TG_OP = 'INSERT' then
      select name into pname from public.projects where id = NEW.project_id;
      perform public._log('document.upload', pname, NEW.name || ' (' || NEW.kind || ')');
    else
      select name into pname from public.projects where id = OLD.project_id;
      if pname is not null then perform public._log('document.delete', pname, OLD.name); end if;
    end if;
    return null;

  elsif TG_TABLE_NAME = 'topologies' then
    if TG_OP = 'INSERT' then
      select name into pname from public.projects where id = NEW.project_id;
      perform public._log('topology.upload', pname, NEW.name);
    else
      select name into pname from public.projects where id = OLD.project_id;
      if pname is not null then perform public._log('topology.delete', pname, OLD.name); end if;
    end if;
    return null;

  elsif TG_TABLE_NAME = 'comments' then
    if TG_OP = 'INSERT' then
      select name into pname from public.projects where id = NEW.project_id;
      perform public._log('comment.add', pname, left(NEW.body, 150), case when NEW.is_guest then 'Guest: ' || NEW.author end);
    elsif TG_OP = 'UPDATE' then
      if NEW.body is distinct from OLD.body then
        select name into pname from public.projects where id = NEW.project_id;
        perform public._log('comment.edit', pname, left(NEW.body, 150));
      end if;
    else
      select name into pname from public.projects where id = OLD.project_id;
      if pname is not null then perform public._log('comment.delete', pname, 'by ' || OLD.author); end if;
    end if;
    return null;

  elsif TG_TABLE_NAME = 'profiles' then
    if TG_OP = 'INSERT' then
      perform public._log('user.create', NEW.username, 'role ' || NEW.role);
    elsif TG_OP = 'UPDATE' then
      d := concat_ws('; ',
        case when NEW.role is distinct from OLD.role then 'role: ' || OLD.role || ' -> ' || NEW.role end,
        case when NEW.display_name is distinct from OLD.display_name then 'name changed' end);
      if d <> '' then perform public._log('user.update', NEW.username, d); end if;
    else
      perform public._log('user.delete', OLD.username, 'role ' || OLD.role);
    end if;
    return null;

  elsif TG_TABLE_NAME = 'dashboard_shares' then
    if TG_OP = 'DELETE' then select username into uname from public.profiles where id = OLD.user_id;
    else select username into uname from public.profiles where id = NEW.user_id; end if;
    perform public._log(case TG_OP when 'INSERT' then 'dashboard.share.enable' when 'UPDATE' then 'dashboard.share.regenerate' else 'dashboard.share.disable' end,
      coalesce(uname, ''), '');
    return null;
  end if;
  return null;
end $$;
revoke execute on function public._audit() from public, anon, authenticated;

drop trigger if exists audit_projects         on public.projects;
drop trigger if exists audit_tasks            on public.tasks;
drop trigger if exists audit_documents        on public.documents;
drop trigger if exists audit_topologies       on public.topologies;
drop trigger if exists audit_comments         on public.comments;
drop trigger if exists audit_profiles         on public.profiles;
drop trigger if exists audit_dashboard_shares on public.dashboard_shares;
create trigger audit_projects         after insert or update or delete on public.projects         for each row execute function public._audit();
create trigger audit_tasks            after insert or update or delete on public.tasks            for each row execute function public._audit();
create trigger audit_documents        after insert or delete           on public.documents        for each row execute function public._audit();
create trigger audit_topologies       after insert or delete           on public.topologies       for each row execute function public._audit();
create trigger audit_comments         after insert or update or delete on public.comments         for each row execute function public._audit();
create trigger audit_profiles         after insert or update or delete on public.profiles         for each row execute function public._audit();
create trigger audit_dashboard_shares after insert or update or delete on public.dashboard_shares for each row execute function public._audit();

-- hourly purge when the pg_cron extension is available (otherwise the purge on every new entry + the 72h read filter apply)
do $$
begin
  begin
    create extension if not exists pg_cron;
    begin perform cron.unschedule('purge_activity_logs'); exception when others then null; end;
    perform cron.schedule('purge_activity_logs', '0 * * * *', $c$delete from public.activity_logs where created_at < now() - interval '72 hours'$c$);
  exception when others then
    raise notice 'pg_cron is not available: logs are still deleted after 72 hours (purged on each new entry, hidden when older).';
  end;
end $$;

-- ============ per-user privacy + admin share links for chosen users ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-logs.sql (it is update 6 of 14).
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

-- ============ edit a user's username and display name (admin only) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-privacy.sql (it is update 7 of 14).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- The login of a user is "username@tracker.example.com" inside Supabase Auth, so renaming a user
-- changes that address too. The user's password, role and projects stay exactly as they are.
-- The user signs in with the NEW username from then on.

create or replace function public.admin_edit_user(p_id uuid, p_username text, p_display text) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.profiles; newname text; em text;
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'Admin only'; end if;
  select * into cur from public.profiles where id = p_id;
  if not found then raise exception 'User not found'; end if;

  newname := btrim(coalesce(p_username, cur.username));
  if newname !~ '^[A-Za-z0-9._-]{3,32}$' then
    raise exception 'Username must be 3-32 characters: letters, numbers, . _ -';
  end if;

  if newname <> cur.username then
    if exists (select 1 from public.profiles where lower(username) = lower(newname) and id <> p_id) then
      raise exception 'Username already exists';
    end if;
    em := lower(newname) || '@tracker.example.com';
    if exists (select 1 from auth.users where lower(email) = em and id <> p_id) then
      raise exception 'Username already exists';
    end if;
    update auth.users set email = em, updated_at = now() where id = p_id;
    update auth.identities set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(em)), updated_at = now()
      where user_id = p_id and provider = 'email';
    update public.profiles set username = newname where id = p_id;
    perform public._log('user.update', newname, 'username: ' || cur.username || ' -> ' || newname);
  end if;

  if p_display is not null then
    update public.profiles set display_name = left(coalesce(nullif(btrim(p_display), ''), newname), 60) where id = p_id;
  end if;
end $$;

revoke execute on function public.admin_edit_user(uuid, text, text) from public, anon;
grant execute on function public.admin_edit_user(uuid, text, text) to authenticated;

-- ============ share a project with other users + @tag people in comments ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-users.sql (it is update 8 of 14).
-- If you ever re-run supabase-update-privacy.sql, run this file again afterwards (it extends the same rules).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- The owner of a project (or an admin) can share it with other Project Owners, and a person it is shared with can leave it again. A person a project is shared with
-- can OPEN it, read everything in it and add comments (and tag people with @username), but cannot change it.
-- Nobody else sees the project: the privacy rule "an owner sees only their own projects" still holds for everyone else.

create table if not exists public.project_members (
  project_id bigint not null references public.projects(id) on delete cascade,
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  added_by   uuid   references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user_idx on public.project_members (user_id);
alter table public.project_members enable row level security;   -- no policies: only the functions below read or write it
revoke all on public.project_members from anon, authenticated;

-- who can see a project: admins, reviewers, the owner of the project and the users it is shared with
create or replace function public.can_see_project(pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_role()
    when 'admin' then true
    when 'reviewer' then true
    when 'owner' then
      exists (select 1 from public.projects where id = pid and owner_id = auth.uid())
      or exists (select 1 from public.project_members where project_id = pid and user_id = auth.uid())
    else false end
$$;

drop policy if exists projects_read on public.projects;
-- owner_id = auth.uid() is checked on the row itself: the function below cannot see a row that is being inserted in the same statement
create policy projects_read on public.projects for select to authenticated using (owner_id = auth.uid() or public.can_see_project(id));

-- a user may also read the profile of the owner of any project they can see (to show "Owner: name")
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.my_role() in ('admin', 'reviewer')
         or exists (select 1 from public.projects p where p.owner_id = profiles.id and public.can_see_project(p.id)));

-- people on a project: its owner and the users it is shared with
create or replace function public.project_people(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_see_project(p_id) then return null; end if;
  return jsonb_build_object(
    'owner', (select jsonb_build_object('id', o.id, 'username', o.username, 'name', coalesce(nullif(o.display_name, ''), o.username))
              from public.projects p join public.profiles o on o.id = p.owner_id where p.id = p_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'name', coalesce(nullif(u.display_name, ''), u.username)) order by u.username)
              from public.project_members m join public.profiles u on u.id = m.user_id where m.project_id = p_id), '[]'::jsonb));
end $$;

-- the Project Owners you can choose from when sharing (never includes yourself)
create or replace function public.shareable_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.my_role(), '') not in ('admin', 'owner') then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'username', username, 'name', coalesce(nullif(display_name, ''), username)) order by username)
                   from public.profiles where role = 'owner' and id is distinct from auth.uid()), '[]'::jsonb);
end $$;

-- replace the list of users a project is shared with (only the owner of the project or an admin)
create or replace function public.set_project_members(p_id bigint, p_user_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; pname text; powner uuid; names text;
begin
  if not public.can_edit_project(p_id) then raise exception 'Only the owner of the project or an admin can share it'; end if;
  select name, owner_id into pname, powner from public.projects where id = p_id;
  select coalesce(array_agg(id), '{}'::uuid[]) into ids from public.profiles
    where id = any (coalesce(p_user_ids, '{}'::uuid[])) and role = 'owner' and id is distinct from powner;
  delete from public.project_members where project_id = p_id and not (user_id = any (ids));
  insert into public.project_members (project_id, user_id, added_by)
    select p_id, u, auth.uid() from unnest(ids) as u on conflict do nothing;
  select string_agg(coalesce(nullif(display_name, ''), username), ', ' order by username) into names from public.profiles where id = any (ids);
  perform public._log('project.share', pname, coalesce('shared with: ' || names, 'sharing with other users removed'));
end $$;

revoke execute on function public.can_see_project(bigint) from public, anon;
grant  execute on function public.can_see_project(bigint) to authenticated;
revoke execute on function public.project_people(bigint) from public, anon;
revoke execute on function public.shareable_users() from public, anon;
revoke execute on function public.set_project_members(bigint, uuid[]) from public, anon;
grant  execute on function public.project_people(bigint) to authenticated;
grant  execute on function public.shareable_users() to authenticated;
grant  execute on function public.set_project_members(bigint, uuid[]) to authenticated;

-- a user a project was shared with can leave it (remove it from their own list); the owner keeps the project
create or replace function public.leave_project(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare pname text; who text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from public.project_members where project_id = p_id and user_id = auth.uid()) then
    raise exception 'This project is not shared with you';
  end if;
  select name into pname from public.projects where id = p_id;
  delete from public.project_members where project_id = p_id and user_id = auth.uid();
  perform public._log('project.share', pname, 'left the shared project');
end $$;
revoke execute on function public.leave_project(bigint) from public, anon;
grant  execute on function public.leave_project(bigint) to authenticated;

-- ============ reminders: someone tagged you (@) or shared a project with you ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-sharing.sql (it is update 9 of 14).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- The database creates a reminder for a person when
--   * a comment tags them with @username (and they can see that project), or
--   * a project is shared with them.
-- The app then shows a warning pop-up ("Your help is needed") on that person's screen until they mark it as read.
-- Reminders are private to the person they are for, and reminders older than 30 days are deleted.

-- stop early with a clear message when the previous update (sharing) has not been run yet
do $$
begin
  if to_regclass('public.project_members') is null then
    raise exception 'Run supabase-update-sharing.sql first (update 8 of 14), then run this file again.';
  end if;
end $$;
create table if not exists public.notifications (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('share', 'mention')),
  project_id   bigint references public.projects(id) on delete cascade,
  project_name text not null default '',
  from_name    text not null default '',
  message      text not null default '',
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, read_at);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;     -- the only thing a person can change: marking it as read
drop policy if exists notif_read   on public.notifications;
drop policy if exists notif_update on public.notifications;
create policy notif_read   on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notif_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- can this user see this project? (same rule as can_see_project, but for any user, not only the caller)
create or replace function public._user_sees_project(p_uid uuid, pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select case (select role from public.profiles where id = p_uid)
    when 'admin' then true
    when 'reviewer' then true
    when 'owner' then
      exists (select 1 from public.projects where id = pid and owner_id = p_uid)
      or exists (select 1 from public.project_members where project_id = pid and user_id = p_uid)
    else false end
$$;
revoke execute on function public._user_sees_project(uuid, bigint) from public, anon, authenticated;

-- a project was shared with someone
create or replace function public._notify_share() returns trigger
language plpgsql security definer set search_path = public as $$
declare pname text; sender text;
begin
  select name into pname from public.projects where id = NEW.project_id;
  select coalesce(nullif(display_name, ''), username) into sender from public.profiles where id = coalesce(NEW.added_by, auth.uid());
  insert into public.notifications (user_id, kind, project_id, project_name, from_name, message)
  values (NEW.user_id, 'share', NEW.project_id, coalesce(pname, ''), coalesce(sender, 'Someone'), 'shared this project with you');
  delete from public.notifications where created_at < now() - interval '30 days';
  return null;
end $$;
revoke execute on function public._notify_share() from public, anon, authenticated;
drop trigger if exists notify_share on public.project_members;
create trigger notify_share after insert on public.project_members for each row execute function public._notify_share();

-- someone was tagged with @username in a comment (new comment, or a name added while editing)
create or replace function public._notify_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare pname text; sender text; m text; target uuid; oldb text := '';
begin
  if TG_OP = 'UPDATE' then
    if NEW.body is not distinct from OLD.body then return null; end if;
    oldb := lower(coalesce(OLD.body, ''));
  end if;
  select name into pname from public.projects where id = NEW.project_id;
  sender := case when NEW.is_guest then 'Guest: ' || NEW.author else NEW.author end;
  for m in select distinct lower((regexp_matches(NEW.body, '@([A-Za-z0-9._-]{3,32})', 'g'))[1]) loop
    if TG_OP = 'UPDATE' and position('@' || m in oldb) > 0 then continue; end if;      -- already tagged before the edit
    select id into target from public.profiles where lower(username) = m;
    if target is null or target is not distinct from NEW.user_id then continue; end if;  -- unknown name, or tagging yourself
    if public._user_sees_project(target, NEW.project_id) then
      insert into public.notifications (user_id, kind, project_id, project_name, from_name, message)
      values (target, 'mention', NEW.project_id, coalesce(pname, ''), coalesce(sender, ''), left(NEW.body, 160));
    end if;
  end loop;
  return null;
end $$;
revoke execute on function public._notify_comment() from public, anon, authenticated;
drop trigger if exists notify_comment on public.comments;
create trigger notify_comment after insert or update on public.comments for each row execute function public._notify_comment();

-- ============ guests can edit or delete their own comments (share links) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-notifications.sql (it is update 10 of 14).
-- If you ever re-run supabase-update-dashboard-share.sql, run this file again afterwards.
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- A visitor with a share link has no account, so each guest comment gets a private "edit key".
-- The key is created when the comment is posted, is kept only in that visitor's browser, and only its hash is stored here.
-- Whoever holds the key (that browser) can edit or delete THAT comment, and nothing else.
-- Comments posted before this update have no key, so they can only be changed by the project's staff.

alter table public.comments add column if not exists guest_token_hash text;

-- can this share token (a project link OR a dashboard link) see this project?
create or replace function public._share_can_see(p_token text, pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token is not null and length(p_token) >= 20 and (
    exists (select 1 from public.projects where id = pid and share_token = p_token)
    or public._dashboard_can_see(p_token, pid))
$$;
revoke execute on function public._share_can_see(text, bigint) from public, anon, authenticated;

-- post a guest comment through a project link: now returns the comment id and its private edit key
drop function if exists public.shared_add_comment(text, text, text);
create function public.shared_add_comment(p_token text, p_author text, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pid bigint; tok text; nid bigint;
begin
  if p_token is null or length(p_token) < 20 then raise exception 'This link is invalid or has been disabled'; end if;
  select id into pid from public.projects where share_token = p_token;
  if pid is null then raise exception 'This link is invalid or has been disabled'; end if;
  p_author := btrim(coalesce(p_author, '')); p_body := btrim(coalesce(p_body, ''));
  if p_author = '' or char_length(p_author) > 50 then raise exception 'Name is required (max 50 characters)'; end if;
  if p_body = '' or char_length(p_body) > 2000 then raise exception 'Comment is required (max 2000 characters)'; end if;
  if (select count(*) from public.comments where project_id = pid and is_guest and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many guest comments, try again later';
  end if;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.comments (project_id, user_id, author, is_guest, body, guest_token_hash)
  values (pid, null, p_author, true, p_body, encode(extensions.digest(tok, 'sha256'), 'hex'))
  returning id into nid;
  return jsonb_build_object('id', nid, 'edit_token', tok);
end $$;

-- post a guest comment through a dashboard link
drop function if exists public.shared_dashboard_comment(text, bigint, text, text);
create function public.shared_dashboard_comment(p_token text, p_id bigint, p_author text, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tok text; nid bigint;
begin
  if not public._dashboard_can_see(p_token, p_id) then raise exception 'This link is invalid or has been disabled'; end if;
  p_author := btrim(coalesce(p_author, '')); p_body := btrim(coalesce(p_body, ''));
  if p_author = '' or char_length(p_author) > 50 then raise exception 'Name is required (max 50 characters)'; end if;
  if p_body = '' or char_length(p_body) > 2000 then raise exception 'Comment is required (max 2000 characters)'; end if;
  if (select count(*) from public.comments where is_guest and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many guest comments, try again later';
  end if;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.comments (project_id, user_id, author, is_guest, body, guest_token_hash)
  values (p_id, null, p_author, true, p_body, encode(extensions.digest(tok, 'sha256'), 'hex'))
  returning id into nid;
  return jsonb_build_object('id', nid, 'edit_token', tok);
end $$;

-- edit your own guest comment (p_token = the share link token you came in with, p_edit_token = your private key)
create or replace function public.shared_edit_comment(p_token text, p_id bigint, p_edit_token text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare pid bigint; h text;
begin
  select project_id, guest_token_hash into pid, h from public.comments where id = p_id and is_guest;
  if pid is null or h is null or p_edit_token is null
     or h <> encode(extensions.digest(p_edit_token, 'sha256'), 'hex') or not public._share_can_see(p_token, pid) then
    raise exception 'You can only change your own comments, from the browser you wrote them in';
  end if;
  p_body := btrim(coalesce(p_body, ''));
  if p_body = '' or char_length(p_body) > 2000 then raise exception 'Comment is required (max 2000 characters)'; end if;
  update public.comments set body = p_body where id = p_id;
end $$;

-- delete your own guest comment
create or replace function public.shared_delete_comment(p_token text, p_id bigint, p_edit_token text) returns void
language plpgsql security definer set search_path = public as $$
declare pid bigint; h text;
begin
  select project_id, guest_token_hash into pid, h from public.comments where id = p_id and is_guest;
  if pid is null or h is null or p_edit_token is null
     or h <> encode(extensions.digest(p_edit_token, 'sha256'), 'hex') or not public._share_can_see(p_token, pid) then
    raise exception 'You can only change your own comments, from the browser you wrote them in';
  end if;
  delete from public.comments where id = p_id;
end $$;

revoke execute on function public.shared_add_comment(text, text, text) from public;
revoke execute on function public.shared_dashboard_comment(text, bigint, text, text) from public;
revoke execute on function public.shared_edit_comment(text, bigint, text, text) from public;
revoke execute on function public.shared_delete_comment(text, bigint, text) from public;
grant execute on function public.shared_add_comment(text, text, text) to anon, authenticated;
grant execute on function public.shared_dashboard_comment(text, bigint, text, text) to anon, authenticated;
grant execute on function public.shared_edit_comment(text, bigint, text, text) to anon, authenticated;
grant execute on function public.shared_delete_comment(text, bigint, text) to anon, authenticated;

-- ============ GitHub repositories linked to a project + Excel / PowerPoint documents ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-guest-comments.sql (it is update 11 of 14).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- 1) A project can link GitHub repositories (or a folder / file inside one). Only the REFERENCE is stored here
--    (server, owner/name, branch, path). The access token / credentials are NEVER stored in the database:
--    each person keeps their own token in their own browser.
-- 2) Uploaded documents can now also be Excel (.xlsx, .xls) and PowerPoint (.pptx) files.
-- 3) A linked repository can be switched on for share links, so visitors see it too (the token is never shared).
-- 4) For PRIVATE repositories the owner can store a token on the server (Edge Function github-proxy, see README) so visitors can read the files.
-- If you ever re-run an earlier update that redefines the shared payload (progress, documents, comments), run this file again afterwards.

create table if not exists public.project_repos (
  id         bigint generated always as identity primary key,
  project_id bigint not null references public.projects(id) on delete cascade,
  api_base   text not null default 'https://api.github.com' check (api_base ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' and char_length(api_base) <= 200),
  repo       text not null check (repo ~ '^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$'),
  branch     text not null default '' check (char_length(branch) <= 200),
  path       text not null default '' check (char_length(path) <= 500),
  label      text not null default '' check (char_length(label) <= 80),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists project_repos_project_idx on public.project_repos (project_id);

grant select, insert, delete on public.project_repos to authenticated;
revoke all on public.project_repos from anon;
grant select, insert, delete on public.project_repos to authenticated;
alter table public.project_repos enable row level security;
drop policy if exists repos_read   on public.project_repos;
drop policy if exists repos_insert on public.project_repos;
drop policy if exists repos_delete on public.project_repos;
create policy repos_read   on public.project_repos for select to authenticated using (public.can_see_project(project_id));
create policy repos_insert on public.project_repos for insert to authenticated
  with check (public.can_edit_project(project_id) and created_by = auth.uid());
create policy repos_delete on public.project_repos for delete to authenticated using (public.can_edit_project(project_id));

-- activity log: repository linked / unlinked
create or replace function public._audit_repo() returns trigger
language plpgsql security definer set search_path = public as $$
declare pname text;
begin
  if TG_OP = 'INSERT' then
    select name into pname from public.projects where id = NEW.project_id;
    perform public._log('repo.link', pname, NEW.repo || case when NEW.path <> '' then ' / ' || NEW.path else '' end);
  else
    select name into pname from public.projects where id = OLD.project_id;
    if pname is not null then perform public._log('repo.unlink', pname, OLD.repo); end if;   -- not logged when the whole project was deleted
  end if;
  return null;
end $$;
revoke execute on function public._audit_repo() from public, anon, authenticated;
drop trigger if exists audit_project_repos on public.project_repos;
create trigger audit_project_repos after insert or delete on public.project_repos for each row execute function public._audit_repo();

-- document kinds: add Excel ("sheet") and PowerPoint ("slides")
alter table public.documents drop constraint if exists documents_kind_check;
alter table public.documents add constraint documents_kind_check check (kind in ('pdf', 'docx', 'html', 'sheet', 'slides'));

update storage.buckets set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation']
where id = 'documents';

-- ---------- repositories on share links (project link and dashboard link) ----------
-- A linked repository is shown to people who open a SHARE LINK only when the owner switches this on ("share_public").
-- Visitors have no GitHub token of their own by default, so they can open public repositories; a private one only
-- opens for a visitor who has their own GitHub access and adds it under Credentials. The owner's token is never shared.
alter table public.project_repos add column if not exists share_public boolean not null default false;
grant update (share_public) on public.project_repos to authenticated;
drop policy if exists repos_update on public.project_repos;
create policy repos_update on public.project_repos for update to authenticated
  using (public.can_edit_project(project_id)) with check (public.can_edit_project(project_id));

-- the shared payload (project link + dashboard link) now also lists the repositories marked "show on share links"
create or replace function public._project_payload(pid bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not exists (select 1 from public.projects where id = pid) then return null; end if;
  select jsonb_build_object(
    'project', (select to_jsonb(x) from (
        select p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date, p.progress_mode, p.progress,
               coalesce(nullif(o.display_name,''), o.username) as owner_name
        from public.projects p left join public.profiles o on o.id = p.owner_id where p.id = pid) x),
    'tasks', coalesce((select jsonb_agg(to_jsonb(k) order by k.id) from (
        select id, title, done, status, percent from public.tasks where project_id = pid) k), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from (
        select id, name, path, kind, size, created_at from public.documents where project_id = pid) d), '[]'::jsonb),
    'repos', coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from (
        select id, api_base, repo, branch, path, label, has_server_token from public.project_repos where project_id = pid and share_public) r), '[]'::jsonb),
    'topologies', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from (
        select id, name, path, mime, size, created_at from public.topologies where project_id = pid) t), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from (
        select id, author, is_guest, body, created_at, edited_at from public.comments where project_id = pid) c), '[]'::jsonb)
  ) into res;
  return res;
end $$;
revoke execute on function public._project_payload(bigint) from public, anon, authenticated;

-- ---------- private repositories for share-link visitors: the OWNER stores the token on the server ----------
-- The token is sent once to the Edge Function "github-proxy", which encrypts it (AES-GCM with a key that only the function knows)
-- and stores the encrypted text in repo_secrets. Nobody can read this table from the browser (no policies, no grants).
-- When someone opens the files, the browser asks the Edge Function; it checks that the person may see the project
-- (signed in, or holding a valid share link for a repository switched "on share links"), then fetches ONLY that repository
-- (and only inside the linked folder) from GitHub with the stored token and returns the file. The token never reaches a browser.
create table if not exists public.repo_secrets (
  repo_id   bigint primary key references public.project_repos(id) on delete cascade,
  token_enc text not null,
  saved_by  uuid references public.profiles(id) on delete set null,
  saved_at  timestamptz not null default now()
);
alter table public.repo_secrets enable row level security;     -- no policies: only the Edge Function (service role) can touch it
revoke all on public.repo_secrets from anon, authenticated;

alter table public.project_repos add column if not exists has_server_token boolean not null default false;
-- browsers may not set has_server_token themselves (only the Edge Function does): limit what an insert can set
revoke insert on public.project_repos from authenticated;
grant insert (project_id, api_base, repo, branch, path, label, created_by, share_public) on public.project_repos to authenticated;

-- helpers used ONLY by the Edge Function (service role); the browser cannot call them
create or replace function public._user_edits_project(p_uid uuid, pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_uid and role = 'admin')
      or exists (select 1 from public.projects where id = pid and owner_id = p_uid)
$$;

create or replace function public.gh_proxy_repo(p_repo_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(x) from (select id, project_id, api_base, repo, branch, path, share_public, has_server_token
                           from public.project_repos where id = p_repo_id) x
$$;

-- may this caller read this repository's files through the server? (signed-in user who sees the project, or a valid share link)
create or replace function public.gh_proxy_authorize(p_repo_id bigint, p_share_token text, p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.project_repos;
begin
  select * into r from public.project_repos where id = p_repo_id;
  if not found then return null; end if;
  if p_user_id is not null and public._user_sees_project(p_user_id, r.project_id) then
    return public.gh_proxy_repo(p_repo_id);
  end if;
  if p_share_token is not null and r.share_public and public._share_can_see(p_share_token, r.project_id) then
    return public.gh_proxy_repo(p_repo_id);
  end if;
  return null;
end $$;

create or replace function public.gh_proxy_can_edit(p_repo_id bigint, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public._user_edits_project(p_user_id, project_id) from public.project_repos where id = p_repo_id), false)
$$;

-- activity log: the token was stored / removed (the token itself is never logged)
create or replace function public.gh_proxy_audit(p_repo_id bigint, p_user_id uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare pname text; rname text; who text;
begin
  select p.name, r.repo into pname, rname from public.project_repos r join public.projects p on p.id = r.project_id where r.id = p_repo_id;
  select coalesce(nullif(display_name, ''), username) into who from public.profiles where id = p_user_id;
  perform public._log('repo.token', pname, case when p_action = 'set' then 'server token saved for ' else 'server token removed for ' end || coalesce(rname, ''), who);
end $$;

revoke execute on function public._user_edits_project(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.gh_proxy_repo(bigint) from public, anon, authenticated;
revoke execute on function public.gh_proxy_authorize(bigint, text, uuid) from public, anon, authenticated;
revoke execute on function public.gh_proxy_can_edit(bigint, uuid) from public, anon, authenticated;
revoke execute on function public.gh_proxy_audit(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.gh_proxy_repo(bigint) to service_role;
grant execute on function public.gh_proxy_authorize(bigint, text, uuid) to service_role;
grant execute on function public.gh_proxy_can_edit(bigint, uuid) to service_role;
grant execute on function public.gh_proxy_audit(bigint, uuid, text) to service_role;

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

-- ============ delete activity log entries by hand (admin only) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-logs.sql (it is update 13 of 14; run the others first if you have not).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- The automatic clean-up does NOT change: every entry is still deleted 72 hours after it was recorded.
-- These two functions only let an admin remove entries EARLIER, by hand, from the Activity log page.
-- Deleting entries always leaves a trace: one new entry ("deleted by hand", who, when, from which address, how many)
-- is written after the deletion, and that entry is itself deleted automatically after 72 hours like any other.

-- delete the chosen entries (at most 2000 at a time)
create or replace function public.admin_delete_logs(p_ids bigint[]) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'Only admins can delete log entries'; end if;
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;
  if array_length(p_ids, 1) > 2000 then raise exception 'Choose at most 2000 entries at a time'; end if;
  delete from public.activity_logs where id = any (p_ids);
  get diagnostics n = row_count;
  if n > 0 then
    perform public._log('logs.delete', '', n || ' log entr' || case when n = 1 then 'y' else 'ies' end || ' deleted by hand');
  end if;
  return n;
end $$;

-- delete every entry
create or replace function public.admin_clear_logs() returns integer
language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'Only admins can delete log entries'; end if;
  delete from public.activity_logs where id is not null;   -- the explicit condition is required: Supabase refuses a DELETE without a WHERE clause
  get diagnostics n = row_count;
  perform public._log('logs.clear', '', 'the whole log was cleared by hand (' || n || ' entr' || case when n = 1 then 'y' else 'ies' end || ')');
  return n;
end $$;

revoke execute on function public.admin_delete_logs(bigint[]) from public, anon;
revoke execute on function public.admin_clear_logs() from public, anon;
grant execute on function public.admin_delete_logs(bigint[]) to authenticated;
grant execute on function public.admin_clear_logs() to authenticated;

-- ============ first admin (not callable from the web, SQL editor only) ============
create or replace function public.bootstrap_admin(p_username text, p_password text, p_display text default '') returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if exists (select 1 from public.profiles) then raise exception 'Setup already completed'; end if;
  uid := public._create_auth_user(p_username, p_password);
  insert into public.profiles (id, username, display_name, role)
  values (uid, btrim(p_username), left(coalesce(nullif(btrim(p_display),''), btrim(p_username)), 60), 'admin');
end $$;
revoke execute on function public.bootstrap_admin(text, text, text) from public, anon, authenticated;

-- >>> EDIT username and password, then run this line (as a second query is fine):
select public.bootstrap_admin('admin', 'password-here', 'Administrator');

-- ============ pasted images in comments ============
-- Images pasted into a comment are stored in the public bucket "comment-images" under an unguessable name and the comment keeps a short
-- marker [img:<path>]. Signed-in users upload to u/<their id>/..., visitors with a share link upload to <share token>/... (only a valid
-- link can upload). Images are limited to 3 MB, PNG / JPEG / GIF / WebP. The comment text limit (2000 characters) is unchanged.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comment-images', 'comment-images', true, 3145728, array['image/png','image/jpeg','image/gif','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728,
  allowed_mime_types = array['image/png','image/jpeg','image/gif','image/webp'];

-- is this text a currently valid share link (project link, owner dashboard link or admin dashboard link)?
create or replace function public._valid_share_token(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token is not null and length(p_token) >= 16 and (
    exists (select 1 from public.projects where share_token = p_token)
    or exists (select 1 from public.dashboard_shares where token = p_token)
    or exists (select 1 from public.admin_share_links where token = p_token))
$$;
revoke execute on function public._valid_share_token(text) from public;
grant execute on function public._valid_share_token(text) to anon, authenticated;

drop policy if exists cimg_obj_insert_user  on storage.objects;
drop policy if exists cimg_obj_insert_guest on storage.objects;
drop policy if exists cimg_obj_delete       on storage.objects;
create policy cimg_obj_insert_user on storage.objects for insert to authenticated
  with check (bucket_id = 'comment-images' and public.my_role() is not null
              and ((storage.foldername(name))[1] = 'u' and (storage.foldername(name))[2] = auth.uid()::text
                   or public._valid_share_token((storage.foldername(name))[1])));
create policy cimg_obj_insert_guest on storage.objects for insert to anon
  with check (bucket_id = 'comment-images' and public._valid_share_token((storage.foldername(name))[1]));
create policy cimg_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'comment-images' and (storage.foldername(name))[1] = 'u' and (storage.foldername(name))[2] = auth.uid()::text);
