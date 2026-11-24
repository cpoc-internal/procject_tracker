-- ============ edit a user's username and display name (admin only) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-privacy.sql (it is update 7 of 11).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- The login of a user is "username@tracker.example.com" inside Supabase Auth, so renaming a user
-- changes that address too. The user's password, role and projects stay exactly as they are.
-- The user signs in with the NEW username from then on.

create or replace function public.admin_edit_user(p_id uuid, p_username text, p_display text) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.profiles; newname text; em text;
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'Admin only'; end if;
  select * into cur from public.profiles where id = p_id;
  if not found then raise exception 'User not found'; end if;

  newname := btrim(coalesce(p_username, cur.username));
  if newname !~ '^[A-Za-z0-9._-]{3,32}$' then
    raise exception 'Username must be 3-32 characters: letters, numbers, . _ -';
  end if;

  if newname <> cur.username then
    if exists (select 1 from public.profiles where lower(username) = lower(newname) and id <> p_id) then
      raise exception 'Username already exists';
    end if;
    em := lower(newname) || '@tracker.example.com';
    if exists (select 1 from auth.users where lower(email) = em and id <> p_id) then
      raise exception 'Username already exists';
    end if;
    update auth.users set email = em, updated_at = now() where id = p_id;
    update auth.identities set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(em)), updated_at = now()
      where user_id = p_id and provider = 'email';
    update public.profiles set username = newname where id = p_id;
    perform public._log('user.update', newname, 'username: ' || cur.username || ' -> ' || newname);
  end if;

  if p_display is not null then
    update public.profiles set display_name = left(coalesce(nullif(btrim(p_display), ''), newname), 60) where id = p_id;
  end if;
end $$;

revoke execute on function public.admin_edit_user(uuid, text, text) from public, anon;
grant execute on function public.admin_edit_user(uuid, text, text) to authenticated;
