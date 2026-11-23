-- ============ edit your own comments (chat-style comments) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-documents.sql (it is update 4 of 4).
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
