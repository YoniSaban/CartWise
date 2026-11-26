-- מיילסטון 12: "פופולריים השבוע" ומונה חיסכון אישי.
-- מריצים פעם אחת ב-SQL Editor של Supabase. אפשר להריץ שוב בלי נזק.

-- ---- פופולריים השבוע ----
-- כל הוספה ידנית של מוצר לסל: עיר, ברקוד וזמן. בלי זהות.
-- אין לאף אחד קריאה או כתיבה ישירה. רק דרך שתי הפונקציות למטה.
create table if not exists public.basket_adds (
  id bigint generated always as identity primary key,
  city text not null,
  barcode text not null,
  created_at timestamptz not null default now()
);
create index if not exists basket_adds_city_time_idx on public.basket_adds (city, created_at);

alter table public.basket_adds enable row level security;
revoke all on public.basket_adds from anon, authenticated;

-- רושם הוספה. עיר שלא קיימת או ברקוד לא תקין: לא נרשם, בלי שגיאה
create or replace function public.log_basket_add(p_city text, p_barcode text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_barcode is null or p_barcode !~ '^[0-9]{4,14}$' then return false; end if;
  if not exists (select 1 from public.auto_basket_branches where city = p_city) then return false; end if;
  insert into public.basket_adds (city, barcode) values (p_city, p_barcode);
  -- הטבלה לא גדלה: שורות ישנות מ-30 יום נמחקות
  delete from public.basket_adds where created_at < now() - interval '30 days';
  return true;
end;
$$;

-- המוצרים שנוספו הכי הרבה ב-7 הימים האחרונים בעיר. 20 ראשונים: האתר מסנן למוצרי הקטלוג ולוקח 8
create or replace function public.popular_products(p_city text)
returns table (barcode text, adds int)
language sql
stable
security definer
set search_path = ''
as $$
  select a.barcode, count(*)::int as adds
  from public.basket_adds a
  where a.city = p_city and a.created_at > now() - interval '7 days'
  group by a.barcode
  order by count(*) desc, max(a.created_at) desc
  limit 20;
$$;

grant execute on function public.log_basket_add(text, text) to anon, authenticated;
grant execute on function public.popular_products(text) to anon, authenticated;

-- ---- מונה חיסכון אישי ----
-- כל לחיצה על "קניתי כאן". מחיקת חשבון מוחקת את השורות (cascade)
create table if not exists public.savings (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric(8, 2) not null check (amount > 0 and amount <= 2000),
  kind text not null check (kind in ('chain', 'split')),
  chain_id text,
  city text,
  created_at timestamptz not null default now()
);
create index if not exists savings_user_idx on public.savings (user_id, created_at);

alter table public.savings enable row level security;
revoke insert, update, delete on public.savings from anon, authenticated;
drop policy if exists "savings_read_own" on public.savings;
create policy "savings_read_own" on public.savings
  for select to authenticated using (user_id = (select auth.uid()));

-- מחזיר: ok, limit (כבר 3 קניות היום), invalid, signed_out
create or replace function public.record_saving(p_amount numeric, p_kind text, p_chain_id text, p_city text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today int;
begin
  if v_user is null then return 'signed_out'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 2000 or p_kind not in ('chain', 'split') then
    return 'invalid';
  end if;
  -- שתי לחיצות באותו רגע לא עוקפות את המגבלה
  perform pg_advisory_xact_lock(hashtext('cartwise_savings_' || v_user::text));
  select count(*) into v_today from public.savings
  where user_id = v_user
    and (created_at at time zone 'Asia/Jerusalem')::date = (now() at time zone 'Asia/Jerusalem')::date;
  if v_today >= 3 then return 'limit'; end if;
  insert into public.savings (user_id, amount, kind, chain_id, city)
  values (v_user, round(p_amount, 2), p_kind, left(p_chain_id, 40), left(p_city, 40));
  return 'ok';
end;
$$;

-- המונה של המשתמש המחובר: סך הכול, מספר קניות, והחודש הנוכחי
create or replace function public.my_savings()
returns table (total numeric, purchases int, month_total numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(amount), 0),
         count(*)::int,
         coalesce(sum(amount) filter (
           where date_trunc('month', created_at at time zone 'Asia/Jerusalem')
               = date_trunc('month', now() at time zone 'Asia/Jerusalem')), 0)
  from public.savings
  where user_id = auth.uid();
$$;

revoke execute on function public.record_saving(numeric, text, text, text) from public, anon;
revoke execute on function public.my_savings() from public, anon;
grant execute on function public.record_saving(numeric, text, text, text) to authenticated;
grant execute on function public.my_savings() to authenticated;

-- ביטול "קניתי כאן": מוחק את הקנייה האחרונה של המשתמש המחובר. מחזיר: ok, none, signed_out
create or replace function public.undo_last_saving()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if auth.uid() is null then return 'signed_out'; end if;
  select id into v_id from public.savings
  where user_id = auth.uid()
  order by created_at desc, id desc
  limit 1;
  if v_id is null then return 'none'; end if;
  delete from public.savings where id = v_id;
  return 'ok';
end;
$$;

revoke execute on function public.undo_last_saving() from public, anon;
grant execute on function public.undo_last_saving() to authenticated;
