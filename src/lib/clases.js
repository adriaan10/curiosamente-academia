// Alumnos que solo van ALGUNOS de los días de una clase (ej. la clase se da lunes
// y miércoles y este alumno solo va el lunes). En la base de datos es
// clase_alumnos.dias_semana: null = todos los días de la clase (lo de siempre).
// Días como en el resto de la app: 1 = lunes … 7 = domingo. Con tests en
// test/test-clases.mjs.

// ¿Este apuntado (fila de clase_alumnos) va ese día de la semana? Sin día
// concreto (ej. una clase alternativa suelta), se cuenta como que sí.
export function asisteEnDia(ca, dia) {
  if (dia == null) return true;
  const dias = ca?.dias_semana;
  return !dias || !dias.length || dias.includes(Number(dia));
}

// Apuntados que van de verdad a la sesión de ese día de la semana.
export function apuntadosEnDia(clase, dia) {
  return (clase?.clase_alumnos || []).filter(ca => asisteEnDia(ca, dia));
}

// Días distintos en los que se da la clase, ordenados (lunes primero).
export function diasDeClase(horarios) {
  return [...new Set((horarios || []).map(h => Number(h.dia_semana)))].sort((a, b) => a - b);
}

// Lo que se guarda para un alumno a partir de los días que se le han dejado
// marcados: null si va a todos (o si no queda ninguno de los días actuales de
// la clase — por ejemplo porque se cambiaron los días de la clase), y si no,
// la lista ordenada. Así nada se queda "a medias" ni vacío.
export function normalizarDias(seleccion, diasClase) {
  if (!seleccion) return null;
  const validos = diasClase.filter(d => seleccion.has(d));
  if (!validos.length || validos.length === diasClase.length) return null;
  return validos;
}

// "solo lunes", "solo lunes y miércoles" — para etiquetar a los que no van todos los días.
export function textoSoloDias(dias, nombres) {
  const l = (dias || []).map(d => nombres[d - 1]).filter(Boolean);
  if (!l.length) return '';
  return 'solo ' + (l.length === 1 ? l[0] : `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}`);
}

// Resultado de tocar un día de un alumno en la ficha de la clase: si iba a ese
// día pasa a NO ir (y al revés). Devuelve { dias } (lo que hay que guardar:
// null = todos los días) o { error: 'minimo' } si con ello no iría a ninguno.
export function alternarDia(diasActuales, diasClase, dia) {
  const base = (diasActuales || []).filter(d => diasClase.includes(d));
  const sel = new Set(base.length ? base : diasClase);
  if (sel.has(dia)) {
    if (sel.size <= 1) return { error: 'minimo' };
    sel.delete(dia);
  } else {
    sel.add(dia);
  }
  return { dias: normalizarDias(sel, diasClase) };
}
