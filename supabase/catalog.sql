-- מיילסטון 16: סוכן הרחבת הקטלוג
-- מריצים פעם אחת ב-SQL Editor של Supabase, אחרי agents.sql, promos.sql ו-product-match.sql. אפשר להריץ שוב בלי נזק.
--
-- פעם בשבוע (יום ראשון, 09:30, או בריצה הראשונה שאחריו) הסוכן ב-n8n מציע מוצרים חדשים לקטלוג, עד 10 ממתינים בכל רגע.
-- קודם בקשות קהילה מאושרות (לפי קולות), אחר כך מוצרים שנמכרים בכל 9 הסניפים, לפי פער המחירים. Gemini בוחר ומנסח.
-- יוני מאשר בעורך הטבלאות: בטבלה catalog_suggestions, בעמודה status, כותב approved או rejected.
-- ההוספה לאתר (products.json ותמונה) נעשית בשיחה עם Claude, ואז status = added. הדפדפן לא רואה כלום מזה.

-- ---------- ההצעות ----------
create table if not exists public.catalog_suggestions (
  id bigint generated always as identity primary key,
  barcode text not null unique,
  name text not null check (char_length(name) <= 120),
  size text check (char_length(size) <= 40),
  manufacturer text check (char_length(manufacturer) <= 80),
  category text,
  keywords jsonb,
  source text not null check (source in ('request', 'popular')),
  request_id bigint references public.product_requests (id) on delete set null,
  branches integer,
  price_min numeric,
  price_max numeric,
  reason text check (char_length(reason) <= 200),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'added')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

alter table public.catalog_suggestions enable row level security;
revoke all on public.catalog_suggestions from anon, authenticated;

-- יוני כותב בעורך: הסטטוס באותיות קטנות, ומתי הוחלט
create or replace function public.catalog_suggestions_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status := lower(trim(new.status));
  if new.status is distinct from old.status then
    new.decided_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.catalog_suggestions_before_update() from public, anon, authenticated;

drop trigger if exists catalog_suggestions_before on public.catalog_suggestions;
create trigger catalog_suggestions_before
  before update on public.catalog_suggestions
  for each row execute function public.catalog_suggestions_before_update();

-- אחרי החלטה: האירוע בדוח נסגר. מוצר שנוסף לאתר: גם בקשת הקהילה שלו הופכת ל-added
create or replace function public.catalog_suggestions_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    update public.agent_events
      set handled_at = now()
      where ref_table = 'catalog_suggestions' and ref_id = new.id and handled_at is null;
  end if;
  if new.status = 'added' and old.status <> 'added' and new.request_id is not null then
    update public.product_requests set status = 'added'
      where id = new.request_id and status = 'approved';
  end if;
  return null;
end;
$$;

revoke execute on function public.catalog_suggestions_after_update() from public, anon, authenticated;

drop trigger if exists catalog_suggestions_after on public.catalog_suggestions;
create trigger catalog_suggestions_after
  after update on public.catalog_suggestions
  for each row execute function public.catalog_suggestions_after_update();

-- ---------- ריצה שבועית ----------
-- שורה לכל ריצה. ok = Gemini ענה וההצעות נשמרו. השבוע מתחיל ביום ראשון.
create table if not exists public.catalog_runs (
  id bigint generated always as identity primary key,
  run_day date not null default (now() at time zone 'Asia/Jerusalem')::date unique,
  ok boolean not null,
  summary jsonb,
  created_at timestamptz not null default now()
);

alter table public.catalog_runs enable row level security;
revoke all on public.catalog_runs from anon, authenticated;

