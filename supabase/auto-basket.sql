-- סל אוטומטי, לכל עיר בנפרד: נבנה מחדש אחרי כל עדכון מחירים של סניף (טריגר על chain_items).
-- כלל: מוצרים מהקטלוג שנמצאים בכל הסניפים של העיר, לפי סדר העדיפות, עד 25.
-- אם יש פחות מ-15 כאלה, משלימים ל-15 עם המוצרים שנמצאים בהכי הרבה סניפים.
-- הרשימות עצמן (מוצרים וסניפים): supabase/auto-basket-candidates.sql

create table if not exists public.auto_basket_candidates (
  barcode text primary key,
  name text not null,
  priority int not null
);

create table if not exists public.auto_basket_branches (
  chain_id text primary key,
  city text not null
);

create table if not exists public.auto_basket (
  city text not null,
  barcode text not null,
  position int not null,
  chains_found int not null,
  chains_total int not null,
  built_at timestamptz not null default now(),
  primary key (city, barcode)
);

alter table public.auto_basket_candidates enable row level security;
alter table public.auto_basket_branches enable row level security;
alter table public.auto_basket enable row level security;
drop policy if exists "auto_basket public read" on public.auto_basket;
create policy "auto_basket public read" on public.auto_basket for select to anon, authenticated using (true);

create or replace function public.refresh_auto_basket()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- עדכון מחירים נשלח בכמה חלקים במקביל. הנעילה גורמת לבנייה לרוץ אחת אחרי השנייה,
  -- אחרת שתי בניות מוחקות ומכניסות באותו זמן ונכשלות על כפילות (409)
  perform pg_advisory_xact_lock(hashtext('cartwise_auto_basket'));

  delete from public.auto_basket where true;

  insert into public.auto_basket (city, barcode, position, chains_found, chains_total)
  select city, barcode, rn, n_found, total
  from (
    select f.*,
           row_number() over (partition by city order by n_found desc, priority) as rn,
           count(*) filter (where n_found = total) over (partition by city) as full_count
    from (
      select t.city, t.total, k.barcode, k.priority, count(distinct i.chain_id)::int as n_found
      from (select city, count(*)::int as total from public.auto_basket_branches group by city) t
      join public.auto_basket_branches b on b.city = t.city
      join public.chain_items i on i.chain_id = b.chain_id and i.price > 0
      join public.auto_basket_candidates k on k.barcode = i.item_code
      group by t.city, t.total, k.barcode, k.priority
    ) f
  ) r
  where rn <= greatest(15, least(25, full_count));
end;
$$;

revoke all on function public.refresh_auto_basket() from public, anon, authenticated;

create or replace function public.auto_basket_after_prices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.refresh_auto_basket();
  return null;
end;
$$;

revoke all on function public.auto_basket_after_prices() from public, anon, authenticated;

drop trigger if exists auto_basket_after_prices on public.chain_items;
create trigger auto_basket_after_prices
after insert or update or delete on public.chain_items
for each statement execute function public.auto_basket_after_prices();
