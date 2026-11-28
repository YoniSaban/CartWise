-- מיילסטון 15: סוכן התאמת המוצרים
-- מריצים פעם אחת ב-SQL Editor של Supabase, אחרי agents.sql ו-promos.sql. אפשר להריץ שוב בלי נזק.
--
-- לכל מוצר ארוז מהקטלוג שחסר בסניף, הסוכן (ב-n8n, 09:30) מחפש ב-chain_items של אותו סניף את אותו מוצר עם ברקוד אחר.
-- התאמה אוטומטית (auto) רק כששם, יצרן וגודל זהים וגם Gemini מאשר. כל השאר ממתין (pending) לאישור של יוני.
-- יוני מאשר בעורך הטבלאות: בטבלה product_matches, בעמודה status, כותב approved או rejected.
-- הדפדפן קורא רק התאמות פעילות (auto, approved). רק n8n כותב.

-- ---------- עזרים: גודל ושם ----------

-- הכמות באריזה ביחידה אחת: גרם או מ"ל. בקבצים יש גם ק"ג וליטר (1, 1.5), ולכן מתחת ל-50 מכפילים ב-1000.
create or replace function public.pm_qty(q numeric, u text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when q is null or q <= 0 then null
    when coalesce(u, '') !~ '^\s*100' and (u ~ 'קילו' or (u ~ 'ליטר' and u !~ 'מיליליטר')) and q < 50 then q * 1000
    else q
  end;
$$;

-- סוג המידה: g (משקל), ml (נפח), x (יחידות או לא ידוע)
create or replace function public.pm_dim(u text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when u ~ '(גרם|קילו)' then 'g'
    when u ~ '(ליטר|מ"ל|מיליליטר)' then 'ml'
    else 'x'
  end;
$$;

-- שם לאחר ניקוי: בלי סימנים, אותיות קטנות, רווח אחד
create or replace function public.pm_norm(s text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(regexp_replace(
    regexp_replace(lower(replace(coalesce(s, ''), '&amp;', '&')), '["''״׳`.,:;!?()\[\]\-_/&#+*%]', ' ', 'g'),
    '\s+', ' ', 'g'));
$$;

revoke execute on function public.pm_qty(numeric, text) from public, anon, authenticated;
revoke execute on function public.pm_dim(text) from public, anon, authenticated;
revoke execute on function public.pm_norm(text) from public, anon, authenticated;

-- ---------- ההתאמות ----------
create table if not exists public.product_matches (
  id bigint generated always as identity primary key,
  chain_id text not null,
  barcode text not null,
  item_code text not null,
  item_name text,
  manufacturer text,
  quantity numeric,
  unit text,
  ref_name text,
  ref_manufacturer text,
  status text not null default 'pending' check (status in ('auto', 'pending', 'approved', 'rejected')),
  verdict text check (verdict in ('same', 'unsure', 'different')),
  reason text check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (chain_id, barcode, item_code)
);

-- לכל מוצר וסניף רק התאמה פעילה אחת
create unique index if not exists product_matches_one_active
  on public.product_matches (chain_id, barcode)
  where status in ('auto', 'approved');

alter table public.product_matches enable row level security;
revoke all on public.product_matches from anon, authenticated;
grant select (chain_id, barcode, item_code) on public.product_matches to anon, authenticated;

drop policy if exists "product_matches_read_active" on public.product_matches;
create policy "product_matches_read_active" on public.product_matches
  for select to anon, authenticated
  using (status in ('auto', 'approved'));

-- יוני כותב בעורך: הסטטוס באותיות קטנות, ומתי הוחלט
create or replace function public.product_matches_before_update()
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

revoke execute on function public.product_matches_before_update() from public, anon, authenticated;

drop trigger if exists product_matches_before on public.product_matches;
create trigger product_matches_before
  before update on public.product_matches
  for each row execute function public.product_matches_before_update();

-- אחרי החלטה: האירוע בדוח נסגר. התאמה שהפכה לפעילה דוחה את שאר ההצעות לאותו מוצר וסניף
create or replace function public.product_matches_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    update public.agent_events
      set handled_at = now()
      where ref_table = 'product_matches' and ref_id = new.id and handled_at is null;
  end if;
  if new.status in ('auto', 'approved') and old.status not in ('auto', 'approved') then
    update public.product_matches
      set status = 'rejected', reason = left('הותאם מוצר אחר (' || new.item_code || ')', 200)
      where chain_id = new.chain_id and barcode = new.barcode and id <> new.id and status = 'pending';
  end if;
  return null;
end;
$$;

revoke execute on function public.product_matches_after_update() from public, anon, authenticated;

drop trigger if exists product_matches_after on public.product_matches;
create trigger product_matches_after
  after update on public.product_matches
  for each row execute function public.product_matches_after_update();

-- ---------- ריצה יומית ----------
-- שורה אחת ביום: סיכום לכל סניף, והאם Gemini ענה. בשביל דוח הבוקר. הדפדפן לא רואה אותה.
create table if not exists public.product_match_runs (
  id bigint generated always as identity primary key,
  run_day date not null default (now() at time zone 'Asia/Jerusalem')::date unique,
  gemini_ok boolean,
  summary jsonb,
  created_at timestamptz not null default now()
);

alter table public.product_match_runs enable row level security;
revoke all on public.product_match_runs from anon, authenticated;

-- ---------- n8n: מועמדים ----------
-- p_barcodes: המוצרים הארוזים מהקטלוג (products.json).
-- מחזיר כל צירוף של מוצר וסניף שהמוצר חסר בו ואין לו התאמה פעילה, עם מוצר ייחוס מסניף אחר ועד 3 מועמדים.
-- מועמד: אותו סניף, אותה כמות ואותו סוג מידה, ולפחות מחצית מהמילים בשם. בלי ברקודים מהקטלוג, ובלי מה שכבר נבדק לאותו צירוף.
create or replace function public.product_match_candidates(p_barcodes text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with catalog as (
    select distinct unnest(p_barcodes) as barcode
  ),
  chains as (
    select distinct chain_id from public.chain_items
  ),
  missing as materialized (
    select ch.chain_id, c.barcode
    from chains ch cross join catalog c
    where not exists (select 1 from public.chain_items i where i.chain_id = ch.chain_id and i.item_code = c.barcode)
      and not exists (select 1 from public.product_matches m
        where m.chain_id = ch.chain_id and m.barcode = c.barcode and m.status in ('auto', 'approved'))
  ),
  -- מוצר הייחוס: אותו ברקוד בסניף אחר. עדיף שם ארוך (פחות חתוך)
  ref as materialized (
    select distinct on (m.chain_id, m.barcode)
      m.chain_id, m.barcode, r.item_name, r.manufacturer, r.quantity, r.unit,
      public.pm_qty(r.quantity, r.unit) as q, public.pm_dim(r.unit) as dim
    from missing m
    join public.chain_items r on r.item_code = m.barcode
    order by m.chain_id, m.barcode, length(r.item_name) desc
  ),
  items as materialized (
    select i.chain_id, i.item_code, i.item_name, i.manufacturer, i.quantity, i.unit,
      public.pm_qty(i.quantity, i.unit) as q, public.pm_dim(i.unit) as dim
    from public.chain_items i
    where i.chain_id in (select chain_id from ref)
      and i.item_code not in (select barcode from catalog)
  ),
  -- אותה כמות ואותו סוג מידה. בלי מה שכבר נבדק לאותו צירוף
  pairs as materialized (
    select f.chain_id, f.barcode, i.item_code, i.item_name, i.manufacturer, i.quantity, i.unit
    from ref f
    join items i on i.chain_id = f.chain_id and i.q = f.q and (i.dim = f.dim or f.dim = 'x' or i.dim = 'x')
    where not exists (select 1 from public.product_matches pm
      where pm.chain_id = f.chain_id and pm.barcode = f.barcode and pm.item_code = i.item_code)
  ),
  -- המילים בשם הייחוס, ואיזה חלק מהן נמצא בשם המועמד. השמות נחתכים, ולכן גם התחלה של מילה נחשבת (3 תווים ומעלה)
  ref_words as (
    select distinct f.chain_id, f.barcode, w
    from ref f, unnest(string_to_array(public.pm_norm(f.item_name), ' ')) w
    where length(w) >= 2
  ),
  ref_count as (
    select chain_id, barcode, count(*) as n from ref_words group by 1, 2
  ),
  pair_words as (
    select p.chain_id, p.barcode, p.item_code, x
    from pairs p, unnest(string_to_array(public.pm_norm(p.item_name), ' ')) x
    where length(x) >= 2
  ),
  hits as (
    select pw.chain_id, pw.barcode, pw.item_code, count(distinct rw.w) as h
    from pair_words pw
    join ref_words rw on rw.chain_id = pw.chain_id and rw.barcode = pw.barcode
      and (pw.x = rw.w or (length(rw.w) >= 3 and pw.x like rw.w || '%') or (length(pw.x) >= 3 and rw.w like pw.x || '%'))
    group by 1, 2, 3
  ),
  top as (
    select p.*, round(h.h::numeric / rc.n, 2) as score,
      row_number() over (partition by p.chain_id, p.barcode order by h.h::numeric / rc.n desc, p.item_code) as rn
    from pairs p
    join hits h using (chain_id, barcode, item_code)
    join ref_count rc using (chain_id, barcode)
    where h.h::numeric / rc.n >= 0.5
  )
  select jsonb_build_object(
    'pairs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'chain_id', m.chain_id, 'barcode', m.barcode,
        'ref_name', f.item_name, 'ref_manufacturer', f.manufacturer, 'ref_quantity', f.quantity, 'ref_unit', f.unit,
        'pending', (select count(*) from public.product_matches pm
          where pm.chain_id = m.chain_id and pm.barcode = m.barcode and pm.status = 'pending'),
        'candidates', coalesce((
          select jsonb_agg(jsonb_build_object(
            'item_code', t.item_code, 'item_name', t.item_name, 'manufacturer', t.manufacturer,
            'quantity', t.quantity, 'unit', t.unit, 'score', t.score) order by t.rn)
          from top t where t.chain_id = m.chain_id and t.barcode = m.barcode and t.rn <= 3
        ), '[]'::jsonb)
      ) order by m.chain_id, m.barcode)
      from missing m
      left join ref f on f.chain_id = m.chain_id and f.barcode = m.barcode
    ), '[]'::jsonb),
    'active', coalesce((
      select jsonb_object_agg(chain_id, n) from (
        select chain_id, count(*) as n from public.product_matches
        where status in ('auto', 'approved') group by chain_id
      ) a
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.product_match_candidates(text[]) from public, anon, authenticated;
grant execute on function public.product_match_candidates(text[]) to service_role;

-- ---------- n8n: שמירה ----------
-- p = { rows: [{ chain_id, barcode, item_code, item_name, manufacturer, quantity, unit, ref_name, ref_manufacturer,
--               status: auto|pending|rejected, verdict, reason, title }], gemini_ok, summary }
-- auto כשכבר יש התאמה פעילה לאותו צירוף: נשמר כ-pending. pending: אירוע action. auto: אירוע info.
create or replace function public.product_match_save(p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  x jsonb;
  v_status text;
  v_id bigint;
  saved integer := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) loop
    v_status := x ->> 'status';
    if v_status not in ('auto', 'pending', 'rejected') then
      continue;
    end if;
    if v_status = 'auto' and exists (select 1 from public.product_matches m
        where m.chain_id = x ->> 'chain_id' and m.barcode = x ->> 'barcode' and m.status in ('auto', 'approved')) then
      v_status := 'pending';
    end if;

    insert into public.product_matches (chain_id, barcode, item_code, item_name, manufacturer, quantity, unit,
        ref_name, ref_manufacturer, status, verdict, reason, decided_at)
      values (x ->> 'chain_id', x ->> 'barcode', x ->> 'item_code', x ->> 'item_name', x ->> 'manufacturer',
        nullif(x ->> 'quantity', '')::numeric, x ->> 'unit', x ->> 'ref_name', x ->> 'ref_manufacturer',
        v_status, x ->> 'verdict', left(x ->> 'reason', 200),
        case when v_status = 'pending' then null else now() end)
      on conflict (chain_id, barcode, item_code) do nothing
      returning id into v_id;

    if v_id is null then
      continue;
    end if;
    saved := saved + 1;
    if v_status in ('auto', 'pending') then
      insert into public.agent_events (agent, kind, title, ref_table, ref_id)
        values ('product_match', case v_status when 'auto' then 'info' else 'action' end,
          left(coalesce(x ->> 'title', 'התאמת מוצר'), 300), 'product_matches', v_id)
        on conflict do nothing;
    end if;
    v_id := null;
  end loop;

  insert into public.product_match_runs (gemini_ok, summary)
    values ((p ->> 'gemini_ok')::boolean, p -> 'summary')
    on conflict (run_day) do update set gemini_ok = excluded.gemini_ok, summary = excluded.summary, created_at = now();

  return saved;
end;
$$;

revoke execute on function public.product_match_save(jsonb) from public, anon, authenticated;
grant execute on function public.product_match_save(jsonb) to service_role;

-- ---------- דוח הבוקר: גם ההתאמות והסיכום של היום ----------
-- אותה פונקציה ממיילסטונים 13 ו-14, עם המקרה product_matches ועם product_match_run
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
          when 'product_matches' then (
            select jsonb_build_object(
              'chain_id', m.chain_id, 'barcode', m.barcode, 'item_code', m.item_code,
              'item_name', m.item_name, 'manufacturer', m.manufacturer, 'quantity', m.quantity, 'unit', m.unit,
              'ref_name', m.ref_name, 'status', m.status, 'verdict', m.verdict, 'reason', m.reason)
            from public.product_matches m where m.id = e.ref_id)
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
    )
  );
$$;

revoke execute on function public.agent_morning_report() from public, anon, authenticated;
grant execute on function public.agent_morning_report() to service_role;

-- ---------- הדוח נשלח ----------
-- אותה פונקציה ממיילסטון 13, וגם: אירוע על התאמה שנמחקה נסגר
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