-- ---------- n8n: מועמדים ----------
-- p_codes: כל הקודים של הקטלוג (ברקודים ו-chain_codes).
-- due: אין ריצה מוצלחת מאז יום ראשון האחרון (כולל היום). כך ביום ראשון רץ, ואם המחשב היה כבוי או ש-Gemini לא ענה, רץ למחרת.
-- slots: כמה הצעות חדשות (10 פחות הממתינות).
-- requests: בקשות מאושרות בלי הצעה, לפי קולות, ועד 5 מוצרים דומים בשם לכל אחת.
-- popular: עד 80 ברקודים שנמכרים בכל 9 הסניפים (ואחריהם בכל 6 סניפי תל אביב), לפי פער המחירים.
create or replace function public.catalog_candidates(p_codes text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with today as (
    select (now() at time zone 'Asia/Jerusalem')::date as d
  ),
  week as (
    select d - extract(dow from d)::integer as sunday from today
  ),
  state as (
    select
      not exists (select 1 from public.catalog_runs r, week w where r.ok and r.run_day >= w.sunday) as due,
      (select count(*) from public.catalog_suggestions where status = 'pending') as pending
  ),
  -- כל ברקוד ארוז: בכמה סניפים, המחיר הזול והיקר, והשם הארוך ביותר (פחות חתוך)
  items as materialized (
    select item_code,
      count(distinct chain_id) as branches,
      count(distinct chain_id) filter (where chain_id in ('shufersal', 'tiv_taam', 'wolt', 'rami_levi', 'ampm', 'carrefour')) as ta,
      min(price) as price_min, max(price) as price_max,
      (array_agg(item_name order by length(item_name) desc))[1] as item_name,
      (array_agg(manufacturer order by length(coalesce(manufacturer, '')) desc))[1] as manufacturer,
      (array_agg(quantity))[1] as quantity, (array_agg(unit))[1] as unit
    from public.chain_items
    where item_code ~ '^\d{8,13}$' and price_per_kg is null and price > 0
      and (select due from state)
    group by item_code
  ),
  excluded as (
    select unnest(p_codes) as code
    union select item_code from public.product_matches where status <> 'rejected'
    union select barcode from public.catalog_suggestions
  ),
  popular as (
    select i.*, round((i.price_max - i.price_min) / i.price_min * 100) as spread
    from items i
    where (i.branches >= 9 or i.ta = 6)
      and i.item_code not in (select code from excluded)
    order by (i.branches >= 9) desc, (i.price_max - i.price_min) / i.price_min desc, i.item_code
    limit 80
  ),
  reqs as (
    select q.id, q.name,
      (select count(*) from public.request_votes v where v.request_id = q.id) as votes
    from public.product_requests q
    where q.status = 'approved' and (select due from state)
      and not exists (select 1 from public.catalog_suggestions s where s.request_id = q.id and s.status <> 'rejected')
  ),
  req_words as (
    select distinct r.id, w from reqs r, unnest(string_to_array(public.pm_norm(r.name), ' ')) w where length(w) >= 2
  ),
  req_count as (
    select id, count(*) as n from req_words group by id
  ),
  -- מוצרים שמכילים לפחות מילה אחת מהבקשה (3 תווים ומעלה), ואז ניקוד לפי כמה מילים נמצאו
  req_items as materialized (
    select distinct rw.id, i.item_code
    from req_words rw
    join items i on length(rw.w) >= 3 and position(rw.w in public.pm_norm(i.item_name)) > 0
    where i.item_code not in (select unnest(p_codes))
  ),
  req_hits as (
    select ri.id, ri.item_code, count(distinct rw.w) as h
    from req_items ri
    join items i on i.item_code = ri.item_code
    join req_words rw on rw.id = ri.id
    cross join lateral unnest(string_to_array(public.pm_norm(i.item_name), ' ')) x
    where x = rw.w or (length(rw.w) >= 3 and x like rw.w || '%') or (length(x) >= 3 and rw.w like x || '%')
    group by 1, 2
  ),
  req_top as (
    select h.id, i.*, round(h.h::numeric / c.n, 2) as score,
      row_number() over (partition by h.id order by h.h::numeric / c.n desc, i.branches desc, i.item_code) as rn
    from req_hits h join req_count c using (id) join items i on i.item_code = h.item_code
    where h.h::numeric / c.n >= 0.5
  )
  select jsonb_build_object(
    'due', (select due from state),
    'pending', (select pending from state),
    'slots', greatest(0, 10 - (select pending from state)),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'request_id', r.id, 'name', r.name, 'votes', r.votes,
        'candidates', coalesce((
          select jsonb_agg(jsonb_build_object(
            'barcode', t.item_code, 'item_name', t.item_name, 'manufacturer', t.manufacturer,
            'quantity', t.quantity, 'unit', t.unit, 'branches', t.branches,
            'price_min', t.price_min, 'price_max', t.price_max, 'score', t.score) order by t.rn)
          from req_top t where t.id = r.id and t.rn <= 5
        ), '[]'::jsonb)
      ) order by r.votes desc, r.id)
      from reqs r
    ), '[]'::jsonb),
    'popular', coalesce((
      select jsonb_agg(jsonb_build_object(
        'barcode', p.item_code, 'item_name', p.item_name, 'manufacturer', p.manufacturer,
        'quantity', p.quantity, 'unit', p.unit, 'branches', p.branches,
        'price_min', p.price_min, 'price_max', p.price_max, 'spread', p.spread))
      from popular p
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.catalog_candidates(text[]) from public, anon, authenticated;
grant execute on function public.catalog_candidates(text[]) to service_role;

-- ---------- n8n: שמירה ----------
-- p = { ran, ok, rows: [{ barcode, name, size, manufacturer, category, keywords, source, request_id, branches,
--       price_min, price_max, reason, title }], not_found: [{ request_id, title }], summary }
-- ran = false (לא יום ריצה): לא נשמר כלום. ok = false (Gemini לא ענה): רק שורת ריצה, וניסיון חוזר מחר.
create or replace function public.catalog_save(p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  x jsonb;
  v_id bigint;
  saved integer := 0;
begin
  if coalesce((p ->> 'ran')::boolean, false) is not true then
    return 0;
  end if;

  for x in select * from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) loop
    insert into public.catalog_suggestions (barcode, name, size, manufacturer, category, keywords, source,
        request_id, branches, price_min, price_max, reason)
      values (x ->> 'barcode', left(x ->> 'name', 120), left(x ->> 'size', 40), left(x ->> 'manufacturer', 80),
        x ->> 'category', x -> 'keywords', x ->> 'source', nullif(x ->> 'request_id', '')::bigint,
        nullif(x ->> 'branches', '')::integer, nullif(x ->> 'price_min', '')::numeric,
        nullif(x ->> 'price_max', '')::numeric, left(x ->> 'reason', 200))
      on conflict (barcode) do nothing
      returning id into v_id;
    if v_id is null then
      continue;
    end if;
    saved := saved + 1;
    insert into public.agent_events (agent, kind, title, ref_table, ref_id)
      values ('catalog', 'action', left(coalesce(x ->> 'title', 'הצעה לקטלוג'), 300), 'catalog_suggestions', v_id)
      on conflict do nothing;
    v_id := null;
  end loop;

  -- בקשה שלא נמצאה ברשתות: לידיעה, בכל ריצה עד שתימצא
  for x in select * from jsonb_array_elements(coalesce(p -> 'not_found', '[]'::jsonb)) loop
    insert into public.agent_events (agent, kind, title, ref_table, ref_id)
      values ('catalog', 'info', left(coalesce(x ->> 'title', 'בקשה לא נמצאה ברשתות'), 300), 'product_requests',
        nullif(x ->> 'request_id', '')::bigint)
      on conflict do nothing;
  end loop;

  insert into public.catalog_runs (ok, summary)
    values (coalesce((p ->> 'ok')::boolean, false), p -> 'summary')
    on conflict (run_day) do update set ok = excluded.ok, summary = excluded.summary, created_at = now();

  return saved;
end;
$$;

revoke execute on function public.catalog_save(jsonb) from public, anon, authenticated;
grant execute on function public.catalog_save(jsonb) to service_role;

-- ---------- דוח הבוקר: גם הצעות הקטלוג ----------
-- אותה פונקציה ממיילסטונים 13 עד 15, עם המקרה catalog_suggestions, הרשימה catalog_approved, ו-catalog_run
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
        'detail', case
          when e.ref_table = 'price_reports' then (
            select jsonb_build_object(
              'barcode', r.barcode, 'chain_id', r.chain_id, 'price', r.price,
              'official_price', r.official_price, 'advice', r.agent_advice, 'reason', r.agent_reason,
              'priority', r.agent_priority, 'duplicate_of', r.duplicate_of, 'created_at', r.created_at)
            from public.price_reports r where r.id = e.ref_id)
          when e.ref_table = 'product_requests' then (
            select jsonb_build_object(
              'name', q.name, 'advice', q.agent_advice, 'reason', q.agent_reason,
              'priority', q.agent_priority, 'duplicate_of', q.duplicate_of, 'created_at', q.created_at,
              'duplicate_name', (select d.name from public.product_requests d where d.id = q.duplicate_of),
              'votes', (select count(*) from public.request_votes v where v.request_id = q.id))
            from public.product_requests q where q.id = e.ref_id)
          when e.ref_table = 'promo_runs' then (
            select jsonb_build_object(
              'chain_id', pr.chain_id, 'run_day', pr.run_day, 'ok', pr.ok, 'promos', pr.promos,
              'new_promos', pr.new_promos, 'club', pr.club, 'skipped', pr.skipped,
              'suspicious', pr.suspicious, 'error', pr.error)
            from public.promo_runs pr where pr.id = e.ref_id)
          when e.ref_table = 'product_matches' then (
            select jsonb_build_object(
              'chain_id', m.chain_id, 'barcode', m.barcode, 'item_code', m.item_code,
              'item_name', m.item_name, 'manufacturer', m.manufacturer, 'quantity', m.quantity, 'unit', m.unit,
              'ref_name', m.ref_name, 'status', m.status, 'verdict', m.verdict, 'reason', m.reason)
            from public.product_matches m where m.id = e.ref_id)
          when e.ref_table = 'catalog_suggestions' then (
            select jsonb_build_object(
              'barcode', s.barcode, 'name', s.name, 'size', s.size, 'manufacturer', s.manufacturer,
              'category', s.category, 'source', s.source, 'request_id', s.request_id,
              'votes', (select count(*) from public.request_votes v where v.request_id = s.request_id),
              'branches', s.branches, 'price_min', s.price_min, 'price_max', s.price_max,
              'reason', s.reason, 'status', s.status)
            from public.catalog_suggestions s where s.id = e.ref_id)
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
    ),
    'product_match_run', (
      select jsonb_build_object('run_day', r.run_day, 'gemini_ok', r.gemini_ok, 'summary', r.summary)
      from public.product_match_runs r
      where r.run_day = (now() at time zone 'Asia/Jerusalem')::date
    ),
    'catalog_run', (
      select jsonb_build_object('run_day', r.run_day, 'ok', r.ok, 'summary', r.summary)
      from public.catalog_runs r
      where r.run_day = (now() at time zone 'Asia/Jerusalem')::date
    ),
    'catalog_approved', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'barcode', s.barcode, 'name', s.name, 'size', s.size, 'category', s.category,
        'decided_at', s.decided_at) order by s.decided_at)
      from public.catalog_suggestions s where s.status = 'approved'
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.agent_morning_report() from public, anon, authenticated;
grant execute on function public.agent_morning_report() to service_role;

-- ---------- הדוח נשלח ----------
-- אותה פונקציה ממיילסטון 15, וגם: אירוע על הצעה שנמחקה נסגר
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
      or (e.ref_table = 'product_matches' and not exists (select 1 from public.product_matches m where m.id = e.ref_id))
      or (e.ref_table = 'catalog_suggestions' and not exists (select 1 from public.catalog_suggestions s where s.id = e.ref_id))
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
