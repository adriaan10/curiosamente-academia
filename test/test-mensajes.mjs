// Tests de las utilidades de la pestaña "Mensajes" (src/lib/mensajes.js).
import {
  primerNombre, limpiarVariable, rellenarPlantilla, parsearDestinatarios,
  sinTelefonosRepetidos, unirNombres, familiasDeAlumnos
} from '../src/lib/mensajes.js';

let fallos = 0;
function esperar(real, esperado, etiqueta) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  const ok = a === b;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK ' : 'FALLO'} ${etiqueta}${ok ? '' : `: ${a} (esperado ${b})`}`);
}

// ---- nombres y datos de plantilla ----
esperar(primerNombre('María Pérez'), 'María', 'primer nombre');
esperar(primerNombre(''), 'familia', 'sin nombre -> familia');
esperar(primerNombre(null, 'tutor'), 'tutor', 'respaldo propio');
esperar(limpiarVariable('Ana:\nOctubre'), 'Ana: Octubre', 'sin saltos de línea');
esperar(limpiarVariable('a      b'), 'a   b', 'máximo 3 espacios seguidos');
esperar(limpiarVariable('   '), '-', 'un dato vacío no puede ir vacío');
esperar(rellenarPlantilla('Hola {{1}}, {{2}}!', ['Ana', 'Octubre']), 'Hola Ana, Octubre!', 'rellenar plantilla');
esperar(rellenarPlantilla('Hola {{1}} {{2}}', ['Ana']), 'Hola Ana {{2}}', 'un dato que falta se deja marcado');
esperar(rellenarPlantilla('Sin datos', []), 'Sin datos', 'plantilla sin variables');

// ---- números escritos a mano ----
const lista = parsearDestinatarios('612 34 56 78 María\n+34 623456789\n612345678\n12345\n; 699 88 77 66 , 655443322 Pau Gil');
esperar(lista.map(x => x.telefono), ['34612345678', '34623456789', '', '34699887766', '34655443322'], 'teléfonos normalizados y repetidos fuera');
esperar(lista.map(x => x.valido), [true, true, false, true, true], 'el de 5 dígitos no vale');
esperar(lista[0].nombre, 'María', 'nombre detrás del número');
esperar(lista[4].nombre, 'Pau Gil', 'nombre con dos palabras');
esperar(parsearDestinatarios('').length, 0, 'texto vacío');
esperar(parsearDestinatarios('hola que tal').map(x => x.valido), [false], 'texto sin número es inválido, no rompe');
esperar(parsearDestinatarios('+44 7911 123456')[0].telefono, '447911123456', 'número de otro país');

// ---- duplicados y nombres ----
esperar(sinTelefonosRepetidos([{ telefono: '1' }, { telefono: '2' }, { telefono: '1' }, { telefono: '' }]).length, 2, 'un mensaje por número');
esperar(unirNombres(['Ana']), 'Ana', 'un nombre');
esperar(unirNombres(['Ana', 'Luis']), 'Ana y Luis', 'dos nombres');
esperar(unirNombres(['Ana', 'Luis', 'Pau', 'Ana']), 'Ana, Luis y Pau', 'tres, sin repetir');

// ---- familias ----
const alumnos = [
  { id: 'a1', nombre: 'Ana Ruiz', estado: 'activo', tutor_nombre: 'María Ruiz', tutor_telefono: '612345678' },
  { id: 'a2', nombre: 'Luis Ruiz', estado: 'activo', tutor_nombre: 'María Ruiz', tutor_telefono: '612 345 678' },   // mismo número que Ana
  { id: 'a3', nombre: 'Pau Gil', estado: 'baja', tutor_telefono: '699887766' },                                       // de baja: fuera
  { id: 'a4', nombre: 'Eva Gil', estado: 'activo', padres_separados: true,
    madre_nombre: 'Carla Gil', madre_telefono: '633111222', padre_nombre: 'Jorge Soto', padre_telefono: '644333444' },
  { id: 'a5', nombre: 'Noa Sin', estado: 'activo', tutor_nombre: 'X', tutor_telefono: '12345' },                     // número malo
  { id: 'a6', nombre: 'Iván Adulto', estado: 'activo', telefono: '655000111' }                                         // adulto: su propio número
];
const { familias, sinTelefono } = familiasDeAlumnos(alumnos);
esperar(familias.length, 4, 'Ruiz (juntos) + madre + padre de Eva + Iván');
esperar(familias.find(f => f.telefono === '34612345678').etiqueta, 'Ana Ruiz y Luis Ruiz', 'hermanos con el mismo número, una sola familia');
esperar(familias.find(f => f.telefono === '34612345678').nombre, 'María', 'se saluda al tutor, no al niño');
esperar(familias.some(f => f.alumnos.includes('Pau Gil')), false, 'los de baja no salen');
esperar(familias.filter(f => f.alumnos.includes('Eva Gil')).map(f => f.nombre).sort(), ['Carla', 'Jorge'], 'padres separados: cada uno recibe el suyo');
esperar(familias.find(f => f.telefono === '34655000111').nombre, 'Iván', 'adulto sin tutor: se le saluda a él');
esperar(sinTelefono, ['Noa Sin'], 'quien no tiene número válido se avisa aparte');

console.log(fallos ? `\n${fallos} test(s) fallan.` : '\nTodos los tests de mensajes pasan.');
process.exit(fallos ? 1 : 0);
