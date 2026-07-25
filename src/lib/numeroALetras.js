// Convierte un importe numérico a letras en español, replicando el formato
// de la plantilla de recibo de Curiosamente (ej. 210 -> "Doscientos diez").

const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const ESPECIALES = {
  10: 'diez', 11: 'once', 12: 'doce', 13: 'trece', 14: 'catorce', 15: 'quince',
  16: 'dieciséis', 17: 'diecisiete', 18: 'dieciocho', 19: 'diecinueve',
  20: 'veinte', 21: 'veintiuno', 22: 'veintidós', 23: 'veintitrés', 24: 'veinticuatro',
  25: 'veinticinco', 26: 'veintiséis', 27: 'veintisiete', 28: 'veintiocho', 29: 'veintinueve'
};
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function menorQueMil(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  let out = '';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) out = CENTENAS[c];
  if (resto > 0) {
    if (out) out += ' ';
    if (resto < 30) out += ESPECIALES[resto] || UNIDADES[resto];
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      out += DECENAS[d] + (u > 0 ? ' y ' + UNIDADES[u] : '');
    }
  }
  return out;
}

function enteroALetras(n) {
  if (n === 0) return 'cero';
  let out = '';
  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const resto = n % 1000;
  if (millones > 0) {
    out += millones === 1 ? 'un millón' : enteroALetras(millones) + ' millones';
  }
  if (miles > 0) {
    if (out) out += ' ';
    out += miles === 1 ? 'mil'
      : menorQueMil(miles).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + ' mil';
  }
  if (resto > 0) {
    if (out) out += ' ';
    out += menorQueMil(resto);
  }
  return out;
}

// Devuelve el importe en letras con la primera letra en mayúscula.
// 210 -> "Doscientos diez"; 210.5 -> "Doscientos diez con cincuenta céntimos"
export function importeALetras(importe) {
  const n = Math.round(Number(importe) * 100) / 100;
  const entero = Math.floor(n);
  const centimos = Math.round((n - entero) * 100);
  let texto = enteroALetras(entero);
  if (centimos > 0) {
    texto += ' con ' + enteroALetras(centimos) + ' céntimo' + (centimos === 1 ? '' : 's');
  }
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}
