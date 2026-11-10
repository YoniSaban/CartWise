-- סל אוטומטי: נבנה מחדש אחרי כל עדכון מחירים של רשת (טריגר על chain_items)
-- כלל: מוצרים מהקטלוג שנמצאים בכל הרשתות, לפי סדר העדיפות, עד 25.
-- אם יש פחות מ-15 כאלה, משלימים ל-15 עם המוצרים שנמצאים בהכי הרבה רשתות.

create table if not exists public.auto_basket_candidates (
  barcode text primary key,
  name text not null,
  priority int not null
);

create table if not exists public.auto_basket (
  barcode text primary key,
  position int not null,
  chains_found int not null,
  chains_total int not null,
  built_at timestamptz not null default now()
);

alter table public.auto_basket_candidates enable row level security;
alter table public.auto_basket enable row level security;
drop policy if exists "auto_basket public read" on public.auto_basket;
create policy "auto_basket public read" on public.auto_basket for select to anon, authenticated using (true);

create or replace function public.refresh_auto_basket()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  total int;
begin
  select count(distinct chain_id) into total from public.chain_items;

  delete from public.auto_basket where true;

  insert into public.auto_basket (barcode, position, chains_found, chains_total)
  select barcode, row_number() over (order by full_match desc, found desc, priority), found, total
  from (
    select c.barcode, c.priority,
           count(distinct i.chain_id)::int as found,
           count(distinct i.chain_id) = total as full_match
    from public.auto_basket_candidates c
    left join public.chain_items i on i.item_code = c.barcode and i.price > 0
    group by c.barcode, c.priority
  ) s
  where found > 0
  order by full_match desc, found desc, priority
  limit greatest(
    15,
    least(25, (select count(*) from (
      select c.barcode from public.auto_basket_candidates c
      join public.chain_items i on i.item_code = c.barcode and i.price > 0
      group by c.barcode having count(distinct i.chain_id) = total) f))
  );
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
