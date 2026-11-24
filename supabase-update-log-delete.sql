-- ============ delete activity log entries by hand (admin only) ============
-- Existing install: run this whole file once in Supabase -> SQL Editor (safe to re-run).
-- Run it AFTER supabase-update-logs.sql (it is update 13 of 13; run the others first if you have not).
-- (Fresh installs: already included in supabase-setup.sql.)
--
-- The automatic clean-up does NOT change: every entry is still deleted 72 hours after it was recorded.
-- These two functions only let an admin remove entries EARLIER, by hand, from the Activity log page.
-- Deleting entries always leaves a trace: one new entry ("deleted by hand", who, when, from which address, how many)
-- is written after the deletion, and that entry is itself deleted automatically after 72 hours like any other.

-- delete the chosen entries (at most 2000 at a time)
create or replace function public.admin_delete_logs(p_ids bigint[]) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'Only admins can delete log entries'; end if;
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;
  if array_length(p_ids, 1) > 2000 then raise exception 'Choose at most 2000 entries at a time'; end if;
  delete from public.activity_logs where id = any (p_ids);
  get diagnostics n = row_count;
  if n > 0 then
    perform public._log('logs.delete', '', n || ' log entr' || case when n = 1 then 'y' else 'ies' end || ' deleted by hand');
  end if;
  return n;
end $$;

-- delete every entry
create or replace function public.admin_clear_logs() returns integer
language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'Only admins can delete log entries'; end if;
  delete from public.activity_logs;
  get diagnostics n = row_count;
  perform public._log('logs.clear', '', 'the whole log was cleared by hand (' || n || ' entr' || case when n = 1 then 'y' else 'ies' end || ')');
  return n;
end $$;

revoke execute on function public.admin_delete_logs(bigint[]) from public, anon;
revoke execute on function public.admin_clear_logs() from public, anon;
grant execute on function public.admin_delete_logs(bigint[]) to authenticated;
grant execute on function public.admin_clear_logs() to authenticated;
