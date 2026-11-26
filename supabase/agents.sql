-- מיילסטון 13: סוכן מנהל הקהילה ודוח הבוקר
-- מריצים פעם אחת ב-SQL Editor של Supabase, אחרי community.sql ו-popular-savings.sql. אפשר להריץ שוב בלי נזק.
--
-- n8n קורא לפונקציות כאן עם ה-Credential של Supabase (service_role). הדפדפן לא רואה כלום מזה:
-- לא את agent_events, לא את עמודות הסוכן, ולא את הפונקציות.
--
-- איחוד בקשות: הסוכן כותב duplicate_of. יוני כותב בעורך status = merged, והקולות עוברים לבקשה ב-duplicate_of.

-- ---------- עמודות הסוכן ----------

alter table public.price_reports
  add column if not exists agent_advice text check (agent_advice in ('approve', 'reject', 'check', 'merge')),
  add column if not exists agent_reason text check (char_length(agent_reason) <= 200),
  add column if not exists agent_priority integer check (agent_priority between 0 and 100),
  add column if not exists agent_checked_at timestamptz,
  add column if not exists duplicate_of bigint references public.price_reports (id) on delete set null;

alter table public.product_requests
  add column if not exists agent_advice text check (agent_advice in ('approve', 'reject', 'check', 'merge')),
  add column if not exists agent_reason text check (char_length(agent_reason) <= 200),
  add column if not exists agent_priority integer check (agent_priority between 0 and 100),
  add column if not exists agent_checked_at timestamptz,
  add column if not exists duplicate_of bigint references public.product_requests (id) on delete set null;

-- סטטוס חדש לבקשה: merged (אוחדה לבקשה אחרת)
alter table public.product_requests drop constraint if exists product_requests_status_check;
alter table public.product_requests add constraint product_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'added', 'merged'));

-- הדפדפן מקבל הרשאה לעמודות מסוימות בלבד (community.sql), ולכן העמודות החדשות מוסתרות ממנו.

-- דיווח שעודכן (אותו משתמש, מוצר ורשת באותו יום) נבדק מחדש
create or replace function public.reset_agent_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.price is distinct from old.price then
    new.agent_checked_at := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.reset_agent_check() from public, anon, authenticated;

drop trigger if exists price_reports_reset_agent on public.price_reports;
create trigger price_reports_reset_agent
  before update on public.price_reports
  for each row execute function public.reset_agent_check();

-- ---------- אירועי הסוכנים ----------

create table if not exists public.agent_events (
  id bigint generated always as identity primary key,
  agent text not null check (agent in ('community', 'promos', 'product_match', 'catalog')),
  kind text not null check (kind in ('action', 'info')),
  title text not null check (char_length(title) <= 300),
  ref_table text,
  ref_id bigint,
  created_at timestamptz not null default now(),
  reported_at timestamptz,
  handled_at timestamptz
);

-- אירוע פתוח אחד לכל שורה: בדיקה חוזרת מעדכנת אותו, ולא יוצרת חדש
create unique index if not exists agent_events_open_ref
  on public.agent_events (agent, ref_table, ref_id)
  where handled_at is null and ref_id is not null;

create index if not exists agent_events_open_idx on public.agent_events (created_at) where handled_at is null;

alter table public.agent_events enable row level security;
revoke all on public.agent_events from anon, authenticated;

-- כשיוני מחליט על דיווח או בקשה (הסטטוס יוצא מ-pending), האירוע שלהם מטופל
create or replace function public.close_agent_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status <> 'pending' then
    update public.agent_events
      set handled_at = now()
      where ref_table = tg_table_name and ref_id = new.id and handled_at is null;
  end if;
  return null;
end;
$$;

revoke execute on function public.close_agent_event() from public, anon, authenticated;

drop trigger if exists price_reports_close_event on public.price_reports;
create trigger price_reports_close_event
  after update on public.price_reports
  for each row execute function public.close_agent_event();

drop trigger if exists product_requests_close_event on public.product_requests;
create trigger product_requests_close_event
  after update on public.product_requests
  for each row execute function public.close_agent_event();

