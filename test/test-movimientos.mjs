// Tests de la lógica de "Movimientos" (src/lib/movimientos.js).
import {
  construirEventos, colapsarRafagas, filtrarEventos, agruparPorDia, conteoSemana,
  resumenEventos, rangoMovimientos, lunesDe, sumarDias, diaLocal, horaLocal
} from '../src/lib/movimientos.js';

let fallos = 0;
function esperar(real, esperado, etiqueta) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  const ok = a === b;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK ' : 'FALLO'} ${etiqueta}${ok ? '' : `: ${a} (esperado ${b})`}`);
}

// Fechas en hora local, como las pinta la app.
const ts = (dia, h = 10, m = 0, s = 0) => {
  const [y, mes, d] = dia.split('-').map(Number);
  return new Date(y, mes - 1, d, h, m, s).toISOString();
};

// ---- días y semanas ----
esperar(lunesDe('2026-11-19'), '2026-11-16', 'jueves 19/11 -> lunes 16/11');
esperar(lunesDe('2026-11-16'), '2026-11-16', 'el lunes es su propio lunes');
esperar(lunesDe('2026-11-22'), '2026-11-16', 'el domingo cae en la semana que empezó el lunes anterior');
esperar(sumarDias('2026-11-30', 1), '2026-12-01', 'sumar un día cruza de mes');
esperar(sumarDias('2026-01-01', -1), '2025-12-31', 'restar un día cruza de año');
esperar(rangoMovimientos('dia', '2026-11-19'), { desde: '2026-11-19', hasta: '2026-11-19' }, 'rango de un día');
esperar(rangoMovimientos('semana', '2026-11-19'), { desde: '2026-11-16', hasta: '2026-11-22' }, 'rango de una semana');
esperar(diaLocal(ts('2026-11-19', 23, 59)), '2026-11-19', 'a las 23:59 sigue siendo ese día (hora local)');
esperar(horaLocal(ts('2026-11-19', 9, 5)), '09:05', 'hora con cero a la izquierda');

