-- מיילסטון 11: "מצאתי זול יותר", בקשות מוצרים והצבעה
-- מריצים פעם אחת ב-SQL Editor של Supabase, אחרי auth-profiles.sql. אפשר להריץ שוב בלי נזק.
--
-- אישור מנהל: יוני משנה את status בעורך הטבלאות (Table Editor).
--   price_reports.status:    pending -> approved / rejected (ואפשר לכתוב סיבה ב-reject_reason)
--   product_requests.status: pending -> approved / rejected, ואחר כך added כשהמוצר נכנס לקטלוג
-- decided_at מתעדכן לבד בכל שינוי סטטוס.
--
-- הדפדפן לא כותב ישירות לטבלאות הדיווחים והבקשות: רק דרך הפונקציות למטה, שבודקות את הכללים.

-- ---------- דיווחי "מצאתי זול יותר" ----------

create table if not exists public.price_reports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  barcode text not null check (barcode ~ '^[0-9]{1,14}$'),
  chain_id text not null check (char_length(chain_id) between 1 and 40),
  item_code text not null check (char_length(item_code) between 1 and 20),
  price numeric(8, 2) not null check (price > 0 and price < 10000),
  official_price numeric(8, 2),
  suspicious boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason text check (char_length(reject_reason) <= 200),
  report_day date not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (user_id, barcode, chain_id, report_day)
);

create index if not exists price_reports_approved_idx on public.price_reports (decided_at) where status = 'approved';

alter table public.price_reports enable row level security;

-- כולם רואים דיווחים מאושרים ב-3 הימים מהאישור. משתמש מחובר רואה גם את כל שלו
drop policy if exists "price_reports_read" on public.price_reports;
create policy "price_reports_read" on public.price_reports
  for select to anon, authenticated
  using (
    (status = 'approved' and decided_at > now() - interval '3 days')
    or (select auth.uid()) = user_id
  );

-- בלי user_id: אף אחד לא רואה מי דיווח
revoke all on public.price_reports from anon, authenticated;
grant select (id, barcode, chain_id, price, status, reject_reason, created_at, decided_at)
  on public.price_reports to anon, authenticated;

-- ---------- בקשות מוצרים ----------

create table if not exists public.product_requests (
  id bigint generated always as identity primary key,
  -- מחיקת חשבון משאירה את הבקשה (בגלל הקולות של אחרים), בלי קשר למי שביקש
  user_id uuid references auth.users (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'added')),
  reject_reason text check (char_length(reject_reason) <= 200),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

alter table public.product_requests enable row level security;

-- משתמש מחובר רואה את הבקשות שלו. את המאושרות, עם הקולות, כולם רואים דרך list_requests()
drop policy if exists "product_requests_read_own" on public.product_requests;
create policy "product_requests_read_own" on public.product_requests
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.product_requests from anon, authenticated;
grant select (id, name, status, reject_reason, created_at, decided_at)
  on public.product_requests to authenticated;

-- ---------- קולות ----------

create table if not exists public.request_votes (
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id bigint not null references public.product_requests (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);

alter table public.request_votes enable row level security;

drop policy if exists "request_votes_read_own" on public.request_votes;
create policy "request_votes_read_own" on public.request_votes
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- הצבעה רק על בקשה מאושרת, ורק בשם עצמך. הבדיקה בפונקציה, כי משתמש לא רואה בטבלה בקשות של אחרים
create or replace function public.request_is_approved(p_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.product_requests where id = p_id and status = 'approved');
$$;

revoke execute on function public.request_is_approved(bigint) from public, anon;
grant execute on function public.request_is_approved(bigint) to authenticated;

drop policy if exists "request_votes_insert_own" on public.request_votes;
create policy "request_votes_insert_own" on public.request_votes
  for insert to authenticated
  with check ((select auth.uid()) = user_id and public.request_is_approved(request_id));

drop policy if exists "request_votes_delete_own" on public.request_votes;
create policy "request_votes_delete_own" on public.request_votes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.request_votes from anon, authenticated;
grant select, insert, delete on public.request_votes to authenticated;

-- עד 5 קולות פעילים. קול על בקשה שנכנסה לקטלוג (added) כבר לא פעיל, ולכן חוזר למשתמש
create or replace function public.check_vote_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*)
    from public.request_votes v
    join public.product_requests r on r.id = v.request_id
    where v.user_id = new.user_id and r.status <> 'added'
  ) >= 5 then
    raise exception 'vote_limit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.check_vote_limit() from public, anon, authenticated;

drop trigger if exists request_votes_limit on public.request_votes;
create trigger request_votes_limit
  before insert on public.request_votes
  for each row execute function public.check_vote_limit();

-- ---------- decided_at מתעדכן בכל שינוי סטטוס ----------
-- הסטטוס נשמר באותיות קטנות, גם אם בעורך נכתב Approved (העורך מתחיל לפעמים באות גדולה)

