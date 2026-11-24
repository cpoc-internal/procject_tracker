-- ============ guests can edit or delete their own comments (share links) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-notifications.sql (it is update 10 of 13).
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
