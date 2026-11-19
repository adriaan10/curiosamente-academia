// Tests de "alumno que solo va algunos días de una clase" (src/lib/clases.js).
import { asisteEnDia, apuntadosEnDia, diasDeClase, normalizarDias, textoSoloDias, alternarDia } from '../src/lib/clases.js';

let fallos = 0;
function esperar(real, esperado, etiqueta) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  const ok = a === b;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK ' : 'FALLO'} ${etiqueta}${ok ? '' : `: ${a} (esperado ${b})`}`);
}

const LUNES = 1, MIERCOLES = 3;
esperar(asisteEnDia({ dias_semana: null }, LUNES), true, 'sin restricción va todos los días');
esperar(asisteEnDia({}, LUNES), true, 'fila antigua sin el campo: todos los días');
esperar(asisteEnDia({ dias_semana: [] }, LUNES), true, 'lista vacía se trata como todos (nunca deja a nadie sin clase)');
esperar(asisteEnDia({ dias_semana: [1] }, LUNES), true, 'va el lunes');
esperar(asisteEnDia({ dias_semana: [1] }, MIERCOLES), false, 'no va el miércoles');
esperar(asisteEnDia({ dias_semana: [1] }, undefined), true, 'sin día concreto (clase alternativa) se cuenta');

const clase = { clase_alumnos: [
  { alumno_id: 'a', dias_semana: null },
  { alumno_id: 'b', dias_semana: [1] },
  { alumno_id: 'c', dias_semana: [3] },
  { alumno_id: 'd' }
] };
esperar(apuntadosEnDia(clase, LUNES).map(x => x.alumno_id), ['a', 'b', 'd'], 'el lunes: todos menos el que solo va el miércoles');
esperar(apuntadosEnDia(clase, MIERCOLES).map(x => x.alumno_id), ['a', 'c', 'd'], 'el miércoles: todos menos el que solo va el lunes');
esperar(apuntadosEnDia(clase, 5).map(x => x.alumno_id), ['a', 'd'], 'un día sin restricciones guardadas para nadie: solo los de todos los días');
esperar(apuntadosEnDia({}, LUNES), [], 'clase sin apuntados');

esperar(diasDeClase([{ dia_semana: 3 }, { dia_semana: 1 }, { dia_semana: 3 }]), [1, 3], 'días distintos y ordenados');
esperar(diasDeClase([]), [], 'sin horarios');

esperar(normalizarDias(new Set([1, 3]), [1, 3]), null, 'marcados todos los días -> null');
esperar(normalizarDias(new Set([1]), [1, 3]), [1], 'solo el lunes');
esperar(normalizarDias(new Set([3, 1]), [1, 3, 5]), [1, 3], 'ordenados');
esperar(normalizarDias(new Set([5]), [1, 3]), null, 'si ya no queda ninguno de los días de la clase -> null, no vacío');
esperar(normalizarDias(new Set([1, 9]), [1, 3]), [1], 'un día que la clase ya no tiene se descarta');
esperar(normalizarDias(null, [1, 3]), null, 'sin selección -> null');
esperar(normalizarDias(new Set([1]), [1]), null, 'clase de un solo día: nunca hay restricción');

esperar(textoSoloDias([1], ['Lun', 'Mar', 'Mié']), 'solo Lun', 'texto con un día');
esperar(textoSoloDias([1, 3], ['Lun', 'Mar', 'Mié']), 'solo Lun y Mié', 'texto con dos días');
esperar(textoSoloDias([1, 3, 5], ['Lun', 'Mar', 'Mié', 'Jue', 'Vie']), 'solo Lun, Mié y Vie', 'texto con tres días');
esperar(textoSoloDias(null, ['Lun']), '', 'sin restricción no hay texto');

// ---- tocar un día en la ficha de la clase ----
esperar(alternarDia(null, [1, 3], 3), { dias: [1] }, 'iba a todos: tocar el miércoles -> solo el lunes');
esperar(alternarDia([1], [1, 3], 3), { dias: null }, 'solo lunes: tocar el miércoles lo vuelve a apuntar -> todos (null)');
esperar(alternarDia([1], [1, 3], 1), { error: 'minimo' }, 'no se puede dejar sin ningún día');
esperar(alternarDia([1, 3], [1, 3, 5], 5), { dias: null }, 'iba lunes y miércoles (viernes tachado): tocar el viernes lo vuelve a apuntar -> todos');
esperar(alternarDia(null, [1, 3, 5], 5), { dias: [1, 3] }, 'de 3 días, tocar el viernes -> lunes y miércoles');
esperar(alternarDia([1, 3], [1, 3, 5], 3), { dias: [1] }, 'quitar uno más');
esperar(alternarDia([5], [1, 3], 1), { dias: [3] }, 'guardado con un día que la clase ya no tiene: se trata como que va a todos, y tocar el lunes deja solo el miércoles');
console.log(fallos ? `\n${fallos} test(s) fallan.` : '\nTodos los tests de clases pasan.');
process.exit(fallos ? 1 : 0);
