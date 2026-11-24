-- ============ reminders: someone tagged you (@) or shared a project with you ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-sharing.sql (it is update 9 of 13).
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
    raise exception 'Run supabase-update-sharing.sql first (update 8 of 13), then run this file again.';
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