create or replace function public.set_decided_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status := lower(btrim(new.status));
  if new.status is distinct from old.status then
    new.decided_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.set_decided_at() from public, anon, authenticated;

drop trigger if exists price_reports_decided on public.price_reports;
create trigger price_reports_decided
  before update on public.price_reports
  for each row execute function public.set_decided_at();

drop trigger if exists product_requests_decided on public.product_requests;
create trigger product_requests_decided
  before update on public.product_requests
  for each row execute function public.set_decided_at();

-- ---------- שליחת דיווח ----------
-- מחזיר: ok, updated (דיווח של היום על אותו מוצר ורשת עודכן), limit (5 ביום), not_cheaper, no_price
create or replace function public.submit_price_report(
  p_barcode text, p_chain_id text, p_item_code text, p_per_kg boolean, p_price numeric
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'Asia/Jerusalem')::date;
  official numeric;
  existing bigint;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;

  -- המחיר הרשמי הנוכחי של המוצר ברשת
  select case when p_per_kg then ci.price_per_kg else ci.price end
    into official
    from public.chain_items ci
    where ci.chain_id = p_chain_id and ci.item_code = p_item_code
    limit 1;
  if official is null then
    return 'no_price';
  end if;
  if p_price is null or p_price <= 0 or p_price >= official then
    return 'not_cheaper';
  end if;

  select id into existing
    from public.price_reports
    where user_id = uid and barcode = p_barcode and chain_id = p_chain_id and report_day = today;

  if existing is not null then
    -- דיווח כפול באותו יום: מעדכנים, וחוזרים להמתנה לאישור
    update public.price_reports
      set price = p_price, official_price = official, suspicious = p_price < official * 0.5,
          status = 'pending', reject_reason = null, created_at = now()
      where id = existing;
    return 'updated';
  end if;

  if (select count(*) from public.price_reports where user_id = uid and report_day = today) >= 5 then
    return 'limit';
  end if;

  insert into public.price_reports (user_id, barcode, chain_id, item_code, price, official_price, suspicious, report_day)
  values (uid, p_barcode, p_chain_id, p_item_code, p_price, official, p_price < official * 0.5, today);
  return 'ok';
end;
$$;

revoke execute on function public.submit_price_report(text, text, text, boolean, numeric) from public, anon;
grant execute on function public.submit_price_report(text, text, text, boolean, numeric) to authenticated;

-- ---------- שליחת בקשת מוצר ----------
-- מחזיר: ok (עם קול של המבקש, אם נשאר לו), ok_no_vote (נגמרו הקולות), limit (5 בקשות ביום), invalid
create or replace function public.submit_product_request(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  clean text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  new_id bigint;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  if char_length(clean) < 2 or char_length(clean) > 60 then
    return 'invalid';
  end if;
  if (
    select count(*) from public.product_requests
    where user_id = uid and created_at > date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem'
  ) >= 5 then
    return 'limit';
  end if;

  insert into public.product_requests (user_id, name) values (uid, clean) returning id into new_id;

  begin
    insert into public.request_votes (user_id, request_id) values (uid, new_id);
  exception when sqlstate 'P0001' then
    return 'ok_no_vote';
  end;
  return 'ok';
end;
$$;

revoke execute on function public.submit_product_request(text) from public, anon;
grant execute on function public.submit_product_request(text) to authenticated;

-- ---------- רשימת הבקשות ----------
-- בקשות מאושרות עם מספר הקולות, ולמשתמש מחובר גם אם הצביע. לכולם, גם בלי חשבון
create or replace function public.list_requests()
returns table (id bigint, name text, votes bigint, my_vote boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.name, count(v.user_id) as votes,
         coalesce(bool_or(v.user_id = auth.uid()), false) as my_vote
  from public.product_requests r
  left join public.request_votes v on v.request_id = r.id
  where r.status = 'approved'
  group by r.id, r.name
  order by votes desc, r.id;
$$;

revoke execute on function public.list_requests() from public;
grant execute on function public.list_requests() to anon, authenticated;

-- כמה קולות פעילים יש למשתמש המחובר (מתוך 5)
create or replace function public.my_active_votes()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.request_votes v
  join public.product_requests r on r.id = v.request_id
  where v.user_id = auth.uid() and r.status <> 'added';
$$;

revoke execute on function public.my_active_votes() from public, anon;
grant execute on function public.my_active_votes() to authenticated;

-- הדיווחים של המשתמש המחובר, עם הסטטוס (בלי לחשוף user_id בטבלה)
create or replace function public.my_reports()
returns table (id bigint, barcode text, chain_id text, price numeric, status text, reject_reason text, created_at timestamptz, decided_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select id, barcode, chain_id, price, status, reject_reason, created_at, decided_at
  from public.price_reports
  where user_id = auth.uid()
  order by created_at desc
  limit 50;
$$;

revoke execute on function public.my_reports() from public, anon;
grant execute on function public.my_reports() to authenticated;
