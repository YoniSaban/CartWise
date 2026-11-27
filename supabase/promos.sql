-- מיילסטון 14: סוכן המבצעים
-- מריצים פעם אחת ב-SQL Editor של Supabase, אחרי agents.sql. אפשר להריץ שוב בלי נזק.
--
-- n8n קורא את קובץ ה-PromoFull של כל סניף מייד אחרי עדכון המחירים, ושומר רק מבצעים על מוצרי הקטלוג.
-- כל מחיר מבצע מגיע משדה מספרי בקובץ. מבצע שלא מתאים לכללים לא נשמר, ורק נספר בדוח הבוקר.
-- הדפדפן קורא רק מבצעים בתוקף, עם המפתח הציבורי. רק n8n כותב, דרך replace_chain_promos().

-- ---------- המבצעים ----------
-- kind: unit (מחיר ליחידה), bundle (min_qty יחידות ב-bundle_price), percent (min_qty יחידות, האחרונה בהנחה של discount_rate אחוז)
create table if not exists public.chain_promos (
  chain_id text not null,
  promo_id text not null,
  item_code text not null,
  description text check (char_length(description) <= 200),
  kind text not null check (kind in ('unit', 'bundle', 'percent')),
  min_qty numeric not null default 1 check (min_qty >= 1),
  bundle_price numeric check (bundle_price > 0),
  discount_rate numeric check (discount_rate > 0 and discount_rate <= 100),
  max_qty numeric check (max_qty > 0),
  club_only boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  loaded_at timestamptz not null default now(),
  primary key (chain_id, promo_id, item_code),
  check ((kind = 'percent') = (discount_rate is not null)),
  check ((kind <> 'percent') = (bundle_price is not null))
);

create index if not exists chain_promos_item_idx on public.chain_promos (item_code, chain_id);

alter table public.chain_promos enable row level security;
revoke all on public.chain_promos from anon, authenticated;
grant select on public.chain_promos to anon, authenticated;

