-- ============================================================
-- Academia Curiosamente — esquema inicial
-- Aplicar en el proyecto Supabase de la academia (SQL Editor
-- o via MCP apply_migration).
-- ============================================================

-- ---------- Profesores (vinculados a usuarios de Supabase Auth) ----------
create table public.profesores (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null,
  email text not null,
  telefono text,
  es_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Al crear un usuario en Auth se crea automáticamente su fila de profesor.
-- Metadatos opcionales al crear el usuario: { "nombre": "...", "es_admin": true }
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profesores (id, nombre, email, es_admin)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1)),
    new.email,
    coalesce((new.raw_user_meta_data ->> 'es_admin')::boolean, false)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper para las políticas: ¿el usuario conectado es administrador?
create or replace function public.is_admin()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce(
    (select es_admin from public.profesores where id = auth.uid()),
    false
  );
$$;

-- ---------- Asignaturas / niveles ----------
create table public.asignaturas (
  id serial primary key,
  nombre text not null unique
);

insert into public.asignaturas (nombre) values
  ('Inglés — clases particulares'),
  ('Inglés — B1'),
  ('Inglés — B2'),
  ('Inglés — C1'),
  ('Matemáticas — clases particulares'),
  ('Física y Química — clases particulares');

-- ---------- Alumnos ----------
create table public.alumnos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  telefono text,
  email text,
  tutor_nombre text,
  tutor_telefono text,
  profesor_id uuid not null references public.profesores (id),
  asignatura_id integer not null references public.asignaturas (id),
  modalidad text not null default 'presencial' check (modalidad in ('presencial', 'online')),
  horas_semana numeric,
  tarifa numeric not null,
  tipo_tarifa text not null default 'mes' check (tipo_tarifa in ('mes', 'clase')),
  estado text not null default 'activo' check (estado in ('activo', 'baja')),
  fecha_alta date not null default current_date,
  facturacion_nombre text,
  facturacion_direccion text,
  notas text,
  created_at timestamptz not null default now()
);

-- ---------- Recibos ----------
create table public.recibos (
  id uuid primary key default gen_random_uuid(),
  referencia bigint generated always as identity,  -- número interno correlativo
  alumno_id uuid not null references public.alumnos (id) on delete cascade,
  profesor_id uuid not null references public.profesores (id),
  fecha_emision date not null default current_date,
  concepto text not null,          -- meses facturados, ej. "Abril+mayo+junio"
  importe numeric not null,        -- campo "Total" en cifra (sin IVA, confirmado)
  importe_letras text not null,    -- campo "La cantidad de"
  estado text not null default 'emitido' check (estado in ('emitido', 'enviado', 'pagado', 'pendiente')),
  fecha_envio_whatsapp timestamptz,
  pdf_path text,
  created_at timestamptz not null default now()
);

create index recibos_alumno_idx on public.recibos (alumno_id);
create index recibos_profesor_idx on public.recibos (profesor_id);
create index alumnos_profesor_idx on public.alumnos (profesor_id);

-- ---------- Seguridad (RLS): cada profesor solo ve lo suyo; el admin, todo ----------
alter table public.profesores enable row level security;
alter table public.asignaturas enable row level security;
alter table public.alumnos enable row level security;
alter table public.recibos enable row level security;

-- Profesores: todos los usuarios autenticados pueden ver la lista de nombres
-- (necesario para los selectores); solo el propio profesor o el admin editan.
create policy "profesores_select" on public.profesores
  for select to authenticated using (true);
create policy "profesores_update" on public.profesores
  for update to authenticated
  using (id = auth.uid() or public.is_admin());

-- Asignaturas: lectura para todos; solo el admin las modifica.
create policy "asignaturas_select" on public.asignaturas
  for select to authenticated using (true);
create policy "asignaturas_admin" on public.asignaturas
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Alumnos: cada profesor gestiona los suyos; el admin, todos.
create policy "alumnos_select" on public.alumnos
  for select to authenticated
  using (profesor_id = auth.uid() or public.is_admin());
