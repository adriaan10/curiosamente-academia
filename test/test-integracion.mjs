// Test de integración contra el Supabase real: reproduce el flujo de la app
// con el modelo de ficha única + matrículas.
// Uso: CURIO_EMAIL=... CURIO_PASS=... node test/test-integracion.mjs
import { createClient } from '@supabase/supabase-js';
import { importeALetras } from '../src/lib/numeroALetras.js';

const URL = 'https://rwwszlyktvpszcdgwyyu.supabase.co';
const KEY = 'sb_publishable_1rEGTYk5JAM3JKTKaF7bxQ__DR2tngn';
const EMAIL = process.env.CURIO_EMAIL;
const PASS = process.env.CURIO_PASS;
if (!EMAIL || !PASS) {
  console.error('Faltan CURIO_EMAIL / CURIO_PASS');
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });
let fallos = 0;
const paso = (ok, etiqueta, extra = '') => {
  if (!ok) fallos++;
  console.log(`${ok ? 'OK ' : 'FALLO'} ${etiqueta}${extra ? ' — ' + extra : ''}`);
};

// 1. Login y datos base
const { data: auth, error: e1 } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASS });
paso(!e1, 'login', e1?.message);
if (e1) process.exit(1);
const uid = auth.user.id;

const { data: prof } = await sb.from('profesores').select('*').eq('id', uid).single();
paso(prof?.es_admin === true, 'ficha profesor admin', prof?.nombre);
const { data: asigs, error: e3 } = await sb.from('asignaturas').select('*').order('id');
paso(!e3 && asigs.length >= 7, 'asignaturas precargadas', e3?.message || `${asigs?.length} filas`);

// 2. Alta de alumno (ficha única, sin asignatura ni profesor)
const { data: alumno, error: e4 } = await sb.from('alumnos').insert({
  nombre: 'TEST Alumno Integración',
  telefono: '612345678',
  tutor_nombre: 'TEST Tutor',
  notas: 'fila creada por test de integración'
}).select('*').single();
paso(!e4, 'alta de alumno (ficha única)', e4?.message);

// 3. Anti-duplicados: mismo nombre (con mayúsculas/espacios distintos) rechazado
const { error: dup } = await sb.from('alumnos').insert({ nombre: '  test alumno  INTEGRACIÓN ' });
paso(Boolean(dup) && (dup.code === '23505' || /duplicate/.test(dup.message)),
  'nombre duplicado rechazado', dup ? 'rechazado correctamente' : 'NO se rechazó');

// 4. Matrículas: dos asignaturas en la misma ficha
const { error: m1 } = await sb.from('matriculas').insert([
  { alumno_id: alumno.id, asignatura_id: asigs[1].id, tarifa: 70, tipo_tarifa: 'mes', horas_semana: 2 },
  { alumno_id: alumno.id, asignatura_id: asigs[4].id, tarifa: 60, tipo_tarifa: 'mes' }
]);
paso(!m1, 'matrículas en dos asignaturas', m1?.message);
const { error: m2 } = await sb.from('matriculas').insert(
  { alumno_id: alumno.id, asignatura_id: asigs[1].id, tarifa: 70 });
paso(Boolean(m2), 'matrícula duplicada rechazada', m2 ? 'rechazada correctamente' : 'NO se rechazó');

// 5. Lectura con joins (misma query que cargarAlumnos)
const { data: lista, error: e5 } = await sb.from('alumnos')
  .select('*, matriculas(*, asignaturas(nombre))').order('nombre');
const enc = lista?.find(a => a.id === alumno.id);
paso(!e5 && enc?.matriculas?.length === 2, 'listado con matrículas', e5?.message || `${enc?.matriculas?.length} matrículas`);

// 6. Recibo (suma de tarifas 70+60 = 130/mes; 3 meses = 390... usamos 210 para letras conocidas)
const { data: recibo, error: e6 } = await sb.from('recibos').insert({
  alumno_id: alumno.id,
  profesor_id: uid,
  fecha_emision: '2026-07-17',
  concepto: 'Abril+mayo+junio',
  importe: 210,
  importe_letras: importeALetras(210),
  estado: 'pendiente'
}).select('*').single();
paso(!e6 && recibo.referencia >= 1 && recibo.importe_letras === 'Doscientos diez',
  'recibo pendiente con referencia', e6?.message);
const { error: e8 } = await sb.from('recibos')
  .update({ estado: 'pagado', fecha_pago: new Date().toISOString() }).eq('id', recibo.id);
