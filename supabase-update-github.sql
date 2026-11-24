-- ============ GitHub repositories linked to a project + Excel / PowerPoint documents ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-guest-comments.sql (it is update 11 of 11).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- 1) A project can link GitHub repositories (or a folder / file inside one). Only the REFERENCE is stored here
--    (server, owner/name, branch, path). The access token / credentials are NEVER stored in the database:
--    each person keeps their own token in their own browser.
-- 2) Uploaded documents can now also be Excel (.xlsx, .xls) and PowerPoint (.pptx) files.

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