create policy "alumnos_insert" on public.alumnos
  for insert to authenticated
  with check (profesor_id = auth.uid() or public.is_admin());
create policy "alumnos_update" on public.alumnos
  for update to authenticated
  using (profesor_id = auth.uid() or public.is_admin());
create policy "alumnos_delete" on public.alumnos
  for delete to authenticated
  using (profesor_id = auth.uid() or public.is_admin());

-- Recibos: mismas reglas que alumnos.
create policy "recibos_select" on public.recibos
  for select to authenticated
  using (profesor_id = auth.uid() or public.is_admin());
create policy "recibos_insert" on public.recibos
  for insert to authenticated
  with check (profesor_id = auth.uid() or public.is_admin());
create policy "recibos_update" on public.recibos
  for update to authenticated
  using (profesor_id = auth.uid() or public.is_admin());
create policy "recibos_delete" on public.recibos
  for delete to authenticated
  using (profesor_id = auth.uid() or public.is_admin());

-- ---------- Clases (grupos) y horarios ----------
insert into public.asignaturas (nombre) values ('Inglés — Intensivo (verano)');

create table public.clases (
  id uuid primary key default gen_random_uuid(),
  profesor_id uuid not null references public.profesores (id),
  asignatura_id integer not null references public.asignaturas (id),
  nombre text not null,
  color text,          -- color elegido para la clase (hex), ej. "#3D7DC8"
  notas text,
  created_at timestamptz not null default now()
);

create table public.clase_horarios (
  id uuid primary key default gen_random_uuid(),
  clase_id uuid not null references public.clases (id) on delete cascade,
  dia_semana integer not null check (dia_semana between 1 and 7), -- 1=lunes … 7=domingo
  hora time not null,
  duracion_min integer not null default 60
);

create table public.clase_alumnos (
  clase_id uuid not null references public.clases (id) on delete cascade,
  alumno_id uuid not null references public.alumnos (id) on delete cascade,
  primary key (clase_id, alumno_id)
);

create index clases_profesor_idx on public.clases (profesor_id);
create index clase_horarios_clase_idx on public.clase_horarios (clase_id);
create index clase_alumnos_clase_idx on public.clase_alumnos (clase_id);

alter table public.clases enable row level security;
alter table public.clase_horarios enable row level security;
alter table public.clase_alumnos enable row level security;

create policy "clases_select" on public.clases
  for select to authenticated
  using (profesor_id = auth.uid() or public.is_admin());
create policy "clases_insert" on public.clases
  for insert to authenticated
  with check (profesor_id = auth.uid() or public.is_admin());
create policy "clases_update" on public.clases
  for update to authenticated
  using (profesor_id = auth.uid() or public.is_admin());
create policy "clases_delete" on public.clases
  for delete to authenticated
  using (profesor_id = auth.uid() or public.is_admin());

