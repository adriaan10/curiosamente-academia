// Utilidades compartidas del renderer.

export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// "Abril+mayo+junio" — el primer mes con mayúscula, el resto en minúscula,
// tal y como aparece en la plantilla de la academia.
export function conceptoDesdeMeses(meses) {
  return meses
    .map((m, i) => (i === 0 ? m : m.toLowerCase()))
    .join('+');
}

export function hoyDDMMAAAA() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Normaliza un teléfono español para wa.me: quita separadores y añade 34.
export function telefonoWa(telefono) {
  let t = String(telefono || '').replace(/[^\d+]/g, '');
  if (t.startsWith('+')) t = t.slice(1);
  if (t.length === 9 && /^[679]/.test(t)) t = '34' + t;
  return t;
}

export function linkWhatsApp(telefono, mensaje) {
  const t = telefonoWa(telefono);
  if (!t) return null;
  return `https://wa.me/${t}?text=${encodeURIComponent(mensaje)}`;
}

// Formatea importe: sin decimales si es entero (como "210€" en la plantilla).
export function formatoImporte(n) {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',');
}

export function aCsv(filas, columnas) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lineas = [columnas.map(c => esc(c.titulo)).join(';')];
  for (const f of filas) lineas.push(columnas.map(c => esc(c.valor(f))).join(';'));
  return lineas.join('\r\n');
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
