// Movimientos de los profesores: junta en UNA sola lista de "eventos" lo que
// cada uno hace en la app. Sale de dos sitios:
//   · las tablas donde esa acción ya queda guardada (cobros, altas, faltas,
//     horas modificadas…), con su autor y su hora;
//   · el registro `actividad`, para lo que no tenía sitio propio (bajas de
//     alumno, recibos eliminados o vueltos a pendiente, envíos, fichas…).
// Aquí no hay DOM ni Supabase: así se puede probar con `npm test`.
import { formatoImporte } from './util.js';

// Seis familias de color (los chips de resumen y el color de cada fila) y,
// dentro de cada una, los tipos concretos con su icono y su título.
export const CATEGORIAS = {
  cobros:   { icono: '💰', color: '#E07B12', etiqueta: 'Cobros' },
  recibos:  { icono: '🧾', color: '#C8506A', etiqueta: 'Recibos' },
  alumnos:  { icono: '🎒', color: '#1E8E4E', etiqueta: 'Alumnos' },
  faltas:   { icono: '⚠️', color: '#C0392B', etiqueta: 'Faltas' },
  clases:   { icono: '📚', color: '#8E5BBF', etiqueta: 'Clases y horarios' },
  finanzas: { icono: '🏦', color: '#1A6DC4', etiqueta: 'Ingresos y gastos' },
  mensajes: { icono: '💬', color: '#0F9D8A', etiqueta: 'Mensajes' }
};

export const TIPOS = {
  cobro:              { cat: 'cobros',   icono: '💰', titulo: 'Cobro' },
  cobro_rapido:       { cat: 'cobros',   icono: '⚡', titulo: 'Cobro rápido' },
  pago_parcial:       { cat: 'cobros',   icono: '💵', titulo: 'Pago parcial' },
  recibo_generado:    { cat: 'recibos',  icono: '🧾', titulo: 'Recibo generado' },
  recibo_enviado:     { cat: 'recibos',  icono: '📨', titulo: 'Recibo enviado' },
  justificante:       { cat: 'recibos',  icono: '📤', titulo: 'Justificante enviado' },
  justificante_papel: { cat: 'recibos',  icono: '🖨️', titulo: 'Justificante en papel' },
  recibo_corregido:   { cat: 'recibos',  icono: '✏️', titulo: 'Recibo corregido' },
  recibo_pendiente:   { cat: 'recibos',  icono: '↩️', titulo: 'Recibo vuelto a pendiente' },
  recibo_eliminado:   { cat: 'recibos',  icono: '🗑️', titulo: 'Recibo eliminado' },
  alta:               { cat: 'alumnos',  icono: '✨', titulo: 'Alta de alumno' },
  baja_alumno:        { cat: 'alumnos',  icono: '🚪', titulo: 'Baja de alumno' },
  baja_asignatura:    { cat: 'alumnos',  icono: '🚪', titulo: 'Baja de asignatura' },
  reactivacion:       { cat: 'alumnos',  icono: '🔄', titulo: 'Alumno reactivado' },
  ficha_editada:      { cat: 'alumnos',  icono: '📝', titulo: 'Ficha editada' },
  documento:          { cat: 'alumnos',  icono: '📄', titulo: 'Documento' },
  horas:              { cat: 'alumnos',  icono: '⏱️', titulo: 'Horas modificadas' },
  precio:             { cat: 'alumnos',  icono: '🏷️', titulo: 'Precio completado' },
  falta:              { cat: 'faltas',   icono: '⚠️', titulo: 'Falta marcada' },
  clase:              { cat: 'clases',   icono: '📚', titulo: 'Clase creada' },
  horario_trabajo:    { cat: 'clases',   icono: '🕐', titulo: 'Horario de trabajo' },
  ingreso:            { cat: 'finanzas', icono: '📈', titulo: 'Ingreso' },
  gasto:              { cat: 'finanzas', icono: '📉', titulo: 'Gasto' },
  mensaje:            { cat: 'mensajes', icono: '💬', titulo: 'Mensajes por WhatsApp' }
};

// ------------------------------------------------------------------ fechas
// Todo en hora LOCAL (la del ordenador): un cobro a las 00:30 es de ese día,
// no del anterior como saldría cortando el texto UTC.
const p2 = (n) => String(n).padStart(2, '0');

