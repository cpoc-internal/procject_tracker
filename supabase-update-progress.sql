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
