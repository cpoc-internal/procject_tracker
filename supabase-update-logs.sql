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