export function isoLocal(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export function diaLocal(ts) {
  const d = new Date(ts);
  return isNaN(d) ? '' : isoLocal(d);
}
export function horaLocal(ts) {
  const d = new Date(ts);
  return isNaN(d) ? '' : `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function fechaDeIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function sumarDias(iso, n) {
  const d = fechaDeIso(iso);
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}
// Lunes de la semana a la que pertenece ese día (la semana va de lunes a domingo).
export function lunesDe(iso) {
  return sumarDias(iso, -((fechaDeIso(iso).getDay() + 6) % 7));
}
// Rango (inclusive) que enseña el panel: un día, o la semana entera del ancla.
export function rangoMovimientos(modo, ancla) {
  if (modo === 'dia') return { desde: ancla, hasta: ancla };
  const lunes = lunesDe(ancla);
  return { desde: lunes, hasta: sumarDias(lunes, 6) };
}

// -------------------------------------------------------- construir eventos
// d = datos ya cargados en la app; h = ayudas para poner nombres:
//   alumnoNombre(id), claseNombre(id), asignaturasDeClase(clase), profesorNombre(id)
export function construirEventos(d, h = {}) {
  const ev = [];
  const nombreAlumno = (id, respaldo) => (id && h.alumnoNombre ? h.alumnoNombre(id) : '') || respaldo || '';
  const ref = (r) => 'R-' + String(r?.referencia ?? '?').padStart(5, '0');
  const add = (tipo, prof, ts, extra = {}) => {
    if (!prof || !ts || !TIPOS[tipo]) return;
    ev.push({ tipo, cat: TIPOS[tipo].cat, prof, ts, ...extra });
  };

  // Pagos parciales agrupados por recibo (para no contar dos veces el último
  // plazo, que se anota a la vez que se da el recibo por cobrado).
  const pagosDe = new Map();
  for (const p of d.reciboPagos || []) {
    if (!pagosDe.has(p.recibo_id)) pagosDe.set(p.recibo_id, []);
    pagosDe.get(p.recibo_id).push(p);
  }
  const recibosPorId = new Map((d.recibos || []).map(r => [r.id, r]));
  const CERCA_MS = 60 * 1000;

  for (const r of d.recibos || []) {
    const alumno = nombreAlumno(r.alumno_id, r.alumno_nombre);
    const pagos = pagosDe.get(r.id) || [];
    if (r.cobrado_por && r.fecha_pago && r.estado === 'pagado') {
      const tCobro = Date.parse(r.fecha_pago);
      // Lo que entró DE VERDAD al darlo por cobrado: el total menos lo que ya
      // se había cobrado en plazos anteriores (esos tienen su propia fila).
      const yaCobrado = pagos
        .filter(p => Date.parse(p.created_at) < tCobro - CERCA_MS)
        .reduce((s, p) => s + Number(p.importe || 0), 0);
      add(r.cobro_rapido ? 'cobro_rapido' : 'cobro', r.cobrado_por, r.fecha_pago, {
        alumno, dinero: 'entra', importe: Math.max(0, Number(r.importe || 0) - yaCobrado),
        detalle: [ref(r), r.concepto, r.cuenta].filter(Boolean).join(' · ')
      });
    }
    // Recibos que genera una persona (los que crea solo el sistema cada mes
    // no llevan importe en letras: no son de nadie).
    if (r.profesor_id && r.created_at && r.importe_letras) {
      add('recibo_generado', r.profesor_id, r.created_at, {
        alumno, importe: Number(r.importe), detalle: [ref(r), r.concepto].filter(Boolean).join(' · ')
      });
    }
    if (r.envio_pago_por && r.fecha_envio_whatsapp_pago) {
      add(r.justificante_papel ? 'justificante_papel' : 'justificante', r.envio_pago_por, r.fecha_envio_whatsapp_pago, {
        alumno, detalle: [ref(r), r.concepto].filter(Boolean).join(' · ')
      });
    }
  }

  for (const p of d.reciboPagos || []) {
    const r = recibosPorId.get(p.recibo_id);
    // El plazo que cierra el cobro ya cuenta dentro del "Cobro" del recibo.
    if (r && r.estado === 'pagado' && r.fecha_pago && r.cobrado_por === p.creado_por
      && Math.abs(Date.parse(p.created_at) - Date.parse(r.fecha_pago)) <= CERCA_MS) continue;
    add('pago_parcial', p.creado_por, p.created_at, {
      alumno: r ? nombreAlumno(r.alumno_id, r.alumno_nombre) : '', dinero: 'entra', importe: Number(p.importe),
      detalle: r ? [ref(r), r.concepto].filter(Boolean).join(' · ') : ''
    });
  }

  for (const c of d.recibosCorrecciones || []) {
    const precio = c.tarifa_despues != null
      ? ` (precio de la ficha ${formatoImporte(c.tarifa_antes)}€ → ${formatoImporte(c.tarifa_despues)}€/mes)` : '';
    add('recibo_corregido', c.corregido_por, c.fecha, {
      alumno: nombreAlumno(c.alumno_id),
      detalle: `${ref(c.recibos)} · ${formatoImporte(c.importe_antes)}€ → ${formatoImporte(c.importe_despues)}€${precio}`
    });
  }

  for (const a of d.alumnos || []) {
    add('alta', a.creado_por, a.created_at, { alumno: a.nombre });
    for (const m of a.matriculas || []) {
      if (m.actualizado_por && m.actualizado_en) {
        add('precio', m.actualizado_por, m.actualizado_en, {
          alumno: a.nombre,
          detalle: [m.asignaturas?.nombre, m.tarifa != null ? `${formatoImporte(m.tarifa)}€` : ''].filter(Boolean).join(' · ')
        });
      }
    }
  }

  for (const r of d.reactivaciones || []) {
    add('reactivacion', r.profesor_id, r.fecha, { alumno: nombreAlumno(r.alumno_id, r.alumnos?.nombre) });
  }
  for (const b of d.bajasAsignatura || []) {
    add('baja_asignatura', b.profesor_id, b.fecha, {
      alumno: nombreAlumno(b.alumno_id, b.alumnos?.nombre), detalle: b.asignaturas?.nombre || ''
    });
  }
  for (const c of d.cambiosHorario || []) {
    add('horas', c.profesor_id, c.fecha, {
      alumno: nombreAlumno(c.alumno_id, c.alumnos?.nombre),
      detalle: `${c.horas_antes ?? '?'} → ${c.horas_despues ?? '?'} h/sem`
    });
  }

  for (const f of d.faltas || []) {
    const ts = f.created_at || (f.fecha ? `${f.fecha}T12:00:00` : null);
    const otroDia = f.fecha && ts && diaLocal(ts) !== f.fecha;
    const clase = f.clase_id && h.claseNombre ? h.claseNombre(f.clase_id) : '';
    add('falta', f.creado_por || f.profesor_id, ts, {
      alumno: nombreAlumno(f.alumno_id),
      detalle: [clase, otroDia ? `falta del ${f.fecha.split('-').reverse().slice(0, 2).join('/')}` : ''].filter(Boolean).join(' · ')
    });
  }

  for (const c of d.clases || []) {
    const asig = h.asignaturasDeClase ? h.asignaturasDeClase(c) : '';
    add('clase', c.profesor_id, c.created_at, { detalle: [c.nombre, asig].filter(Boolean).join(' · ') });
  }
  for (const c of d.profesorHorarioCambios || []) {
    const deOtro = c.cambiado_por && c.profesor_id && c.cambiado_por !== c.profesor_id;
    const de = deOtro && h.profesorNombre ? `Horario de ${h.profesorNombre(c.profesor_id) || 'otro profesor'}: ` : '';
    add('horario_trabajo', c.cambiado_por || c.profesor_id, c.fecha, {
      detalle: `${de}antes ${c.resumen_antes || '—'} → ahora ${c.resumen_despues || '—'}`
    });
  }

  for (const f of d.finanzas || []) {
    if (f.origen !== 'manual') continue;
    add(f.tipo === 'gasto' ? 'gasto' : 'ingreso', f.creado_por, f.created_at, {
      dinero: f.tipo === 'gasto' ? 'sale' : 'entra', importe: Number(f.importe),
      detalle: [f.categoria, f.descripcion].filter(Boolean).join(' · ')
    });
  }

  // Lo que apunta la propia app en `actividad` (nombre del tipo = TIPOS[tipo]).
  for (const a of d.actividad || []) {
    add(a.tipo, a.profesor_id, a.fecha, {
      alumno: nombreAlumno(a.alumno_id), detalle: a.detalle || '',
      ...(a.importe != null ? { importe: Number(a.importe) } : {})
    });
  }

  return colapsarRafagas(ev);
}

// Cuando alguien hace lo mismo muchas veces seguidas (generar 30 recibos,
// mandar 25 justificantes de golpe) la lista se llenaría de filas idénticas:
// 4 o más del mismo tipo con menos de 3 minutos entre una y otra se juntan en
// una sola, con los primeros nombres y el total.
const COLAPSABLES = {
  recibo_generado: 'Recibos generados', justificante: 'Justificantes enviados',
  justificante_papel: 'Justificantes en papel', recibo_enviado: 'Recibos enviados',
  recibo_pendiente: 'Recibos vueltos a pendiente'
};
export function colapsarRafagas(eventos) {
  const orden = eventos.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const salida = [];
  const abiertos = new Map(); // "profesor|tipo" -> { items, ultimo }
  const cerrar = (clave) => {
    const g = abiertos.get(clave);
    abiertos.delete(clave);
    if (!g) return;
    if (g.items.length < 4) { salida.push(...g.items); return; }
    const primero = g.items[0];
    const nombres = g.items.map(x => x.alumno).filter(Boolean);
    const conImporte = g.items.filter(x => x.importe != null);
    salida.push({
      tipo: primero.tipo, cat: primero.cat, prof: primero.prof, ts: g.items[g.items.length - 1].ts,
      titulo: `${COLAPSABLES[primero.tipo]} (${g.items.length})`,
      alumno: '',
      detalle: nombres.slice(0, 3).join(', ') + (nombres.length > 3 ? ` y ${nombres.length - 3} más` : ''),
      ...(conImporte.length ? { importe: conImporte.reduce((s, x) => s + x.importe, 0) } : {}),
      n: g.items.length
    });
  };
  for (const x of orden) {
    if (!COLAPSABLES[x.tipo]) { salida.push(x); continue; }
    const clave = `${x.prof}|${x.tipo}`;
    const t = Date.parse(x.ts);
    const g = abiertos.get(clave);
    if (g && t - g.ultimo <= 3 * 60 * 1000) { g.items.push(x); g.ultimo = t; continue; }
    cerrar(clave);
    abiertos.set(clave, { items: [x], ultimo: t });
  }
  for (const clave of [...abiertos.keys()]) cerrar(clave);
  return salida;
}

// ----------------------------------------------------------------- consultas
// profs: Set de ids (o null = todos); cat: una categoría (o '' = todas).
export function filtrarEventos(eventos, { desde, hasta, profs = null, cat = '' } = {}) {
  return eventos.filter(x => {
    if (profs && !profs.has(x.prof)) return false;
    if (cat && x.cat !== cat) return false;
    const dia = diaLocal(x.ts);
    return (!desde || dia >= desde) && (!hasta || dia <= hasta);
  });
}

// Más reciente primero.
export function ordenarRecientes(eventos) {
  return eventos.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

// [{ dia, eventos }] del día más reciente al más antiguo.
export function agruparPorDia(eventos) {
  const grupos = new Map();
  for (const x of ordenarRecientes(eventos)) {
    const dia = diaLocal(x.ts);
    if (!grupos.has(dia)) grupos.set(dia, []);
    grupos.get(dia).push(x);
  }
  return [...grupos.entries()].map(([dia, lista]) => ({ dia, eventos: lista }));
}

// Cuántos movimientos hay en cada uno de los 7 días de la semana de `ancla`.
export function conteoSemana(eventos, ancla) {
  const lunes = lunesDe(ancla);
  const dias = Array.from({ length: 7 }, (_, i) => ({ dia: sumarDias(lunes, i), n: 0 }));
  const porDia = new Map(dias.map(x => [x.dia, x]));
  for (const x of eventos) {
    const fila = porDia.get(diaLocal(x.ts));
    if (fila) fila.n += (x.n || 1);
  }
  return dias;
}

// Cuenta (y suma el dinero cobrado) de un conjunto de eventos.
export function resumenEventos(eventos) {
  const porCat = {};
  for (const c of Object.keys(CATEGORIAS)) porCat[c] = 0;
  let cobrado = 0;
  let total = 0;
  for (const x of eventos) {
    const n = x.n || 1;
    porCat[x.cat] = (porCat[x.cat] || 0) + n;
    total += n;
    if (x.cat === 'cobros' && x.importe != null) cobrado += x.importe;
  }
  return { total, porCat, cobrado };
}
