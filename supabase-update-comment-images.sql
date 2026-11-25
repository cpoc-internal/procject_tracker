-- ============ comment images: paste a screenshot into a comment ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-log-delete.sql (it is update 14 of 14).
-- (Fresh installs: already included in supabase-setup.sql.)
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
