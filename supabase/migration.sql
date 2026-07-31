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

-- ---------- Aforo de clases y horario de trabajo por profesor ----------
alter table public.clases
  add column capacidad integer not null default 6 check (capacidad between 1 and 8);

create table public.profesor_horario (
  id uuid primary key default gen_random_uuid(),
  profesor_id uuid not null references public.profesores (id) on delete cascade,
  dia_semana integer not null check (dia_semana between 1 and 7),
  hora_inicio time not null,
  hora_fin time not null,
  check (hora_fin > hora_inicio)
);

create index profesor_horario_profesor_idx on public.profesor_horario (profesor_id);

alter table public.profesor_horario enable row level security;

create policy "profesor_horario_select" on public.profesor_horario
  for select to authenticated using (true);
create policy "profesor_horario_write" on public.profesor_horario
  for all to authenticated
  using (profesor_id = auth.uid() or public.is_admin())
  with check (profesor_id = auth.uid() or public.is_admin());

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

-- ============================================================
-- SEGUNDA REUNIÓN CON LA ACADEMIA: contabilidad, descuentos automáticos,
-- modificaciones de horas, precio solo-admin y matrícula en el recibo
-- ============================================================

-- ---------- Apellidos (para hermanos), descuento especial, precio opcional ----------
alter table public.alumnos add column apellidos text;
alter table public.alumnos add column descuento_extra numeric not null default 0;
alter table public.matriculas alter column tarifa drop not null;
alter table public.recibos add column incluye_matricula boolean not null default false;
alter table public.recibos add column importe_matricula numeric not null default 0;

-- ---------- Historial de cambios de horas semanales ("modificaciones") ----------
create table public.cambios_horario (
  id uuid primary key default gen_random_uuid(),
  matricula_id uuid references public.matriculas (id) on delete cascade,
  alumno_id uuid not null references public.alumnos (id) on delete cascade,
  profesor_id uuid not null references public.profesores (id),
  horas_antes numeric,
  horas_despues numeric not null,
  nota text,
  fecha timestamptz not null default now(),
  visto boolean not null default false
);

create index cambios_horario_alumno_idx on public.cambios_horario (alumno_id);
create index cambios_horario_visto_idx on public.cambios_horario (visto) where not visto;

alter table public.cambios_horario enable row level security;

create policy "cambios_horario_select" on public.cambios_horario
  for select to authenticated using (true);
create policy "cambios_horario_insert" on public.cambios_horario
  for insert to authenticated with check (profesor_id = auth.uid() or public.is_admin());
create policy "cambios_horario_update" on public.cambios_horario
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Ingresos y gastos de la academia (solo administrador) ----------
create table public.finanzas_movimientos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ingreso', 'gasto')),
  categoria text not null,
  importe numeric not null check (importe > 0),
  fecha date not null default current_date,
  descripcion text,
  origen text not null default 'manual' check (origen in ('manual', 'automatico')),
  recibo_id uuid references public.recibos (id) on delete cascade,
  creado_por uuid references public.profesores (id),
  created_at timestamptz not null default now()
);

create index finanzas_fecha_idx on public.finanzas_movimientos (fecha);
create index finanzas_recibo_idx on public.finanzas_movimientos (recibo_id);

