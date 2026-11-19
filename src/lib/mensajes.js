// Pestaña "Mensajes": utilidades puras (sin DOM ni Supabase) para preparar los
// envíos de mensajes sueltos por WhatsApp. Con tests en test/test-mensajes.mjs.
import { telefonoWa } from './util.js';

// Primer nombre de una persona ("María Pérez" -> "María"); sin nombre, "familia"
// (queda bien en "¡Hola familia!").
export function primerNombre(nombre, respaldo = 'familia') {
  const p = String(nombre || '').trim().split(/\s+/)[0];
  return p || respaldo;
}

// Un dato de plantilla no puede llevar saltos de línea, tabuladores ni más de 4
// espacios seguidos, ni ir vacío (Meta rechaza el mensaje). Misma regla que
// aplica el servidor (supabase/functions/enviar-mensaje).
export function limpiarVariable(v) {
  const t = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  return t || '-';
}

// Texto del mensaje con sus datos puestos: "Hola {{1}}" + ["Ana"] -> "Hola Ana".
export function rellenarPlantilla(cuerpo, variables = []) {
  return String(cuerpo || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = variables[Number(n) - 1];
    return v == null ? `{{${n}}}` : limpiarVariable(v);
  });
}

// Lee los números que se escriben o pegan a mano: uno por línea (o separados
// por coma o punto y coma), con el nombre detrás si se quiere
// ("612 34 56 78 María"). Devuelve cada uno con su teléfono ya normalizado y
// si es válido; los repetidos se quitan.
export function parsearDestinatarios(texto) {
  const vistos = new Set();
  const salida = [];
  for (const trozo of String(texto || '').split(/[\n;,]+/)) {
    const linea = trozo.trim();
    if (!linea) continue;
    const m = /^(\+?[\d][\d\s().-]*)(.*)$/.exec(linea);
    const bruto = m ? m[1].trim() : linea;
    const nombre = m ? m[2].trim() : '';
    const telefono = telefonoWa(bruto);
    const clave = telefono || `invalido:${linea}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ original: linea, telefono, nombre, valido: Boolean(telefono) });
  }
  return salida;
}

// Junta destinatarios por teléfono: dos hermanos con el mismo número de la
// madre reciben UN solo mensaje. `lista`: [{ telefono, ... }] — se queda con el
// primero de cada número.
export function sinTelefonosRepetidos(lista) {
  const vistos = new Set();
  return lista.filter(x => {
    if (!x.telefono || vistos.has(x.telefono)) return false;
    vistos.add(x.telefono);
    return true;
  });
}

// "Ana y Luis" / "Ana, Luis y Pau" para la lista de familias.
export function unirNombres(nombres) {
  const l = [...new Set(nombres.filter(Boolean))];
  if (l.length <= 1) return l[0] || '';
  if (l.length === 2) return `${l[0]} y ${l[1]}`;
  return `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}`;
}

// Familias a las que mandar un mensaje a partir de los alumnos activos: el
// número y el nombre salen igual que para los recibos (el teléfono del alumno
// o del tutor; con padres separados, el de la madre y el del padre). Los que
// comparten número se juntan en una sola familia. Devuelve { familias, sinTelefono }.
export function familiasDeAlumnos(alumnos) {
  const porTelefono = new Map();
  const sinTelefono = [];
  const anotar = (a, nombreContacto, tel) => {
    const telefono = telefonoWa(tel);
    if (!telefono) { sinTelefono.push(a.nombre); return; }
    if (!porTelefono.has(telefono)) porTelefono.set(telefono, { telefono, contacto: '', alumnos: [], alumnoIds: [] });
    const f = porTelefono.get(telefono);
    if (!f.contacto && nombreContacto) f.contacto = nombreContacto;
    f.alumnos.push(a.nombre);
    f.alumnoIds.push(a.id);
  };
  for (const a of alumnos) {
    if (a.estado !== 'activo') continue;
    if (a.padres_separados) {
      anotar(a, a.madre_nombre || a.tutor_nombre || '', a.madre_telefono);
      anotar(a, a.padre_nombre || a.tutor_nombre || '', a.padre_telefono);
    } else {
      anotar(a, a.facturacion_nombre || a.tutor_nombre || a.nombre, a.telefono || a.tutor_telefono);
    }
  }
  const familias = [...porTelefono.values()].map(f => ({
    ...f, nombre: primerNombre(f.contacto), etiqueta: unirNombres(f.alumnos)
  }));
  return { familias, sinTelefono };
}
