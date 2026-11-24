-- ============ GitHub repositories linked to a project + Excel / PowerPoint documents ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-guest-comments.sql (it is update 11 of 13).
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