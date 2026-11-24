-- ============ share a project with other users + @tag people in comments ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-users.sql (it is update 8 of 11).
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
create policy projects_read on public.projects for select to authenticated using (public.can_see_project(id));

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