-- ---------- איחוד בקשות: הקולות עוברים ----------
-- רץ אחרי set_decided_at, שכבר הפך את הסטטוס לאותיות קטנות.
-- קודם מוחקים את הקולות מהבקשה שאוחדה, ורק אז מוסיפים לבקשה המקורית, כדי שמגבלת 5 הקולות לא תחסום.
-- מי שהצביע על שתיהן נשאר עם קול אחד, והקול השני חוזר אליו.
create or replace function public.merge_request_votes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_status text;
begin
  if new.status <> 'merged' or old.status = 'merged' then
    return null;
  end if;
  if new.duplicate_of is null or new.duplicate_of = new.id then
    raise exception 'merged דורש duplicate_of: מספר הבקשה שאליה מאחדים';
  end if;
  select status into target_status from public.product_requests where id = new.duplicate_of;
  if target_status is null or target_status in ('merged', 'rejected') then
    raise exception 'הבקשה % לא קיימת, או שהיא עצמה אוחדה או נדחתה', new.duplicate_of;
  end if;

  with moved as (
    delete from public.request_votes where request_id = new.id returning user_id
  )
  insert into public.request_votes (user_id, request_id)
  select user_id, new.duplicate_of from moved
  on conflict (user_id, request_id) do nothing;

  return null;
end;
$$;

revoke execute on function public.merge_request_votes() from public, anon, authenticated;

drop trigger if exists product_requests_merge on public.product_requests;
create trigger product_requests_merge
  after update on public.product_requests
  for each row execute function public.merge_request_votes();

