-- LECTORIA: esquema inicial para dos cuentas privadas.
-- Ejecutar en Supabase > SQL Editor.
-- Crear las dos cuentas primero en Authentication > Users (desactivar signups públicos).
-- Luego sustituir los UUID en los INSERT de profiles.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('admin','reader')),
  created_at timestamptz not null default now()
);

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  original_name text not null,
  storage_path text not null unique,
  file_size bigint not null check (file_size > 0),
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.reading_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  page_number integer not null default 1 check (page_number > 0),
  progress_percent numeric(5,2) not null default 0 check (progress_percent between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key(user_id,book_id)
);

alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.reading_progress enable row level security;

-- Perfil: cada persona puede leer su propio perfil; no cambiar su rol desde el navegador.
create policy "profile read own" on public.profiles
for select to authenticated using (id = auth.uid());

-- Libros: ambas cuentas autorizadas pueden ver los metadatos.
create policy "authorized users read books" on public.books
for select to authenticated using (
  exists(select 1 from public.profiles p where p.id=auth.uid())
);

-- Solo administradora puede insertar o borrar libros.
create policy "admin insert books" on public.books
for insert to authenticated with check (
  uploaded_by = auth.uid() and
  exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);
create policy "admin delete books" on public.books
for delete to authenticated using (
  exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);

-- Cada lectora solo puede leer y modificar su propio progreso.
create policy "read own progress" on public.reading_progress
for select to authenticated using (user_id=auth.uid());
create policy "insert own progress" on public.reading_progress
for insert to authenticated with check (user_id=auth.uid());
create policy "update own progress" on public.reading_progress
for update to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());

-- Bucket privado para PDF. Crear bucket books desde Storage con límite de 50 MB
-- y MIME application/pdf, o crear desde Dashboard antes de aplicar las políticas.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('books','books',false,52428800,array['application/pdf'])
on conflict (id) do update set public=false,file_size_limit=52428800,allowed_mime_types=array['application/pdf'];

-- Ambas cuentas pueden descargar archivos solo si existe un perfil autorizado.
create policy "authorized users read pdf" on storage.objects
for select to authenticated using (
  bucket_id='books' and
  exists(select 1 from public.profiles p where p.id=auth.uid())
);

-- Solo admin puede subir y borrar objetos.
create policy "admin upload pdf" on storage.objects
for insert to authenticated with check (
  bucket_id='books' and
  (storage.foldername(name))[1]=auth.uid()::text and
  exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);
create policy "admin delete pdf" on storage.objects
for delete to authenticated using (
  bucket_id='books' and
  exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);

-- IMPORTANTE: después de crear las dos cuentas en Auth, inserta sus perfiles:
-- insert into public.profiles(id,display_name,role) values
-- ('UUID_ADMIN','Tu nombre','admin'),
-- ('UUID_AMIGA','Nombre de tu amiga','reader');
