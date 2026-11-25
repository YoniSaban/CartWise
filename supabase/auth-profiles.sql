-- מיילסטון 10: התחברות עם Google
-- טבלת profiles: שם, מייל ותמונה של כל משתמש מחובר. נוצרת אוטומטית בכניסה הראשונה.
-- מריצים פעם אחת ב-SQL Editor של Supabase. אפשר להריץ שוב בלי נזק.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  email text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- הרשאות: משתמש מחובר קורא רק את השורה שלו. אין כתיבה מהדפדפן, ואנונימי לא רואה כלום
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

revoke all on public.profiles from anon;
revoke insert, update, delete on public.profiles from authenticated;
grant select on public.profiles to authenticated;

-- שורה חדשה בכניסה הראשונה, מהפרטים ש-Google מסר
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.email,
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- מחיקת חשבון: משתמש מחובר מוחק רק את עצמו. השורה ב-profiles (וכל טבלה עתידית
-- שמפנה ל-auth.users עם cascade) נמחקת איתו
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
