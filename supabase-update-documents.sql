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