-- ---------- קלט לסוכן מנהל הקהילה ----------
-- כל הדיווחים הממתינים, דיווחים מאושרים מ-3 הימים האחרונים, הבקשות, והוספות לסל מ-7 הימים האחרונים.
-- במקום user_id: קוד קצר (reporter) שמספיק כדי לספור מדווחים שונים, בלי לחשוף מי הם.
create or replace function public.agent_community_input()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'barcode', r.barcode, 'chain_id', r.chain_id, 'price', r.price,
        'official_price', r.official_price, 'status', r.status, 'created_at', r.created_at,
        'decided_at', r.decided_at, 'checked', r.agent_checked_at is not null,
        'reporter', left(md5(r.user_id::text), 10),
        'current_price', ci.price, 'current_price_per_kg', ci.price_per_kg
      ) order by r.id)
      from public.price_reports r
      left join lateral (
        select c.price, c.price_per_kg from public.chain_items c
        where c.chain_id = r.chain_id and c.item_code = r.item_code
        limit 1
      ) ci on true
      where r.status = 'pending'
         or (r.status = 'approved' and r.decided_at > now() - interval '3 days')
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'name', q.name, 'status', q.status, 'checked', q.agent_checked_at is not null,
        'votes', (select count(*) from public.request_votes v where v.request_id = q.id)
      ) order by q.id)
      from public.product_requests q
      where q.status in ('pending', 'approved', 'added')
    ), '[]'::jsonb),
    'adds', coalesce((
      select jsonb_object_agg(barcode, n)
      from (
        select barcode, count(*) as n from public.basket_adds
        where created_at > now() - interval '7 days'
        group by barcode
      ) a
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.agent_community_input() from public, anon, authenticated;
grant execute on function public.agent_community_input() to service_role;

-- ---------- שמירת ההמלצות ----------
-- p = {"reports": [...], "requests": [...]}, ולכל שורה: id, advice, reason, priority, duplicate_of, title.
-- רק שורות שעדיין ממתינות. הסוכן לא משנה סטטוס.
create or replace function public.agent_community_save(p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  x jsonb;
  saved integer := 0;
  tbl text;
begin
  foreach tbl in array array['price_reports', 'product_requests'] loop
    for x in select * from jsonb_array_elements(coalesce(p -> (case tbl when 'price_reports' then 'reports' else 'requests' end), '[]'::jsonb)) loop
      if tbl = 'price_reports' then
        update public.price_reports set
          agent_advice = x ->> 'advice',
          agent_reason = left(x ->> 'reason', 200),
          agent_priority = least(100, greatest(0, (x ->> 'priority')::integer)),
          duplicate_of = nullif(x ->> 'duplicate_of', '')::bigint,
          agent_checked_at = now()
        where id = (x ->> 'id')::bigint and status = 'pending';
      else
        update public.product_requests set
          agent_advice = x ->> 'advice',
          agent_reason = left(x ->> 'reason', 200),
          agent_priority = least(100, greatest(0, (x ->> 'priority')::integer)),
          duplicate_of = nullif(x ->> 'duplicate_of', '')::bigint,
          agent_checked_at = now()
        where id = (x ->> 'id')::bigint and status = 'pending';
      end if;
      if found then
        saved := saved + 1;
        insert into public.agent_events (agent, kind, title, ref_table, ref_id)
        values ('community', 'action', left(coalesce(x ->> 'title', 'ממתין לאישור'), 300), tbl, (x ->> 'id')::bigint)
        on conflict (agent, ref_table, ref_id) where handled_at is null and ref_id is not null
        do update set title = excluded.title;
      end if;
    end loop;
  end loop;
  return saved;
end;
$$;

revoke execute on function public.agent_community_save(jsonb) from public, anon, authenticated;
grant execute on function public.agent_community_save(jsonb) to service_role;

-- ---------- נתוני דוח הבוקר ----------
-- כל האירועים הפתוחים, עם הפרטים של השורה שהם מדברים עליה, ומספר הבקשות הממתינות שהסוכן עוד לא בדק.
create or replace function public.agent_morning_report()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'agent', e.agent, 'kind', e.kind, 'title', e.title,
        'ref_table', e.ref_table, 'ref_id', e.ref_id,
        'created_at', e.created_at, 'reported_at', e.reported_at,
        'detail', case e.ref_table
          when 'price_reports' then (
            select jsonb_build_object(
              'barcode', r.barcode, 'chain_id', r.chain_id, 'price', r.price,
              'official_price', r.official_price, 'advice', r.agent_advice, 'reason', r.agent_reason,
              'priority', r.agent_priority, 'duplicate_of', r.duplicate_of, 'created_at', r.created_at)
            from public.price_reports r where r.id = e.ref_id)
          when 'product_requests' then (
            select jsonb_build_object(
              'name', q.name, 'advice', q.agent_advice, 'reason', q.agent_reason,
              'priority', q.agent_priority, 'duplicate_of', q.duplicate_of, 'created_at', q.created_at,
              'duplicate_name', (select d.name from public.product_requests d where d.id = q.duplicate_of),
              'votes', (select count(*) from public.request_votes v where v.request_id = q.id))
            from public.product_requests q where q.id = e.ref_id)
        end
      ) order by e.created_at)
      from public.agent_events e
      where e.handled_at is null
    ), '[]'::jsonb),
    'unchecked_requests', (
      select count(*) from public.product_requests where status = 'pending' and agent_checked_at is null
    ),
    'unchecked_reports', (
      select count(*) from public.price_reports where status = 'pending' and agent_checked_at is null
    )
  );
$$;

revoke execute on function public.agent_morning_report() from public, anon, authenticated;
grant execute on function public.agent_morning_report() to service_role;

-- ---------- הדוח נשלח ----------
-- כל האירועים שבדוח מסומנים שדווחו. אירוע info (לידיעה) נחשב מטופל אחרי שדווח פעם אחת.
-- אירוע על דיווח או בקשה שנמחקו (מחיקת חשבון) נסגר.
create or replace function public.agent_report_sent(p_ids bigint[])
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.agent_events e set handled_at = now()
    where e.handled_at is null and (
      (e.ref_table = 'price_reports' and not exists (select 1 from public.price_reports r where r.id = e.ref_id))
      or (e.ref_table = 'product_requests' and not exists (select 1 from public.product_requests q where q.id = e.ref_id))
    );

  with u as (
    update public.agent_events
      set reported_at = coalesce(reported_at, now()),
          handled_at = case when kind = 'info' then now() else handled_at end
      where id = any (p_ids)
      returning 1
  )
  select count(*)::integer from u;
$$;

revoke execute on function public.agent_report_sent(bigint[]) from public, anon, authenticated;
grant execute on function public.agent_report_sent(bigint[]) to service_role;