alter table public.finanzas_movimientos enable row level security;
create policy "finanzas_solo_admin" on public.finanzas_movimientos
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Motor de descuentos: base de asignaturas de tipo mes, -5€ por
-- cada asignatura si hay 2+, -5€ si tiene hermano activo (mismos apellidos),
-- -descuento_extra individual. Fuente única para la app y la generación automática.
create or replace function public.calcular_descuentos_alumno(p_alumno_id uuid)
returns table (
  base numeric, n_asignaturas integer, descuento_multi numeric,
  descuento_hermano numeric, descuento_extra numeric, total numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_base numeric; v_n integer; v_apellidos text;
  v_tiene_hermano boolean := false; v_descuento_extra numeric;
begin
  select count(*), sum(m.tarifa) into v_n, v_base
  from public.matriculas m where m.alumno_id = p_alumno_id and m.tipo_tarifa = 'mes';

  select a.apellidos, a.descuento_extra into v_apellidos, v_descuento_extra
  from public.alumnos a where a.id = p_alumno_id;

  if v_apellidos is not null and trim(v_apellidos) <> '' then
    select exists (
      select 1 from public.alumnos a2
      where a2.id <> p_alumno_id and a2.estado = 'activo' and a2.apellidos is not null
        and public.nombre_normalizado(a2.apellidos) = public.nombre_normalizado(v_apellidos)
    ) into v_tiene_hermano;
  end if;

  return query select
    v_base, coalesce(v_n, 0),
    case when coalesce(v_n, 0) >= 2 then 5::numeric * v_n else 0::numeric end,
    case when v_tiene_hermano then 5::numeric else 0::numeric end,
    coalesce(v_descuento_extra, 0),
    case when v_base is null then null
      else greatest(0, v_base
        - (case when coalesce(v_n, 0) >= 2 then 5::numeric * v_n else 0::numeric end)
        - (case when v_tiene_hermano then 5::numeric else 0::numeric end)
        - coalesce(v_descuento_extra, 0))
    end;
end;
$$;

revoke execute on function public.calcular_descuentos_alumno(uuid) from public, anon;
grant execute on function public.calcular_descuentos_alumno(uuid) to authenticated;

-- ---------- Recibos automáticos el día 3 (antes 25), con descuentos ----------
create or replace function public.generar_recibos_mensuales()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_periodo text := to_char(now(), 'YYYY-MM');
  v_mes text := (array['Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'])[extract(month from now())::int];
  v_admin uuid; v_creados integer := 0; fila record; v_desc record;
begin
  select id into v_admin from public.profesores where es_admin and estado = 'activo' order by created_at limit 1;
  if v_admin is null then raise exception 'No hay administrador activo'; end if;

  for fila in
    select a.id as alumno_id from public.alumnos a
    where a.estado = 'activo'
      and exists (select 1 from public.matriculas m where m.alumno_id = a.id and m.tipo_tarifa = 'mes' and m.tarifa is not null)
  loop
    select * into v_desc from public.calcular_descuentos_alumno(fila.alumno_id);
    if v_desc.total is null or v_desc.total <= 0 then continue; end if;
    begin
      insert into public.recibos (alumno_id, profesor_id, fecha_emision, concepto, importe, importe_letras, estado, periodos)
      values (fila.alumno_id, v_admin, current_date, v_mes, v_desc.total, '', 'pendiente', array[v_periodo]);
      v_creados := v_creados + 1;
    exception when others then null; end;
  end loop;
  return v_creados;
end;
$$;

select cron.unschedule('recibos-mensuales');
select cron.schedule('recibos-mensuales', '0 6 3 * *', 'select public.generar_recibos_mensuales()');

-- ---------- Solo el administrador marca pagado; Ingresos se sincroniza solo ----------
create or replace function public.restringir_pago_a_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (new.estado is distinct from old.estado or new.fecha_pago is distinct from old.fecha_pago)
     and not public.is_admin() then
    raise exception 'Solo el administrador puede marcar un recibo como pagado';
  end if;
  return new;
end;
$$;

create trigger recibos_pago_solo_admin
  before update on public.recibos
  for each row execute function public.restringir_pago_a_admin();

create or replace function public.sincronizar_finanzas_recibo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.estado = 'pagado' and old.estado is distinct from 'pagado' then
    if (new.importe - new.importe_matricula) > 0 then
      insert into public.finanzas_movimientos (tipo, categoria, importe, fecha, descripcion, origen, recibo_id)
      values ('ingreso', 'Mensualidad', new.importe - new.importe_matricula,
        coalesce(new.fecha_pago::date, current_date), 'Recibo R-' || lpad(new.referencia::text, 5, '0'), 'automatico', new.id);
    end if;
    if new.incluye_matricula and new.importe_matricula > 0 then
      insert into public.finanzas_movimientos (tipo, categoria, importe, fecha, descripcion, origen, recibo_id)
      values ('ingreso', 'Matrícula', new.importe_matricula,
        coalesce(new.fecha_pago::date, current_date), 'Recibo R-' || lpad(new.referencia::text, 5, '0'), 'automatico', new.id);
    end if;
  elsif old.estado = 'pagado' and new.estado is distinct from 'pagado' then
    delete from public.finanzas_movimientos where recibo_id = new.id and origen = 'automatico';
  end if;
  return new;
end;
$$;

create trigger recibos_sync_finanzas
  after update on public.recibos
  for each row execute function public.sincronizar_finanzas_recibo();

-- La función de WhatsApp (supabase/functions/enviar-whatsapp) pasó a exigir
-- es_admin=true además de sesión activa: solo la administradora envía.

-- ============================================================
-- Receso de verano (julio/agosto) y reestructuración de fin de curso
-- ============================================================

-- No se generan recibos automáticos en julio ni agosto: la facturación normal
-- termina en junio; julio es intensivo con pocos alumnos (recibo manual) y
-- agosto es descanso. Guarda de seguridad dentro de la función además de
-- reprogramar el cron, por si algún día se llama a mano fuera de esos meses.
create or replace function public.generar_recibos_mensuales()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_periodo text := to_char(now(), 'YYYY-MM');
  v_mes text := (array['Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'])[extract(month from now())::int];
  v_admin uuid;
  v_creados integer := 0;
  fila record;
  v_desc record;
begin
  if extract(month from now())::int in (7, 8) then
    return 0;
  end if;

  select id into v_admin from public.profesores
  where es_admin and estado = 'activo' order by created_at limit 1;
  if v_admin is null then
    raise exception 'No hay administrador activo';
  end if;

  for fila in
    select a.id as alumno_id
    from public.alumnos a
    where a.estado = 'activo'
      and exists (select 1 from public.matriculas m where m.alumno_id = a.id and m.tipo_tarifa = 'mes' and m.tarifa is not null)
  loop
    select * into v_desc from public.calcular_descuentos_alumno(fila.alumno_id);
    if v_desc.total is null or v_desc.total <= 0 then continue; end if;

    begin
      insert into public.recibos (alumno_id, profesor_id, fecha_emision, concepto,
        importe, importe_letras, estado, periodos)
      values (fila.alumno_id, v_admin, current_date, v_mes,
        v_desc.total, '', 'pendiente', array[v_periodo]);
      v_creados := v_creados + 1;
    exception when others then
      -- ya tenía recibo de este mes (u otro problema puntual): se salta
      null;
    end;
  end loop;
  return v_creados;
end;
$$;

-- unschedule + schedule (no alter_job): así no depende de que exista ya un
-- jobid con ese nombre, que dejaría el resto de la migración a medias si el
-- job no existiera todavía en un proyecto nuevo.
select cron.unschedule('recibos-mensuales');
select cron.schedule('recibos-mensuales', '0 6 3 1-6,9-12 *', 'select public.generar_recibos_mensuales()');

-- Reestructuración de fin de curso: solo la administradora puede ejecutarlo.
-- Da de baja a todos los alumnos activos de la academia (los profesores
-- pasan a ver 0 alumnos) y borra todas las clases (con sus horarios,
-- inscripciones y excepciones, en cascada) para que cada profesor monte su
-- horario nuevo desde cero en septiembre.
create or replace function public.reestructurar_academia()
returns json
language plpgsql
security definer set search_path = public
as $$
declare
  v_alumnos integer;
  v_clases integer;
begin
  if not public.is_admin() then
    raise exception 'Solo la administradora puede reestructurar la academia';
  end if;

  select count(*) into v_alumnos from public.alumnos where estado = 'activo';
  select count(*) into v_clases from public.clases;

  update public.alumnos set estado = 'baja' where estado = 'activo';
  delete from public.clases;

  return json_build_object('alumnos_dados_de_baja', v_alumnos, 'clases_borradas', v_clases);
end;
$$;

grant execute on function public.reestructurar_academia() to authenticated;
revoke execute on function public.reestructurar_academia() from public, anon;

-- ============================================================
-- Aviso al admin cuando un profesor reactiva un alumno
-- ============================================================
create table public.reactivaciones_alumno (
  id uuid primary key default gen_random_uuid(),
  alumno_id uuid not null references public.alumnos (id) on delete cascade,
  profesor_id uuid not null references public.profesores (id),
  fecha timestamptz not null default now(),
  visto boolean not null default false
);

create index reactivaciones_alumno_alumno_idx on public.reactivaciones_alumno (alumno_id);
create index reactivaciones_alumno_visto_idx on public.reactivaciones_alumno (visto) where not visto;

alter table public.reactivaciones_alumno enable row level security;

create policy "reactivaciones_alumno_select" on public.reactivaciones_alumno
  for select to authenticated using (true);
create policy "reactivaciones_alumno_insert" on public.reactivaciones_alumno
  for insert to authenticated with check (profesor_id = auth.uid() or public.is_admin());
create policy "reactivaciones_alumno_update" on public.reactivaciones_alumno
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
