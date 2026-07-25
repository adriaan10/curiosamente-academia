// Test rápido: conversión de importe a letras + generación de un recibo PDF de muestra.
import { importeALetras } from '../src/lib/numeroALetras.js';
import { generarReciboPdf, nombreArchivoRecibo } from '../src/lib/pdf.js';
import { conceptoDesdeMeses, telefonoWa, formatoImporte } from '../src/lib/util.js';
import fs from 'node:fs';

let fallos = 0;
function esperar(real, esperado, etiqueta) {
  const ok = real === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK ' : 'FALLO'} ${etiqueta}: "${real}"${ok ? '' : ` (esperado "${esperado}")`}`);
}

// ---- importe a letras (ejemplo de la plantilla: 210 -> "Doscientos diez") ----
esperar(importeALetras(210), 'Doscientos diez', '210');
esperar(importeALetras(0), 'Cero', '0');
esperar(importeALetras(1), 'Uno', '1');
esperar(importeALetras(15), 'Quince', '15');
esperar(importeALetras(21), 'Veintiuno', '21');
esperar(importeALetras(45), 'Cuarenta y cinco', '45');
esperar(importeALetras(100), 'Cien', '100');
esperar(importeALetras(101), 'Ciento uno', '101');
esperar(importeALetras(555), 'Quinientos cincuenta y cinco', '555');
esperar(importeALetras(1000), 'Mil', '1000');
esperar(importeALetras(1234), 'Mil doscientos treinta y cuatro', '1234');
esperar(importeALetras(21000), 'Veintiún mil', '21000');
esperar(importeALetras(85.5), 'Ochenta y cinco con cincuenta céntimos', '85.50');

// ---- concepto de meses (formato de la plantilla: "Abril+mayo+junio") ----
esperar(conceptoDesdeMeses(['Abril', 'Mayo', 'Junio']), 'Abril+mayo+junio', 'concepto 3 meses');
esperar(conceptoDesdeMeses(['Septiembre']), 'Septiembre', 'concepto 1 mes');

// ---- teléfono WhatsApp ----
esperar(telefonoWa('612 34 56 78'), '34612345678', 'tel español');
esperar(telefonoWa('+34 612345678'), '34612345678', 'tel con prefijo');

// ---- formato importe ----
esperar(formatoImporte(210), '210', 'importe entero');
esperar(formatoImporte(85.5), '85,50', 'importe con decimales');

// ---- nombre de archivo ----
esperar(nombreArchivoRecibo('María Pérez', 'Abril+mayo'), 'Recibo_Maria_Perez_Abril+mayo.pdf', 'nombre archivo');

// ---- PDF de muestra ----
const bytes = await generarReciboPdf({
  fechaEmision: '08/07/2026',
  recibiDe: 'María Pérez García',
  cantidadLetras: importeALetras(210),
  concepto: 'Abril+mayo+junio',
  totalCifra: '210',
  referencia: 'R-00001',
  logoPngBase64: null
});
fs.mkdirSync(new URL('./salida/', import.meta.url), { recursive: true });
const ruta = new URL('./salida/recibo_muestra.pdf', import.meta.url);
fs.writeFileSync(ruta, bytes);
console.log(`OK  PDF de muestra generado (${bytes.length} bytes): ${ruta.pathname}`);

if (fallos) {
  console.error(`\n${fallos} test(s) fallidos`);
  process.exit(1);
}
console.log('\nTodos los tests pasan.');