create policy "clase_horarios_all" on public.clase_horarios
  for all to authenticated
  using (exists (select 1 from public.clases c where c.id = clase_id and (c.profesor_id = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.clases c where c.id = clase_id and (c.profesor_id = auth.uid() or public.is_admin())));

create policy "clase_alumnos_all" on public.clase_alumnos
  for all to authenticated
  using (exists (select 1 from public.clases c where c.id = clase_id and (c.profesor_id = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.clases c where c.id = clase_id and (c.profesor_id = auth.uid() or public.is_admin())));

-- ---------- Excepciones del horario: anulaciones y sesiones alternativas ----------
create table public.clase_excepciones (
  id uuid primary key default gen_random_uuid(),
  clase_id uuid not null references public.clases (id) on delete cascade,
  fecha date not null,
  tipo text not null check (tipo in ('anulada', 'extra')),
  hora time,             -- solo para tipo 'extra'
  duracion_min integer,  -- solo para tipo 'extra'
  nombre text,           -- etiqueta de la sesión alternativa
  motivo text,           -- opcional (fiesta, asuntos propios…)
  created_at timestamptz not null default now()
);

create index clase_excepciones_clase_idx on public.clase_excepciones (clase_id);
create index clase_excepciones_fecha_idx on public.clase_excepciones (fecha);

alter table public.clase_excepciones enable row level security;

create policy "clase_excepciones_all" on public.clase_excepciones
  for all to authenticated
  using (exists (select 1 from public.clases c where c.id = clase_id and (c.profesor_id = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.clases c where c.id = clase_id and (c.profesor_id = auth.uid() or public.is_admin())));

-- ---------- Materias por profesor ----------
-- Cada profesor solo ve sus asignaturas en la app; los admin ven todas.
create table public.profesor_asignaturas (
  profesor_id uuid not null references public.profesores (id) on delete cascade,
  asignatura_id integer not null references public.asignaturas (id) on delete cascade,
  primary key (profesor_id, asignatura_id)
);

alter table public.profesor_asignaturas enable row level security;

create policy "profesor_asignaturas_select" on public.profesor_asignaturas
  for select to authenticated using (true);
create policy "profesor_asignaturas_admin" on public.profesor_asignaturas
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Asignar materias (ejemplo; ajustar emails):
-- insert into public.profesor_asignaturas (profesor_id, asignatura_id)
-- select p.id, a.id from public.profesores p cross join public.asignaturas a
-- where p.email = 'profesor@ejemplo.com' and a.nombre like 'Inglés%';

-- ---------- Notas tipo pósit y fecha de pago ----------
alter table public.recibos add column fecha_pago timestamptz;

create table public.notas (
  id uuid primary key default gen_random_uuid(),
  profesor_id uuid not null references public.profesores (id) on delete cascade,
  texto text not null default '',
  color text,
  created_at timestamptz not null default now()
);

alter table public.notas enable row level security;

create policy "notas_propias" on public.notas
  for all to authenticated
  using (profesor_id = auth.uid())
  with check (profesor_id = auth.uid());

-- ---------- Conflictos de horario entre clases ----------
-- Evita que el mismo alumno (mismo nombre, aunque esté dado de alta con
-- distintos profesores) tenga dos clases que se solapen en día y hora.
create or replace function public.nombre_normalizado(t text)
returns text language sql immutable
as $$ select lower(regexp_replace(trim(t), '\s+', ' ', 'g')) $$;

create or replace function public.check_conflicto_alumno()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare c record;
begin
  select a1.nombre as alumno, c2.nombre as clase2, p2.nombre as profe2,
         h1.dia_semana, h2.hora
  into c
  from public.alumnos a1
  join public.clase_horarios h1 on h1.clase_id = new.clase_id
  join public.alumnos a2
    on a2.id <> a1.id
   and public.nombre_normalizado(a2.nombre) = public.nombre_normalizado(a1.nombre)
  join public.clase_alumnos ca2 on ca2.alumno_id = a2.id and ca2.clase_id <> new.clase_id
  join public.clase_horarios h2 on h2.clase_id = ca2.clase_id and h2.dia_semana = h1.dia_semana
  join public.clases c2 on c2.id = ca2.clase_id
  join public.profesores p2 on p2.id = c2.profesor_id
  where a1.id = new.alumno_id
    and h1.hora < h2.hora + make_interval(mins => coalesce(h2.duracion_min, 60))
    and h2.hora < h1.hora + make_interval(mins => coalesce(h1.duracion_min, 60))
  limit 1;

  if found then
    raise exception 'Conflicto de horario: % ya tiene clase "%" con % el % a las %',
      c.alumno, c.clase2, c.profe2,
      (array['lunes','martes','miércoles','jueves','viernes','sábado','domingo'])[c.dia_semana],
      to_char(c.hora, 'HH24:MI');
  end if;
  return new;
end;
$$;

create trigger conflicto_alumno_clase
  before insert on public.clase_alumnos
  for each row execute function public.check_conflicto_alumno();

create or replace function public.check_conflicto_horario()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare c record;
begin
  select a1.nombre as alumno, c2.nombre as clase2, p2.nombre as profe2, h2.hora
  into c
  from public.clase_alumnos ca1
  join public.alumnos a1 on a1.id = ca1.alumno_id
  join public.alumnos a2
    on a2.id <> a1.id
   and public.nombre_normalizado(a2.nombre) = public.nombre_normalizado(a1.nombre)
  join public.clase_alumnos ca2 on ca2.alumno_id = a2.id and ca2.clase_id <> new.clase_id
  join public.clase_horarios h2 on h2.clase_id = ca2.clase_id and h2.dia_semana = new.dia_semana
  join public.clases c2 on c2.id = ca2.clase_id
  join public.profesores p2 on p2.id = c2.profesor_id
  where ca1.clase_id = new.clase_id
    and new.hora < h2.hora + make_interval(mins => coalesce(h2.duracion_min, 60))
    and h2.hora < new.hora + make_interval(mins => coalesce(new.duracion_min, 60))
  limit 1;

  if found then
    raise exception 'Conflicto de horario: el alumno % ya tiene clase "%" con % ese día a las %',
      c.alumno, c.clase2, c.profe2, to_char(c.hora, 'HH24:MI');
  end if;
  return new;
end;
$$;

create trigger conflicto_horario_clase
  before insert on public.clase_horarios
  for each row execute function public.check_conflicto_horario();

revoke execute on function public.check_conflicto_alumno() from public, anon, authenticated;
revoke execute on function public.check_conflicto_horario() from public, anon, authenticated;
revoke execute on function public.nombre_normalizado(text) from anon;

-- ============================================================
-- FICHA ÚNICA DE ALUMNO + MATRÍCULAS (rediseño)
-- Una sola ficha por alumno para toda la academia; las asignaturas a las que
-- está apuntado (con su tarifa) viven en `matriculas`. Ver migraciones
-- aplicadas en Supabase: ficha_unica_y_matriculas, duplicados_ignorando_acentos.
-- Resumen de lo aplicado:
--   * tabla matriculas (alumno_id, asignatura_id, tarifa, tipo_tarifa,
--     horas_semana, unique(alumno_id, asignatura_id))
--   * alumnos pierde asignatura_id/profesor_id/tarifa/tipo_tarifa/horas_semana/modalidad
--   * RLS: fichas y matrículas legibles/editables por todos los profesores
--     (base de datos conjunta); borrar fichas solo admin
--   * índice único alumnos_nombre_unico sobre nombre_normalizado(nombre),
--     con unaccent: "María Pérez" = "maria perez" → duplicado rechazado
--   * triggers de conflicto de horario comparan por alumno_id (identidad real)
--   * función dar_baja_alumno(uuid): estado 'baja' + fuera de todas las clases
-- ============================================================

-- ---------- Endurecimiento del acceso anónimo (sin sesión) ----------
-- Por defecto Supabase concede a "anon" acceso base a todas las tablas
-- (luego se filtra con RLS). Como esta app no tiene ningún uso sin sesión,
-- se le retira el acceso de raíz: así nadie sin usuario/contraseña puede
-- ni leer, ni escribir, ni "tantear" nombres de tablas/columnas probando.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
revoke all on all functions in schema public from anon;
alter default privileges in schema public revoke all on functions from anon;
notify pgrst, 'reload schema';

-- check_recibo_duplicado es un disparador interno: nunca se llama a mano.
revoke execute on function public.check_recibo_duplicado() from public, anon, authenticated;

-- search_path fijo en las funciones auxiliares del anti-duplicados de alumnos.
alter function public.nombre_normalizado(text) set search_path = public, extensions;
alter function public.quitar_acentos(text) set search_path = public, extensions;

-- ---------- Endurecimiento: las funciones internas no son invocables por la API ----------
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