paso(!e8, 'recibo marcado como pagado', e8?.message);

// 7. Notas
const { data: nota, error: n1 } = await sb.from('notas')
  .insert({ profesor_id: uid, texto: 'TEST posit', color: '#FFF59D' }).select('*').single();
const { error: n3 } = nota ? await sb.from('notas').delete().eq('id', nota.id) : { error: n1 };
paso(!n1 && !n3, 'nota creada y borrada', n1?.message || n3?.message);

// 8. RLS: no puedo crear una clase a nombre de un profesor inexistente
const { error: rls } = await sb.from('clases').insert({
  nombre: 'TEST intrusa', profesor_id: '00000000-0000-0000-0000-000000000001', asignatura_id: asigs[0].id
});
paso(Boolean(rls), 'RLS rechaza clase de profesor ajeno/inexistente', rls ? 'rechazada' : 'NO se rechazó');

// 9. Clases y conflicto de horario por identidad real (misma ficha)
const { data: claseA } = await sb.from('clases').insert({
  nombre: 'TEST Inglés martes', profesor_id: uid, asignatura_id: asigs[1].id
}).select('id').single();
await sb.from('clase_horarios').insert({ clase_id: claseA.id, dia_semana: 2, hora: '17:00', duracion_min: 60 });
const { error: apA } = await sb.from('clase_alumnos').insert({ clase_id: claseA.id, alumno_id: alumno.id });
paso(!apA, 'alumno apuntado a clase A (martes 17:00)', apA?.message);

const { data: claseB } = await sb.from('clases').insert({
  nombre: 'TEST Mates martes', profesor_id: uid, asignatura_id: asigs[4].id
}).select('id').single();
await sb.from('clase_horarios').insert({ clase_id: claseB.id, dia_semana: 2, hora: '17:30', duracion_min: 60 });
const { error: conflicto } = await sb.from('clase_alumnos').insert({ clase_id: claseB.id, alumno_id: alumno.id });
paso(Boolean(conflicto) && /Conflicto de horario/.test(conflicto?.message || ''),
  'conflicto de horario detectado', conflicto ? conflicto.message : 'NO se detectó');

const { data: claseC } = await sb.from('clases').insert({
  nombre: 'TEST Mates viernes', profesor_id: uid, asignatura_id: asigs[4].id
}).select('id').single();
await sb.from('clase_horarios').insert({ clase_id: claseC.id, dia_semana: 5, hora: '17:00', duracion_min: 60 });
const { error: sinConf } = await sb.from('clase_alumnos').insert({ clase_id: claseC.id, alumno_id: alumno.id });
paso(!sinConf, 'sin solape se apunta sin problema', sinConf?.message);

// 10. Excepciones: anulación y alternativa
const { error: x1 } = await sb.from('clase_excepciones').insert([
  { clase_id: claseA.id, fecha: '2026-07-21', tipo: 'anulada', motivo: 'fiesta' },
  { clase_id: claseA.id, fecha: '2026-07-22', tipo: 'extra', hora: '19:00', duracion_min: 60, nombre: 'TEST recuperación' }
]);
paso(!x1, 'anulación y alternativa creadas', x1?.message);

// 11. Baja total: estado baja + fuera de todas las clases
const { error: bj } = await sb.rpc('dar_baja_alumno', { p_alumno: alumno.id });
const { data: trasBaja } = await sb.from('alumnos').select('estado').eq('id', alumno.id).single();
const { data: enClases } = await sb.from('clase_alumnos').select('clase_id').eq('alumno_id', alumno.id);
paso(!bj && trasBaja?.estado === 'baja' && enClases?.length === 0,
  'baja total (estado baja y fuera de las clases)', bj?.message);

// 12. Limpieza
await sb.from('clases').delete().in('id', [claseA.id, claseB.id, claseC.id]);
const { error: lim } = await sb.from('alumnos').delete().eq('id', alumno.id);
const { data: matsQuedan } = await sb.from('matriculas').select('id').eq('alumno_id', alumno.id);
const { data: recQuedan } = await sb.from('recibos').select('id').eq('id', recibo.id);
paso(!lim && matsQuedan?.length === 0 && recQuedan?.length === 0, 'limpieza (borrado en cascada)', lim?.message);

await sb.auth.signOut();
console.log(fallos ? `\n${fallos} test(s) fallidos` : '\nIntegración completa: todos los tests pasan.');
process.exit(fallos ? 1 : 0);