// ---- datos de ejemplo ----
const ANA = 'prof-ana', LUIS = 'prof-luis', JUDITH = 'prof-judith';
const datos = {
  alumnos: [
    { id: 'a1', nombre: 'Ana Ruiz', creado_por: ANA, created_at: ts('2026-11-19', 9, 0), matriculas: [] },
    { id: 'a2', nombre: 'Luis Ruiz', creado_por: null, created_at: ts('2026-09-08'), matriculas: [
      { actualizado_por: LUIS, actualizado_en: ts('2026-11-19', 11), tarifa: 65, asignaturas: { nombre: 'Inglés' } }
    ] }
  ],
  recibos: [
    // cobro normal de 65€ el 19/11
    { id: 'r1', referencia: 469, alumno_id: 'a1', concepto: 'Octubre', importe: 65, estado: 'pagado',
      cobrado_por: ANA, fecha_pago: ts('2026-11-19', 10, 30), cobro_rapido: false, cuenta: 'banco',
      profesor_id: JUDITH, created_at: ts('2026-11-18', 19, 35), importe_letras: 'Sesenta y cinco' },
    // cobro de 65€ en el que ya había 20€ pagados antes: solo entran 45€ ahora
    { id: 'r2', referencia: 470, alumno_id: 'a2', concepto: 'Noviembre', importe: 65, estado: 'pagado',
      cobrado_por: LUIS, fecha_pago: ts('2026-11-19', 12, 0), cobro_rapido: true, cuenta: 'efectivo',
      profesor_id: JUDITH, created_at: ts('2026-11-18', 19, 36), importe_letras: 'Sesenta y cinco' },
    // generado por el sistema (sin importe en letras): no es de nadie
    { id: 'r3', referencia: 471, alumno_id: 'a1', concepto: 'Noviembre', importe: 65, estado: 'pendiente',
      cobrado_por: null, profesor_id: JUDITH, created_at: ts('2026-11-01', 8), importe_letras: '' },
    // justificante enviado por WhatsApp
    { id: 'r4', referencia: 472, alumno_id: 'a1', concepto: 'Septiembre', importe: 50, estado: 'pagado',
      cobrado_por: null, envio_pago_por: JUDITH, fecha_envio_whatsapp_pago: ts('2026-11-19', 13), justificante_papel: false,
      profesor_id: JUDITH, created_at: ts('2026-09-30'), importe_letras: 'Cincuenta' }
  ],
  reciboPagos: [
    { id: 'p1', recibo_id: 'r2', importe: 20, creado_por: LUIS, created_at: ts('2026-11-17', 17) },       // plazo anterior
    { id: 'p2', recibo_id: 'r2', importe: 45, creado_por: LUIS, created_at: ts('2026-11-19', 11, 59, 58) }, // el que cierra el cobro
    { id: 'p3', recibo_id: 'r4', importe: 10, creado_por: ANA, created_at: ts('2026-11-19', 15) }          // pago parcial suelto
  ],
  faltas: [
    { id: 'f1', alumno_id: 'a1', clase_id: 'c1', profesor_id: ANA, creado_por: ANA, fecha: '2026-11-18', created_at: ts('2026-11-19', 9, 30) },
    { id: 'f2', alumno_id: 'a2', clase_id: 'c1', profesor_id: ANA, creado_por: null, fecha: '2026-11-19', created_at: ts('2026-11-19', 16) }
  ],
  clases: [{ id: 'c1', profesor_id: ANA, nombre: 'Lunes 17:00', created_at: ts('2026-11-16', 8) }],
  cambiosHorario: [{ alumno_id: 'a1', profesor_id: LUIS, fecha: ts('2026-11-19', 14), horas_antes: 2, horas_despues: 3 }],
  reactivaciones: [{ alumno_id: 'a2', profesor_id: ANA, fecha: ts('2026-11-19', 8) }],
  bajasAsignatura: [{ alumno_id: 'a2', profesor_id: ANA, fecha: ts('2026-11-19', 8, 5), asignaturas: { nombre: 'Francés' } }],
  profesorHorarioCambios: [
    { profesor_id: ANA, cambiado_por: ANA, fecha: ts('2026-11-19', 7), resumen_antes: 'L 9-14', resumen_despues: 'L 9-15' },
    { profesor_id: LUIS, cambiado_por: JUDITH, fecha: ts('2026-11-19', 7, 5), resumen_antes: 'M 9-14', resumen_despues: 'M 9-13' }
  ],
  recibosCorrecciones: [{ corregido_por: JUDITH, fecha: ts('2026-11-19', 17), alumno_id: 'a1', recibos: { referencia: 469 }, importe_antes: 65, importe_despues: 60 }],
  finanzas: [
    { origen: 'manual', tipo: 'gasto', categoria: 'Material', descripcion: 'Folios', importe: 12.5, creado_por: JUDITH, created_at: ts('2026-11-19', 18) },
    { origen: 'automatico', tipo: 'ingreso', categoria: 'Mensualidad', importe: 65, creado_por: null, created_at: ts('2026-11-19', 10, 30) }
  ],
  actividad: [
    { profesor_id: LUIS, tipo: 'baja_alumno', alumno_id: 'a2', detalle: 'Luis Ruiz', fecha: ts('2026-11-19', 19) },
    { profesor_id: JUDITH, tipo: 'mensaje', alumno_id: null, detalle: 'Felicitación de Navidad · 40 enviados', fecha: ts('2026-11-19', 19, 2) },
    { profesor_id: LUIS, tipo: 'inventado', alumno_id: null, detalle: '', fecha: ts('2026-11-19', 19, 1) }
  ]
};
const h = {
  alumnoNombre: (id) => ({ a1: 'Ana Ruiz', a2: 'Luis Ruiz' }[id]),
  claseNombre: (id) => ({ c1: 'Lunes 17:00' }[id]),
  asignaturasDeClase: () => 'Inglés',
  profesorNombre: (id) => ({ [ANA]: 'Ana', [LUIS]: 'Luis', [JUDITH]: 'Judith' }[id])
};
const todos = construirEventos(datos, h);
const de = (prof, tipo) => todos.filter(x => x.prof === prof && x.tipo === tipo);

// ---- cobros ----
esperar(de(ANA, 'cobro').length, 1, 'Ana tiene su cobro');
esperar(de(ANA, 'cobro')[0].importe, 65, 'cobro de 65€ entero');
esperar(de(ANA, 'cobro')[0].detalle, 'R-00469 · Octubre · banco', 'detalle del cobro con referencia, concepto y cuenta');
esperar(de(LUIS, 'cobro_rapido').length, 1, 'cobro rápido se distingue');
esperar(de(LUIS, 'cobro_rapido')[0].importe, 45, 'si ya había 20€ pagados, el cobro final cuenta solo los 45€ que faltaban');
esperar(de(LUIS, 'pago_parcial').map(x => x.importe), [20], 'el plazo anterior de 20€ sale como pago parcial y el que cierra el cobro NO se duplica');
esperar(de(ANA, 'pago_parcial').map(x => x.importe), [10], 'un pago parcial suelto sí sale');

// ---- recibos ----
esperar(de(JUDITH, 'recibo_generado').length, 3, 'los recibos que generó Judith (los del sistema, sin importe en letras, no cuentan)');
esperar(de(JUDITH, 'justificante').length, 1, 'justificante enviado queda a nombre de quien lo envió');
esperar(de(JUDITH, 'recibo_corregido')[0].detalle, 'R-00469 · 65€ → 60€', 'recibo corregido con antes y después');