-- הדפדפן רואה רק מבצעים בתוקף עכשיו
drop policy if exists "chain_promos_read_active" on public.chain_promos;
create policy "chain_promos_read_active" on public.chain_promos
  for select to anon, authenticated
  using ((starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

-- ---------- ריצה יומית לכל סניף ----------
-- שורה אחת לכל סניף ביום. ממנה בונים את סעיף המבצעים בדוח הבוקר. הדפדפן לא רואה אותה.
create table if not exists public.promo_runs (
  id bigint generated always as identity primary key,
  chain_id text not null,
  run_day date not null default (now() at time zone 'Asia/Jerusalem')::date,
  ok boolean not null,
  promos integer,
  new_promos integer,
  club integer,
  skipped jsonb,
  suspicious jsonb,
  error text check (char_length(error) <= 300),
  created_at timestamptz not null default now(),
  unique (chain_id, run_day)
);

alter table public.promo_runs enable row level security;
revoke all on public.promo_runs from anon, authenticated;

-- ---------- n8n: החלפת המבצעים של סניף ----------
-- p: { chain_id, rows: [...], skipped: { coupon, multi, suspicious, unknown, expired }, suspicious: [{ item_code, shelf, promo }] }
-- מוחק את המבצעים הקודמים של הסניף וכותב את החדשים, בפעולה אחת. מבצע שנעלם מהקובץ נעלם גם מהאתר.
-- סוגר כשל פתוח של הסניף, ויוצר אירוע info לדוח הבוקר.
create or replace function public.replace_chain_promos(p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chain text := p ->> 'chain_id';
  v_new integer;
  v_count integer;
  v_club integer;
  v_run bigint;
begin
  if v_chain is null or jsonb_typeof(p -> 'rows') <> 'array' then
    raise exception 'chain_id ו-rows חובה';
  end if;

  -- השורות שהגיעו, בלי כפילויות
  with incoming as (
    select distinct on (r.promo_id, r.item_code) r.*
    from jsonb_to_recordset(p -> 'rows') as r(promo_id text, item_code text)
    where r.promo_id is not null and r.item_code is not null
  )
  select count(*) into v_new from incoming i
    where not exists (select 1 from public.chain_promos c
      where c.chain_id = v_chain and c.promo_id = i.promo_id and c.item_code = i.item_code);

  delete from public.chain_promos where chain_id = v_chain;

  insert into public.chain_promos (chain_id, promo_id, item_code, description, kind, min_qty,
      bundle_price, discount_rate, max_qty, club_only, starts_at, ends_at)
    select distinct on (r.promo_id, r.item_code)
      v_chain, r.promo_id, r.item_code, left(r.description, 200), r.kind, coalesce(r.min_qty, 1),
      r.bundle_price, r.discount_rate, r.max_qty, coalesce(r.club_only, false), r.starts_at, r.ends_at
    from jsonb_to_recordset(p -> 'rows') as r(
      promo_id text, item_code text, description text, kind text, min_qty numeric,
      bundle_price numeric, discount_rate numeric, max_qty numeric, club_only boolean,
      starts_at timestamptz, ends_at timestamptz)
    where r.promo_id is not null and r.item_code is not null;

  get diagnostics v_count = row_count;
  select count(*) into v_club from public.chain_promos where chain_id = v_chain and club_only;

  insert into public.promo_runs (chain_id, ok, promos, new_promos, club, skipped, suspicious, error)
    values (v_chain, true, v_count, v_new, v_club, p -> 'skipped', p -> 'suspicious', null)
    on conflict (chain_id, run_day) do update set
      ok = true, promos = excluded.promos, new_promos = excluded.new_promos, club = excluded.club,
      skipped = excluded.skipped, suspicious = excluded.suspicious, error = null, created_at = now()
    returning id into v_run;

  -- כשל קודם של הסניף טופל
  update public.agent_events e set handled_at = now()
    from public.promo_runs r
    where e.agent = 'promos' and e.ref_table = 'promo_runs' and e.kind = 'action'
      and e.handled_at is null and r.id = e.ref_id and r.chain_id = v_chain;

  insert into public.agent_events (agent, kind, title, ref_table, ref_id)
    values ('promos', 'info', 'מבצעים: ' || v_chain, 'promo_runs', v_run)
    on conflict do nothing;

  return v_count;
end;
$$;

revoke execute on function public.replace_chain_promos(jsonb) from public, anon, authenticated;
grant execute on function public.replace_chain_promos(jsonb) to service_role;

-- ---------- n8n: קובץ המבצעים של סניף לא נקרא ----------
-- המבצעים הקודמים נשארים (רק אלה שעוד בתוקף מוצגים). אירוע action אחד לסניף, פתוח עד שהקובץ נקרא בהצלחה.
create or replace function public.promo_failed(p_chain text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run bigint;
begin
  insert into public.promo_runs (chain_id, ok, error)
    values (p_chain, false, left(p_error, 300))
    on conflict (chain_id, run_day) do update set ok = false, error = excluded.error, created_at = now()
    returning id into v_run;

  if not exists (
    select 1 from public.agent_events e join public.promo_runs r on r.id = e.ref_id
    where e.agent = 'promos' and e.ref_table = 'promo_runs' and e.kind = 'action'
      and e.handled_at is null and r.chain_id = p_chain
  ) then
    insert into public.agent_events (agent, kind, title, ref_table, ref_id)
      values ('promos', 'action', 'קובץ המבצעים לא נקרא: ' || p_chain, 'promo_runs', v_run);
  end if;
end;
$$;

revoke execute on function public.promo_failed(text, text) from public, anon, authenticated;
grant execute on function public.promo_failed(text, text) to service_role;

-- ---------- דוח הבוקר: גם הפרטים של ריצות המבצעים ----------
-- אותה פונקציה ממיילסטון 13, עם המקרה promo_runs
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
          when 'promo_runs' then (
            select jsonb_build_object(
              'chain_id', pr.chain_id, 'run_day', pr.run_day, 'ok', pr.ok, 'promos', pr.promos,
              'new_promos', pr.new_promos, 'club', pr.club, 'skipped', pr.skipped,
              'suspicious', pr.suspicious, 'error', pr.error)
            from public.promo_runs pr where pr.id = e.ref_id)
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
