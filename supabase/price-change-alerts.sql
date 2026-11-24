-- התראה על שינוי מחיר: שומרים את המחיר הקודם בכל פעם שהמחיר משתנה
-- n8n לא משתנה: ה-upsert הקיים מפעיל את הטריגר, והוא ממלא את העמודות החדשות.
-- להרצה פעם אחת ב-SQL Editor של Supabase.

alter table public.chain_items
  add column if not exists previous_price numeric,
  add column if not exists previous_price_per_kg numeric,
  add column if not exists price_changed_at timestamptz;

comment on column public.chain_items.previous_price is 'המחיר לפני השינוי האחרון';
comment on column public.chain_items.previous_price_per_kg is 'המחיר לק"ג לפני השינוי האחרון';
comment on column public.chain_items.price_changed_at is 'ה-loaded_at של העדכון שבו המחיר השתנה';

create or replace function public.chain_items_keep_previous_price()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.price is distinct from old.price
     or new.price_per_kg is distinct from old.price_per_kg then
    new.previous_price := old.price;
    new.previous_price_per_kg := old.price_per_kg;
    new.price_changed_at := new.loaded_at;
  end if;
  return new;
end;
$$;

drop trigger if exists chain_items_keep_previous_price on public.chain_items;
create trigger chain_items_keep_previous_price
  before update on public.chain_items
  for each row execute function public.chain_items_keep_previous_price();