// ---- alumnos, faltas, clases ----
esperar(de(ANA, 'alta').length, 1, 'alta de alumno a nombre de quien la hizo');
esperar(todos.filter(x => x.tipo === 'alta').length, 1, 'un alumno sin creado_por no genera alta');
esperar(de(LUIS, 'precio').length, 1, 'precio completado en la ficha');
esperar(de(ANA, 'reactivacion').length, 1, 'reactivación');
esperar(de(ANA, 'baja_asignatura')[0].detalle, 'Francés', 'baja de asignatura con su asignatura');
esperar(de(LUIS, 'horas')[0].detalle, '2 → 3 h/sem', 'horas modificadas');
esperar(de(ANA, 'falta').length, 2, 'faltas: la de creado_por y la que usa el profesor de la clase');
esperar(de(ANA, 'falta')[0].detalle.includes('falta del 18/11') || de(ANA, 'falta')[1].detalle.includes('falta del 18/11'), true, 'falta marcada otro día dice de qué día era');
esperar(de(ANA, 'clase')[0].detalle, 'Lunes 17:00 · Inglés', 'clase creada');
esperar(de(ANA, 'horario_trabajo').length, 1, 'horario de trabajo propio');
esperar(de(JUDITH, 'horario_trabajo')[0].detalle, 'Horario de Luis: antes M 9-14 → ahora M 9-13', 'si lo cambia otra persona, queda a su nombre y dice de quién es el horario');

// ---- finanzas y actividad ----
esperar(de(JUDITH, 'gasto').length, 1, 'gasto manual');
esperar(de(JUDITH, 'gasto')[0].dinero, 'sale', 'un gasto es dinero que sale');
esperar(todos.some(x => x.tipo === 'ingreso'), false, 'los ingresos automáticos de recibos no se cuentan aparte');
esperar(de(LUIS, 'baja_alumno').length, 1, 'baja de alumno sale del registro de actividad');
esperar(de(JUDITH, 'mensaje')[0].cat, 'mensajes', 'un envío de mensajes cuenta en su propia categoría');
esperar(todos.some(x => x.tipo === 'inventado'), false, 'un tipo desconocido se ignora sin romper nada');

// ---- filtros, días y resúmenes ----
const hoyEv = filtrarEventos(todos, { desde: '2026-11-19', hasta: '2026-11-19', profs: new Set([ANA]) });
esperar(hoyEv.every(x => x.prof === ANA), true, 'filtrar por profesor');
esperar(filtrarEventos(todos, { desde: '2026-11-19', hasta: '2026-11-19', profs: new Set([ANA]), cat: 'faltas' }).length, 2, 'filtrar por categoría');
esperar(filtrarEventos(todos, { desde: '2026-11-18', hasta: '2026-11-18' }).filter(x => x.prof === JUDITH).length, 2, 'filtrar por día (los 2 recibos que generó el 18)');
const resumenAna = resumenEventos(filtrarEventos(todos, { desde: '2026-11-19', hasta: '2026-11-19', profs: new Set([ANA]) }));
esperar(resumenAna.cobrado, 75, 'dinero cobrado por Ana ese día: cobro 65 + pago parcial 10');
esperar(resumenAna.porCat.faltas, 2, 'resumen cuenta por categoría');
const grupos = agruparPorDia(filtrarEventos(todos, { desde: '2026-11-16', hasta: '2026-11-22', profs: new Set([ANA]) }));
esperar(grupos[0].dia, '2026-11-19', 'el día más reciente va primero');
esperar(grupos.at(-1).dia, '2026-11-16', 'y el más antiguo el último');
const orden = grupos[0].eventos.map(x => Date.parse(x.ts));
esperar(orden.every((t, i) => i === 0 || orden[i - 1] >= t), true, 'dentro del día, lo último primero');
const semana = conteoSemana(filtrarEventos(todos, { profs: new Set([ANA]) }), '2026-11-19');
esperar(semana.length, 7, 'la semana tiene 7 días');
esperar(semana[0].dia, '2026-11-16', 'empieza en lunes');
esperar(semana[0].n, 1, 'el lunes Ana creó una clase');
esperar(semana[3].n > 5, true, 'el jueves concentra casi toda su actividad');

// ---- ráfagas ----
const rafaga = (n, sep = 20) => Array.from({ length: n }, (_, i) => ({
  tipo: 'recibo_generado', cat: 'recibos', prof: JUDITH, ts: ts('2026-11-19', 9, 0, i * sep),
  alumno: `Alumno ${i + 1}`, importe: 50, detalle: 'x'
}));
const col = colapsarRafagas(rafaga(10));
esperar(col.length, 1, '10 recibos seguidos se juntan en una fila');
esperar(col[0].n, 10, 'la fila dice cuántos son');
esperar(col[0].importe, 500, 'y suma el importe');
esperar(col[0].detalle, 'Alumno 1, Alumno 2, Alumno 3 y 7 más', 'con los primeros nombres');
esperar(colapsarRafagas(rafaga(3)).length, 3, '3 seguidos no se juntan');
esperar(colapsarRafagas(rafaga(6, 300)).length, 6, 'con más de 3 minutos entre uno y otro, tampoco');
esperar(resumenEventos(col).total, 10, 'el resumen cuenta los 10 de la ráfaga, no 1');
esperar(conteoSemana(col, '2026-11-19')[3].n, 10, 'y la barra del día también');

console.log(fallos ? `\n${fallos} test(s) fallan.` : '\nTodos los tests de movimientos pasan.');
process.exit(fallos ? 1 : 0);
