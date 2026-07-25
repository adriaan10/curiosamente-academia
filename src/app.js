// Curiosamente — app de gestión de la academia (renderer).
// Vistas: configuración inicial, login, alumnos, recibos e historial, ajustes.
import { createClient } from '@supabase/supabase-js';
import { importeALetras } from './lib/numeroALetras.js';
import { generarReciboPdf, nombreArchivoRecibo } from './lib/pdf.js';
import {
  MESES, conceptoDesdeMeses, hoyDDMMAAAA, telefonoWa,
  formatoImporte, aCsv, escapeHtml
} from './lib/util.js';

const S = {
  cfg: {},
  sb: null,
  session: null,
  profesor: null,     // fila de `profesores` del usuario conectado
  profesores: [],
  asignaturas: [],
  profAsig: [],
  alumnos: [],
  recibos: [],
  clases: [],
  excepciones: [],
  notas: [],
  vista: 'inicio',
  vistaRecibos: 'pendientes',
  mesPagados: '',
  filtros: { texto: '', asignatura: '', estado: 'activo', profesor: '', textoRecibo: '' },
  logoBase64: null
};

const $app = () => document.getElementById('app');
const e = escapeHtml;

// ---------------------------------------------------------------- arranque

async function init() {
  S.cfg = await window.api.getConfig();
  S.logoBase64 = await window.api.getLogo();
  if (!S.cfg.supabaseUrl || !S.cfg.supabaseKey) return renderSetup();
  S.sb = createClient(S.cfg.supabaseUrl, S.cfg.supabaseKey);
  const { data } = await S.sb.auth.getSession();
  S.session = data.session;
  if (!S.session) return renderLogin();
  try {
    await cargarTodo();
    renderMain();
  } catch { /* expulsado por baja: ya se muestra el login */ }
}

async function cargarTodo() {
  const uid = S.session.user.id;
  const [prof, profs, asigs, profAsig] = await Promise.all([
    S.sb.from('profesores').select('*').eq('id', uid).single(),
    S.sb.from('profesores').select('*').order('nombre'),
    S.sb.from('asignaturas').select('*').order('id'),
    S.sb.from('profesor_asignaturas').select('*')
  ]);
  S.profesor = prof.data;
  // Si el profesor fue dado de baja con la sesión aún abierta, se le expulsa.
  if (S.profesor?.estado === 'baja') {
    await S.sb.auth.signOut();
    S.session = null;
    S.profesor = null;
    renderLogin();
    setTimeout(() => {
      const m = document.getElementById('msg');
      if (m) m.textContent = 'Tu acceso está desactivado. Habla con la academia.';
    }, 0);
    throw new Error('acceso desactivado');
  }
  S.profesores = profs.data || [];
  S.asignaturas = asigs.data || [];
  S.profAsig = profAsig.data || [];
  await Promise.all([cargarAlumnos(), cargarRecibos(), cargarClases(), cargarNotas()]);
  backupAutomatico();
  window.api.getRecibosDir(); // crea la carpeta de recibos de este equipo si no existía aún
}

async function cargarNotas() {
  const { data, error } = await S.sb.from('notas').select('*').order('created_at', { ascending: false });
  if (error) return avisar('Error cargando notas: ' + error.message, true);
  S.notas = data || [];
}

async function cargarClases() {
  const [clases, excepciones] = await Promise.all([
    S.sb.from('clases')
      .select('*, asignaturas(nombre), profesores(nombre), clase_horarios(*), clase_alumnos(alumno_id)')
      .order('nombre'),
    S.sb.from('clase_excepciones').select('*').order('fecha')
  ]);
  if (clases.error) return avisar('Error cargando clases: ' + clases.error.message, true);
  S.clases = clases.data || [];
  S.excepciones = excepciones.data || [];
}

// Copia de seguridad local diaria con los datos visibles para este usuario.
async function backupAutomatico() {
  try {
    await window.api.saveBackup(JSON.stringify({
      fecha: new Date().toISOString(),
      usuario: S.profesor?.email,
      alumnos: S.alumnos,
      recibos: S.recibos
    }, null, 2));
  } catch { /* el backup nunca debe bloquear el uso de la app */ }
}

async function cargarAlumnos() {
  const { data, error } = await S.sb.from('alumnos')
    .select('*, matriculas(*, asignaturas(nombre))')
    .order('nombre');
  if (error) return avisar('Error cargando alumnos: ' + error.message, true);
  S.alumnos = data || [];
}

async function cargarRecibos() {
  const { data, error } = await S.sb.from('recibos')
    .select('*, alumnos(nombre, telefono, tutor_telefono, tutor_nombre, facturacion_nombre), profesores(nombre)')
    .order('created_at', { ascending: false });
  if (error) return avisar('Error cargando recibos: ' + error.message, true);
  S.recibos = data || [];
}

// ---------------------------------------------------------------- setup / login

function renderSetup() {
  $app().innerHTML = `
  <div class="centrado">
    <div class="tarjeta login">
      <div class="marca">Curiosamente<span class="lapiz"></span></div>
      <p class="sub">tu centro de estudios</p>
      <h2>Configuración inicial</h2>
      <p class="ayuda">Introduce los datos del proyecto Supabase de la academia.
      Solo hay que hacerlo una vez por ordenador.</p>
      <label>URL del proyecto
        <input id="cfg-url" type="text" placeholder="https://xxxx.supabase.co" value="${e(S.cfg.supabaseUrl || '')}">
      </label>
      <label>Clave pública (anon / publishable)
        <input id="cfg-key" type="text" placeholder="sb_publishable_... o eyJ...">
      </label>
      <button class="btn primario" id="cfg-guardar">Guardar y continuar</button>
      <p id="msg" class="error"></p>
    </div>
  </div>`;
  document.getElementById('cfg-guardar').onclick = async () => {
    const supabaseUrl = document.getElementById('cfg-url').value.trim();
    const supabaseKey = document.getElementById('cfg-key').value.trim();
    if (!supabaseUrl || !supabaseKey) {
      document.getElementById('msg').textContent = 'Rellena los dos campos.';
      return;
    }
    S.cfg = await window.api.setConfig({ supabaseUrl, supabaseKey });
    init();
  };
}

function logoHtml(clase = 'logo-login') {
  return S.logoBase64
    ? `<img class="${clase}" src="data:image/png;base64,${S.logoBase64}" alt="Curiosamente">`
    : `<div class="marca">Curiosamente<span class="lapiz"></span></div>`;
}

function renderLogin() {
  $app().innerHTML = `
  <div class="centrado">
    <div class="tarjeta login">
      ${logoHtml()}
      <p class="sub">tu centro de estudios</p>
      <h2>Iniciar sesión</h2>
      <label>Email <input id="login-email" type="email" autocomplete="username"></label>
      <label>Contraseña
        <span class="campo-pass">
          <input id="login-pass" type="password" autocomplete="current-password">
          <button type="button" class="ver-pass" id="ver-pass" title="Ver contraseña">👁</button>
        </span>
      </label>
      <button class="btn primario" id="login-btn">Entrar</button>
      <p id="msg" class="error"></p>
    </div>
  </div>`;
  const $pass = document.getElementById('login-pass');
  document.getElementById('ver-pass').onclick = (ev) => {
    const visible = $pass.type === 'text';
    $pass.type = visible ? 'password' : 'text';
    ev.currentTarget.textContent = visible ? '👁' : '🙈';
    $pass.focus();
  };
  const entrar = async () => {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-pass').value;
    const btn = document.getElementById('login-btn');
    btn.disabled = true; btn.textContent = 'Entrando…';
    const { data, error } = await S.sb.auth.signInWithPassword({ email, password });
    if (error) {
      btn.disabled = false; btn.textContent = 'Entrar';
      document.getElementById('msg').textContent =
        error.message === 'Invalid login credentials' ? 'Email o contraseña incorrectos.'
          : /banned/i.test(error.message) ? 'Tu acceso está desactivado. Habla con la academia.'
            : error.message;
      return;
    }
    S.session = data.session;
    try {
      await cargarTodo();
      renderMain();
    } catch { /* expulsado por baja: ya se muestra el login */ }
  };
  document.getElementById('login-btn').onclick = entrar;
  document.getElementById('login-pass').onkeydown = (ev) => { if (ev.key === 'Enter') entrar(); };
}

// ---------------------------------------------------------------- layout principal

function renderMain() {
  const esAdmin = S.profesor?.es_admin;
  $app().innerHTML = `
  <header>
    <div class="marca chica">
      ${S.logoBase64 ? `<img class="logo-mini" src="data:image/png;base64,${S.logoBase64}" alt="">` : ''}
      Curiosamente<span class="lapiz"></span>
    </div>
    <nav>
      <button data-v="inicio" class="tab ${S.vista === 'inicio' ? 'activa' : ''}">Inicio</button>
      <button data-v="alumnos" class="tab ${S.vista === 'alumnos' ? 'activa' : ''}">Alumnos</button>
      <button data-v="clases" class="tab ${S.vista === 'clases' ? 'activa' : ''}">Clases</button>
      <button data-v="horario" class="tab ${S.vista === 'horario' ? 'activa' : ''}">Horario</button>
      <button data-v="recibos" class="tab ${S.vista === 'recibos' ? 'activa' : ''}">Recibos</button>
      <button data-v="notas" class="tab ${S.vista === 'notas' ? 'activa' : ''}">Notas</button>
      ${esAdmin ? `<button data-v="profesores" class="tab ${S.vista === 'profesores' ? 'activa' : ''}">Profesores</button>` : ''}
      <button data-v="ajustes" class="tab ${S.vista === 'ajustes' ? 'activa' : ''}">Ajustes</button>
    </nav>
    <div class="usuario">
      <span>${e(S.profesor?.nombre || '')}${esAdmin ? ' · admin' : ''}</span>
      <button class="btn liso" id="logout">Salir</button>
    </div>
  </header>
  <main id="contenido"></main>
  <div id="modal-raiz"></div>
  <div id="toast"></div>`;
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => { S.vista = b.dataset.v; renderMain(); });
  document.getElementById('logout').onclick = async () => {
    await S.sb.auth.signOut();
    S.session = null; S.profesor = null;
    renderLogin();
  };
  if (S.vista === 'inicio') renderInicio();
  else if (S.vista === 'alumnos') renderAlumnos();
  else if (S.vista === 'clases') renderClases();
  else if (S.vista === 'horario') renderHorario();
  else if (S.vista === 'recibos') renderRecibos();
  else if (S.vista === 'notas') renderNotas();
  else if (S.vista === 'profesores') renderProfesores();
  else renderAjustes();
}

// ---------------------------------------------------------------- portada

function renderInicio() {
  const hoy = new Date();
  const diaHoy = ((hoy.getDay() + 6) % 7) + 1; // 1=lunes … 7=domingo
  const fecha = `${DIAS[diaHoy - 1]}, ${hoy.getDate()} de ${MESES[hoy.getMonth()].toLowerCase()} de ${hoy.getFullYear()}`;

  // Cada profesor cuenta solo los alumnos de sus asignaturas (el admin, todos);
  // la base de datos completa se ve en Alumnos marcando "Toda la academia".
  const activos = S.alumnos.filter(a =>
    a.estado === 'activo' && (S.profesor?.es_admin || misMatriculas(a).length > 0)).length;
  const pendientes = S.recibos.filter(r => r.estado !== 'pagado');
  const totalPendiente = pendientes.reduce((s, r) => s + Number(r.importe), 0);
  const clasesHoy = [];
  for (const c of clasesFiltradas()) {
    for (const h of c.clase_horarios || []) {
      if (h.dia_semana === diaHoy) clasesHoy.push({ ...h, clase: c });
    }
  }
  clasesHoy.sort((a, b) => String(a.hora).localeCompare(String(b.hora)));

  document.getElementById('contenido').innerHTML = `
  <div class="portada">
    <div class="portada-marca">
      ${S.logoBase64
        ? `<img class="logo-portada" src="data:image/png;base64,${S.logoBase64}" alt="Curiosamente">`
        : `<div class="marca grande">Curiosamente<span class="lapiz lapiz-grande"></span></div>`}
      <p class="portada-sub">tu centro de estudios</p>
    </div>
    <p class="portada-hola">Hola, <strong>${e(S.profesor?.nombre || '')}</strong> · ${e(fecha)}</p>
    <div class="portada-cards">
      <div class="portada-card" data-ir="horario">
        <div class="pc-num">${clasesHoy.length}</div>
        <div class="pc-titulo">clase${clasesHoy.length === 1 ? '' : 's'} hoy</div>
        <div class="pc-detalle">${clasesHoy.length
          ? e(clasesHoy.slice(0, 3).map(s => `${horaCorta(s.hora)} ${s.clase.nombre}`).join(' · ')) + (clasesHoy.length > 3 ? '…' : '')
          : 'Nada en el horario de hoy'}</div>
      </div>
      <div class="portada-card" data-ir="alumnos">
        <div class="pc-num">${activos}</div>
        <div class="pc-titulo">alumno${activos === 1 ? '' : 's'} activo${activos === 1 ? '' : 's'}</div>
        <div class="pc-detalle">Ver la base de datos</div>
      </div>
      <div class="portada-card ${pendientes.length ? 'alerta' : ''}" data-ir="recibos">
        <div class="pc-num">${pendientes.length}</div>
        <div class="pc-titulo">recibo${pendientes.length === 1 ? '' : 's'} pendiente${pendientes.length === 1 ? '' : 's'}</div>
        <div class="pc-detalle">${pendientes.length ? formatoImporte(totalPendiente) + '€ por cobrar' : 'Todo cobrado 🎉'}</div>
      </div>
      <div class="portada-card" data-ir="notas">
        <div class="pc-num">${S.notas.length}</div>
        <div class="pc-titulo">nota${S.notas.length === 1 ? '' : 's'}</div>
        <div class="pc-detalle">Tus pósits</div>
      </div>
    </div>
  </div>`;

  document.querySelectorAll('[data-ir]').forEach(c => c.onclick = () => {
    S.vista = c.dataset.ir;
    renderMain();
  });
}

// ---------------------------------------------------------------- alumnos

// Asignaturas que imparte un profesor. El admin (o un profesor sin materias
// asignadas todavía) ve todas.
function asignaturasDeProfesor(profesorId) {
  const ids = S.profAsig.filter(x => x.profesor_id === profesorId).map(x => x.asignatura_id);
  if (!ids.length) return S.asignaturas;
  return S.asignaturas.filter(a => ids.includes(a.id));
}

function misAsignaturas() {
  return S.profesor?.es_admin ? S.asignaturas : asignaturasDeProfesor(S.profesor?.id);
}

function opcionesAsignaturas(profesorId, seleccionadaId) {
  const lista = S.profesor?.es_admin && !profesorId
    ? S.asignaturas
    : asignaturasDeProfesor(profesorId);
  return lista.map(x =>
    `<option value="${x.id}" ${x.id === seleccionadaId ? 'selected' : ''}>${e(x.nombre)}</option>`).join('');
}

// Color por área de asignatura: Inglés amarillo, Matemáticas azul, FyQ verde.
function colorArea(nombreAsignatura) {
  const n = String(nombreAsignatura || '');
  if (n.startsWith('Inglés')) return { fondo: '#FFF1C2', borde: '#C9A227' };
  if (n.startsWith('Matemáticas')) return { fondo: '#DCEBFA', borde: '#3D7DC8' };
  if (n.startsWith('Física')) return { fondo: '#DFF2E4', borde: '#2E9E5B' };
  return { fondo: '#EFEFF2', borde: '#8E8E93' };
}

function chipAsignatura(m, extraHtml = '') {
  const c = colorArea(m.asignaturas?.nombre);
  return `<span class="chip-asig" style="background:${c.fondo}; border-left: 3px solid ${c.borde}">
    ${e(m.asignaturas?.nombre || '')} · ${formatoImporte(m.tarifa)}€/${m.tipo_tarifa === 'clase' ? 'clase' : 'mes'}${extraHtml}</span>`;
}

// Matrículas de un alumno que corresponden a las asignaturas de un profesor.
function matriculasDeProfesor(alumno, profesorId) {
  const ids = new Set(asignaturasDeProfesor(profesorId).map(a => a.id));
  return (alumno.matriculas || []).filter(m => ids.has(m.asignatura_id));
}

// Matrículas que el usuario actual puede gestionar (admin: todas).
function misMatriculas(alumno) {
  return S.profesor?.es_admin ? (alumno.matriculas || []) : matriculasDeProfesor(alumno, S.profesor?.id);
}

function alumnosFiltrados() {
  const f = S.filtros;
  const t = f.texto.toLowerCase();
  const esAdmin = S.profesor?.es_admin;
  return S.alumnos.filter(a =>
    // Por defecto cada profesor ve los alumnos de sus asignaturas; con
    // "Toda la academia" (o buscando por texto) ve la base de datos común.
    (esAdmin || f.verTodos || t || misMatriculas(a).length > 0) &&
    (!t || a.nombre.toLowerCase().includes(t) || (a.telefono || '').includes(t)) &&
    (!f.asignatura || (a.matriculas || []).some(m => String(m.asignatura_id) === f.asignatura)) &&
    (!f.estado || a.estado === f.estado) &&
    (!f.profesor || matriculasDeProfesor(a, f.profesor).length > 0)
  );
}

function renderAlumnos() {
  const esAdmin = S.profesor?.es_admin;
  const lista = alumnosFiltrados();
  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <input id="f-texto" type="search" placeholder="Buscar alumno o teléfono…" value="${e(S.filtros.texto)}">
    <select id="f-asig">
      <option value="">Todas las asignaturas</option>
      ${misAsignaturas().map(a => `<option value="${a.id}" ${String(a.id) === S.filtros.asignatura ? 'selected' : ''}>${e(a.nombre)}</option>`).join('')}
    </select>
    <select id="f-estado">
      <option value="" ${!S.filtros.estado ? 'selected' : ''}>Todos</option>
      <option value="activo" ${S.filtros.estado === 'activo' ? 'selected' : ''}>Activos</option>
      <option value="baja" ${S.filtros.estado === 'baja' ? 'selected' : ''}>Bajas</option>
    </select>
    ${esAdmin ? `<select id="f-prof">
      <option value="">Todos los profesores</option>
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === S.filtros.profesor ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select>` : `<label class="check-inline"><input type="checkbox" id="f-todos" ${S.filtros.verTodos ? 'checked' : ''}> Toda la academia</label>`}
    <span class="flex1"></span>
    <button class="btn" id="btn-csv">Exportar CSV</button>
    <button class="btn" id="btn-bulk">Recibos del mes</button>
    <button class="btn primario" id="btn-nuevo">+ Nuevo alumno</button>
  </div>
  ${lista.length === 0 ? `<div class="vacio">No hay alumnos que coincidan.<br>
    <small>Da de alta el primero con “+ Nuevo alumno”.</small></div>` : `
  <table>
    <thead><tr>
      <th>Alumno</th><th>Asignaturas</th><th>Teléfono</th><th>Estado</th><th></th>
    </tr></thead>
    <tbody>
    ${lista.map(a => `<tr class="${a.estado === 'baja' ? 'apagado' : ''}">
      <td><strong>${e(a.nombre)}</strong>${a.tutor_nombre ? `<br><small>Tutor: ${e(a.tutor_nombre)}</small>` : ''}</td>
      <td>${(a.matriculas || []).map(m => chipAsignatura(m)).join(' ')
        || '<small>Sin asignaturas</small>'}</td>
      <td>${e(a.telefono || a.tutor_telefono || '')}</td>
      <td><span class="chip ${a.estado}">${a.estado}</span></td>
      <td class="acciones">
        <button class="btn chico" data-recibo="${a.id}">Recibo</button>
        <button class="btn chico liso" data-editar="${a.id}">Editar</button>
      </td>
    </tr>`).join('')}
    </tbody>
  </table>`}`;

  const rerender = () => renderAlumnos();
  document.getElementById('f-texto').oninput = (ev) => { S.filtros.texto = ev.target.value; rerender(); };
  document.getElementById('f-asig').onchange = (ev) => { S.filtros.asignatura = ev.target.value; rerender(); };
  document.getElementById('f-estado').onchange = (ev) => { S.filtros.estado = ev.target.value; rerender(); };
  const fp = document.getElementById('f-prof');
  if (fp) fp.onchange = (ev) => { S.filtros.profesor = ev.target.value; rerender(); };
  const ft = document.getElementById('f-todos');
  if (ft) ft.onchange = (ev) => { S.filtros.verTodos = ev.target.checked; rerender(); };
  document.getElementById('btn-nuevo').onclick = () => modalAlumno(null);
  document.getElementById('btn-bulk').onclick = () => modalReciboBulk();
  document.getElementById('btn-csv').onclick = exportarAlumnosCsv;
  document.querySelectorAll('[data-editar]').forEach(b =>
    b.onclick = () => modalAlumno(S.alumnos.find(a => a.id === b.dataset.editar)));
  document.querySelectorAll('[data-recibo]').forEach(b =>
    b.onclick = () => modalRecibo(S.alumnos.find(a => a.id === b.dataset.recibo)));
}

function modalAlumno(alumno) {
  const esAdmin = S.profesor?.es_admin;
  const a = alumno || {};
  // Matrículas en edición local: las de mis asignaturas (o todas si admin) se
  // pueden tocar; las del resto de profesores se muestran solo informativas.
  const ms = alumno ? misMatriculas(alumno).map(m => ({ ...m })) : [];
  const soloLectura = alumno ? (alumno.matriculas || []).filter(m => !ms.some(x => x.id === m.id)) : [];
  const idsOriginales = ms.map(m => m.id);
  const nuevaMatricula = () => ({ id: null, asignatura_id: misAsignaturas()[0]?.id, tarifa: '', tipo_tarifa: 'mes', horas_semana: '' });
  if (!alumno) ms.push(nuevaMatricula());

  abrirModal(`
  <h2>${alumno ? 'Ficha de ' + e(a.nombre) : 'Nuevo alumno'}</h2>
  ${alumno && a.estado === 'baja' ? '<p class="ayuda">⚠ Este alumno está <strong>de baja</strong>.</p>' : ''}
  <div class="grid2">
    <label>Nombre y apellidos *<input id="a-nombre" value="${e(a.nombre || '')}"></label>
    <label>Teléfono / WhatsApp (si es menor, el del padre/madre)
      <input id="a-tel" value="${e(a.telefono || a.tutor_telefono || '')}"></label>
    <label>Padre / madre / tutor (nombre y apellidos)
      <input id="a-tutor" value="${e(a.tutor_nombre || '')}" placeholder="El recibo irá a su nombre"></label>
    <label>Fecha de alta<input id="a-alta" type="date" value="${e(a.fecha_alta || new Date().toISOString().slice(0, 10))}"></label>
    <label>Facturar a (si difiere)<input id="a-fact-nombre" value="${e(a.facturacion_nombre || '')}"></label>
    <label>Dirección de facturación<input id="a-fact-dir" value="${e(a.facturacion_direccion || '')}"></label>
  </div>
  <h3 class="seccion">Asignaturas apuntadas</h3>
  ${soloLectura.length ? `<div class="detalle-horarios">
    ${soloLectura.map(m => chipAsignatura(m, ' <small>(otro profesor)</small>')).join('')}
  </div>` : ''}
  <div id="a-matriculas"></div>
  <button class="btn chico" id="a-add-mat">+ Añadir asignatura</button>
  <label>Notas / observaciones<textarea id="a-notas" rows="3">${e(a.notas || '')}</textarea></label>
  <div class="pie-modal">
    ${alumno ? (a.estado === 'baja'
      ? '<button class="btn" id="a-reactivar">Reactivar alumno</button>'
      : '<button class="btn liso peligro" id="a-baja">Dar de baja (de todo)</button>') : ''}
    <span class="flex1"></span>
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="m-guardar">Guardar</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  const pintarMatriculas = () => {
    document.getElementById('a-matriculas').innerHTML = ms.map((m, i) => `
      <div class="fila-horario">
        <select data-m-asig="${i}">${opcionesAsignaturas(esAdmin ? null : S.profesor.id, m.asignatura_id)}</select>
        <input type="number" data-m-tarifa="${i}" min="0" step="0.01" placeholder="€" value="${m.tarifa ?? ''}" class="ancho-tarifa">
        <select data-m-tipo="${i}">
          <option value="mes" ${m.tipo_tarifa !== 'clase' ? 'selected' : ''}>€/mes</option>
          <option value="clase" ${m.tipo_tarifa === 'clase' ? 'selected' : ''}>€/clase</option>
        </select>
        <input type="number" data-m-horas="${i}" min="0" step="0.5" placeholder="h/sem" value="${m.horas_semana ?? ''}" class="ancho-horas">
        <button class="btn chico liso" data-m-quitar="${i}" title="Quitar esta asignatura">✕</button>
      </div>`).join('') || '<p class="ayuda">Sin asignaturas tuyas todavía.</p>';
    const cont = document.getElementById('a-matriculas');
    cont.querySelectorAll('[data-m-asig]').forEach(s => s.onchange = () => { ms[+s.dataset.mAsig].asignatura_id = Number(s.value); });
    cont.querySelectorAll('[data-m-tarifa]').forEach(s => s.oninput = () => { ms[+s.dataset.mTarifa].tarifa = s.value; });
    cont.querySelectorAll('[data-m-tipo]').forEach(s => s.onchange = () => { ms[+s.dataset.mTipo].tipo_tarifa = s.value; });
    cont.querySelectorAll('[data-m-horas]').forEach(s => s.oninput = () => { ms[+s.dataset.mHoras].horas_semana = s.value; });
    cont.querySelectorAll('[data-m-quitar]').forEach(b => b.onclick = () => { ms.splice(+b.dataset.mQuitar, 1); pintarMatriculas(); });
  };
  pintarMatriculas();
  document.getElementById('a-add-mat').onclick = () => { ms.push(nuevaMatricula()); pintarMatriculas(); };

  const msg = (t) => { document.getElementById('m-msg').textContent = t; };

  if (alumno) {
    const btnBaja = document.getElementById('a-baja');
    if (btnBaja) btnBaja.onclick = async () => {
      if (!confirm(`Vas a dar de baja a ${a.nombre} de TODO: todas las asignaturas y todas las clases. La ficha se conserva en el filtro "Bajas" por si vuelve. ¿Continuar?`)) return;
      const { error } = await S.sb.rpc('dar_baja_alumno', { p_alumno: a.id });
      if (error) return msg('Error: ' + error.message);
      cerrarModal();
      await Promise.all([cargarAlumnos(), cargarClases()]);
      renderAlumnos();
      avisar(`${a.nombre} dado de baja. Su ficha sigue en el filtro "Bajas".`);
    };
    const btnRe = document.getElementById('a-reactivar');
    if (btnRe) btnRe.onclick = async () => {
      const { error } = await S.sb.from('alumnos').update({ estado: 'activo' }).eq('id', a.id);
      if (error) return msg('Error: ' + error.message);
      cerrarModal();
      await cargarAlumnos();
      renderAlumnos();
      avisar(`${a.nombre} reactivado.`);
    };
  }

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('m-guardar').onclick = async () => {
    const v = (id) => document.getElementById(id)?.value.trim();
    const fila = {
      nombre: v('a-nombre'),
      telefono: v('a-tel') || null,
      tutor_nombre: v('a-tutor') || null,
      fecha_alta: v('a-alta') || null,
      facturacion_nombre: v('a-fact-nombre') || null,
      facturacion_direccion: v('a-fact-dir') || null,
      notas: v('a-notas') || null
    };
    if (!fila.nombre) return msg('El nombre es obligatorio.');
    if (ms.some(m => !m.asignatura_id || !Number(m.tarifa))) return msg('Cada asignatura necesita su tarifa.');

    let alumnoId = alumno?.id;
    if (alumno) {
      const { error } = await S.sb.from('alumnos').update(fila).eq('id', alumno.id);
      if (error) return msg(errorAlumno(error));
    } else {
      const { data, error } = await S.sb.from('alumnos').insert(fila).select('id').single();
      if (error) return msg(errorAlumno(error));
      alumnoId = data.id;
    }
    // Sincroniza las matrículas gestionadas desde este modal
    const borradas = idsOriginales.filter(id => !ms.some(m => m.id === id));
    if (borradas.length) await S.sb.from('matriculas').delete().in('id', borradas);
    for (const m of ms) {
      const datos = {
        alumno_id: alumnoId,
        asignatura_id: Number(m.asignatura_id),
        tarifa: Number(m.tarifa),
        tipo_tarifa: m.tipo_tarifa,
        horas_semana: m.horas_semana ? Number(m.horas_semana) : null
      };
      const { error } = m.id
        ? await S.sb.from('matriculas').update(datos).eq('id', m.id)
        : await S.sb.from('matriculas').insert(datos);
      if (error) return msg(errorMatricula(error));
    }
    cerrarModal();
    await cargarAlumnos();
    renderAlumnos();
    avisar(alumno ? 'Ficha actualizada.' : 'Alumno dado de alta.');
  };
}

function errorAlumno(error) {
  if (error.code === '23505' || /alumnos_nombre_unico|duplicate key/.test(error.message || '')) {
    return '⚠ Ya existe un alumno con ese nombre. Búscalo en el listado (marca "Toda la academia") y edita su ficha para añadirle tu asignatura.';
  }
  return 'Error al guardar: ' + error.message;
}

function errorMatricula(error) {
  if (error.code === '23505' || /duplicate key/.test(error.message || '')) {
    return '⚠ Ese alumno ya está apuntado a esa asignatura.';
  }
  return 'Error al guardar la matrícula: ' + error.message;
}

async function exportarAlumnosCsv() {
  const csv = aCsv(alumnosFiltrados(), [
    { titulo: 'Nombre', valor: a => a.nombre },
    { titulo: 'Asignaturas', valor: a => (a.matriculas || [])
      .map(m => `${m.asignaturas?.nombre} (${m.tarifa}€/${m.tipo_tarifa})`).join(' | ') },
    { titulo: 'Teléfono', valor: a => a.telefono },
    { titulo: 'Padre/madre/tutor', valor: a => a.tutor_nombre },
    { titulo: 'Estado', valor: a => a.estado },
    { titulo: 'Fecha alta', valor: a => a.fecha_alta },
    { titulo: 'Notas', valor: a => a.notas }
  ]);
  const ruta = await window.api.saveCsv(csv, 'alumnos_curiosamente.csv');
  if (ruta) avisar('CSV guardado en ' + ruta);
}

// ---------------------------------------------------------------- clases (grupos)

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const DIAS_CORTO = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function horaCorta(hora) {
  return String(hora || '').slice(0, 5); // "17:00:00" -> "17:00"
}

function horaFin(hora, duracionMin) {
  const [h, m] = String(hora).split(':').map(Number);
  const total = h * 60 + m + (duracionMin || 60);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fechaISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtFecha(iso) {
  return String(iso || '').split('-').reverse().join('/');
}

// Próxima fecha (desde hoy) en la que toca esta clase según su horario semanal.
function proximaFechaClase(clase) {
  const dias = new Set((clase.clase_horarios || []).map(h => h.dia_semana));
  const d = new Date();
  for (let i = 0; i < 14; i++) {
    if (dias.has(((d.getDay() + 6) % 7) + 1)) return fechaISO(d);
    d.setDate(d.getDate() + 1);
  }
  return fechaISO(new Date());
}

// Set "claseId|fecha" con las anulaciones, para consultas rápidas al pintar.
function setAnuladas() {
  return new Set(S.excepciones.filter(x => x.tipo === 'anulada').map(x => x.clase_id + '|' + x.fecha));
}

function textoHorarios(clase) {
  const hs = [...(clase.clase_horarios || [])].sort((a, b) =>
    a.dia_semana - b.dia_semana || String(a.hora).localeCompare(String(b.hora)));
  return hs.map(h => `${DIAS_CORTO[h.dia_semana - 1]} ${horaCorta(h.hora)}`).join(' · ') || '—';
}

function clasesFiltradas() {
  return S.clases.filter(c => !S.filtros.profesor || c.profesor_id === S.filtros.profesor);
}

// Colores disponibles para las clases (cada clase elige el suyo).
const COLORES_CLASE = ['#F28C28', '#3D7DC8', '#2E9E5B', '#8E5BBF', '#C8506A',
  '#C2A61B', '#2E9E9E', '#D96C3C', '#5B6ABF', '#4E9E2E'];

// Color de una clase: el elegido por el usuario o, si no, uno fijo según la asignatura.
function colorClase(clase) {
  const borde = clase?.color || COLORES_CLASE[(Number(clase?.asignatura_id) || 0) % COLORES_CLASE.length];
  return { borde, fondo: borde + '22' }; // fondo = mismo color con transparencia suave
}

function renderClases() {
  const esAdmin = S.profesor?.es_admin;
  const lista = clasesFiltradas();
  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    ${esAdmin ? `<select id="fc-prof">
      <option value="">Todos los profesores</option>
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === S.filtros.profesor ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select>` : ''}
    <span class="flex1"></span>
    <button class="btn primario" id="btn-nueva-clase">+ Nueva clase</button>
  </div>
  ${lista.length === 0 ? `<div class="vacio">Todavía no hay clases.<br>
    <small>Crea un grupo con “+ Nueva clase”: elige los alumnos apuntados y sus días y horas.</small></div>` : `
  <div class="clases-grid">
    ${lista.map(c => {
      const n = (c.clase_alumnos || []).length;
      const col = colorClase(c);
      return `<div class="clase-tile" data-abrir-clase="${c.id}"
        style="background:${col.fondo}; border-top-color:${col.borde}">
        <div class="tile-nombre">${e(c.nombre)}</div>
        <div class="tile-asig">${e(c.asignaturas?.nombre || '')}</div>
        <div class="tile-horario">${e(textoHorarios(c))}</div>
        <div class="tile-pie">${n} alumno${n === 1 ? '' : 's'}${esAdmin ? ' · ' + e(c.profesores?.nombre || '') : ''}</div>
      </div>`;
    }).join('')}
  </div>`}`;

  const fc = document.getElementById('fc-prof');
  if (fc) fc.onchange = (ev) => { S.filtros.profesor = ev.target.value; renderClases(); };
  document.getElementById('btn-nueva-clase').onclick = () => modalClase(null);
  document.querySelectorAll('[data-abrir-clase]').forEach(t =>
    t.onclick = () => modalDetalleClase(S.clases.find(c => c.id === t.dataset.abrirClase)));
}

// Ficha de la clase en modo consulta: nombre, horario y alumnos.
// El lápiz ✏️ abre el editor; "Anular clase" gestiona los días sin clase.
function modalDetalleClase(clase, fechaCtx) {
  const color = colorClase(clase);
  const hs = [...(clase.clase_horarios || [])].sort((a, b) =>
    a.dia_semana - b.dia_semana || String(a.hora).localeCompare(String(b.hora)));
  const alumnos = (clase.clase_alumnos || [])
    .map(ca => S.alumnos.find(a => a.id === ca.alumno_id))
    .filter(Boolean)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  const hoyIso = fechaISO(new Date());
  const proximasExc = S.excepciones.filter(x => x.clase_id === clase.id && x.fecha >= hoyIso);
  const anulaciones = proximasExc.filter(x => x.tipo === 'anulada');
  const alternativas = proximasExc.filter(x => x.tipo === 'extra');

  abrirModal(`
  <div class="detalle-cabecera" style="border-left: 5px solid ${color.borde}">
    <div>
      <h2>${e(clase.nombre)}</h2>
      <p class="ayuda">${e(clase.asignaturas?.nombre || '')}${S.profesor?.es_admin ? ' · ' + e(clase.profesores?.nombre || '') : ''}</p>
    </div>
    <button class="btn btn-lapiz" id="d-editar" title="Editar la clase">✏️</button>
  </div>
  ${clase.notas ? `<p class="ayuda">${e(clase.notas)}</p>` : ''}
  <h3 class="seccion">Horario</h3>
  ${hs.length === 0 ? '<p class="ayuda">Sin horario asignado.</p>' : `
  <div class="detalle-horarios">
    ${hs.map(h => `<span class="horario-pastilla" style="background:${color.fondo}; border-color:${color.borde}">
      ${DIAS[h.dia_semana - 1]} · ${horaCorta(h.hora)}–${horaFin(h.hora, h.duracion_min)}</span>`).join('')}
  </div>`}
  ${anulaciones.length ? `
  <h3 class="seccion">Anulaciones próximas</h3>
  <div class="detalle-horarios">
    ${anulaciones.map(x => `<span class="horario-pastilla anulada-pastilla">
      ${fmtFecha(x.fecha)}${x.motivo ? ' · ' + e(x.motivo) : ''}
      <button class="quitar-exc" data-quitar-exc="${x.id}" title="Quitar la anulación">✕</button></span>`).join('')}
  </div>` : ''}
  ${alternativas.length ? `
  <h3 class="seccion">Clases alternativas próximas</h3>
  <div class="detalle-horarios">
    ${alternativas.map(x => `<span class="horario-pastilla" style="background:${color.fondo}; border-color:${color.borde}">
      ${fmtFecha(x.fecha)} · ${horaCorta(x.hora)}${x.nombre ? ' · ' + e(x.nombre) : ''}
      <button class="quitar-exc" data-quitar-exc="${x.id}" title="Eliminar la clase alternativa">✕</button></span>`).join('')}
  </div>` : ''}
  <h3 class="seccion">Alumnos (${alumnos.length})</h3>
  ${alumnos.length === 0 ? '<p class="ayuda">Todavía no hay alumnos apuntados.</p>' : `
  <ul class="detalle-alumnos">
    ${alumnos.map(a => `<li>${e(a.nombre)}${a.telefono ? ` <small>· ${e(a.telefono)}</small>` : ''}</li>`).join('')}
  </ul>`}
  <div class="pie-modal">
    <button class="btn liso peligro" id="d-anular">Anular clase…</button>
    <span class="flex1"></span>
    <button class="btn liso" id="m-cancelar">Cerrar</button>
  </div>`);

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('d-editar').onclick = () => {
    cerrarModal();
    modalClase(clase);
  };
  document.getElementById('d-anular').onclick = () => modalAnularClase(clase, fechaCtx);
  document.querySelectorAll('[data-quitar-exc]').forEach(b => b.onclick = async (ev) => {
    ev.stopPropagation();
    await S.sb.from('clase_excepciones').delete().eq('id', b.dataset.quitarExc);
    await cargarClases();
    modalDetalleClase(S.clases.find(c => c.id === clase.id), fechaCtx);
    avisar('Excepción eliminada.');
  });
}

// Ventana de confirmación para anular la clase de un día concreto.
function modalAnularClase(clase, fechaDefault) {
  abrirModal(`
  <h2>Anular clase — ${e(clase.nombre)}</h2>
  <p class="ayuda">La clase de ese día aparecerá como <strong>ANULADA</strong> en el horario y el calendario.
  El horario semanal de siempre no cambia; solo se anula ese día concreto.</p>
  <div class="grid2">
    <label>Día a anular<input id="an-fecha" type="date" value="${e(fechaDefault || proximaFechaClase(clase))}"></label>
    <label>Motivo (opcional)<input id="an-motivo" placeholder="ej. fiesta, asuntos propios…"></label>
  </div>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">No, volver</button>
    <button class="btn peligro-solido" id="an-confirmar">Sí, anular la clase</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  document.getElementById('m-cancelar').onclick = () => modalDetalleClase(clase);
  document.getElementById('an-confirmar').onclick = async () => {
    const fecha = document.getElementById('an-fecha').value;
    if (!fecha) {
      document.getElementById('m-msg').textContent = 'Elige el día a anular.';
      return;
    }
    const yaAnulada = S.excepciones.some(x => x.clase_id === clase.id && x.fecha === fecha && x.tipo === 'anulada');
    if (yaAnulada) {
      document.getElementById('m-msg').textContent = 'Ese día ya está anulado.';
      return;
    }
    const { error } = await S.sb.from('clase_excepciones').insert({
      clase_id: clase.id,
      fecha,
      tipo: 'anulada',
      motivo: document.getElementById('an-motivo').value.trim() || null
    });
    if (error) {
      document.getElementById('m-msg').textContent = 'Error: ' + error.message;
      return;
    }
    cerrarModal();
    await cargarClases();
    if (S.vista === 'horario') renderHorario();
    if (S.vista === 'clases') renderClases();
    avisar(`Clase anulada el ${fmtFecha(fecha)}.`);
  };
}

// Ficha de una clase alternativa concreta, con botón para eliminarla.
function modalDetalleAlternativa(exc) {
  if (!exc) return;
  const clase = S.clases.find(c => c.id === exc.clase_id);
  const color = colorClase(clase || {});
  abrirModal(`
  <div class="detalle-cabecera" style="border-left: 5px solid ${color.borde}">
    <div>
      <h2>★ ${e(exc.nombre || clase?.nombre || 'Clase alternativa')}</h2>
      <p class="ayuda">Clase alternativa de <strong>${e(clase?.nombre || '')}</strong></p>
    </div>
  </div>
  <div class="detalle-horarios" style="margin-top:10px">
    <span class="horario-pastilla" style="background:${color.fondo}; border-color:${color.borde}">
      ${e(fmtFecha(exc.fecha))} · ${horaCorta(exc.hora)}–${horaFin(exc.hora, exc.duracion_min)}</span>
  </div>
  <div class="pie-modal">
    <button class="btn peligro-solido" id="alt-eliminar">Eliminar clase alternativa</button>
    <span class="flex1"></span>
    <button class="btn" id="alt-ver-clase">Ver la clase</button>
    <button class="btn liso" id="m-cancelar">Cerrar</button>
  </div>`);

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('alt-ver-clase').onclick = () => {
    cerrarModal();
    if (clase) modalDetalleClase(clase, exc.fecha);
  };
  document.getElementById('alt-eliminar').onclick = async () => {
    if (!confirm(`¿Eliminar la clase alternativa del ${fmtFecha(exc.fecha)} a las ${horaCorta(exc.hora)}?`)) return;
    await S.sb.from('clase_excepciones').delete().eq('id', exc.id);
    cerrarModal();
    await cargarClases();
    if (S.vista === 'horario') renderHorario();
    avisar('Clase alternativa eliminada.');
  };
}

// Añadir una sesión con horario alternativo en una fecha concreta.
function modalClaseAlternativa(fechaDefault) {
  const clases = clasesFiltradas();
  if (!clases.length) return avisar('Primero crea alguna clase.', true);
  abrirModal(`
  <h2>Clase con horario alternativo</h2>
  <p class="ayuda">Añade una sesión suelta en el día y hora que quieras (un cambio de horario,
  una recuperación…). Aparecerá en el horario y el calendario como <strong>alternativa</strong>.</p>
  <div class="grid2">
    <label>Clase<select id="al-clase">
      ${clases.map(c => `<option value="${c.id}">${e(c.nombre)}</option>`).join('')}
    </select></label>
    <label>Nombre para identificarla<input id="al-nombre"></label>
    <label>Día<input id="al-fecha" type="date" value="${e(fechaDefault || fechaISO(new Date()))}"></label>
    <label>Hora<input id="al-hora" type="time" value="17:00"></label>
    <label>Duración<select id="al-dur">
      ${[30, 45, 60, 90, 120].map(m => `<option value="${m}" ${m === 60 ? 'selected' : ''}>${m} min</option>`).join('')}
    </select></label>
  </div>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="al-guardar">Añadir al calendario</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  const $clase = document.getElementById('al-clase');
  const $nombre = document.getElementById('al-nombre');
  const ponerNombre = () => {
    const c = clases.find(x => x.id === $clase.value);
    $nombre.value = `${c?.nombre || ''} (cambio de horario)`;
  };
  $clase.onchange = ponerNombre;
  ponerNombre();

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('al-guardar').onclick = async () => {
    const fecha = document.getElementById('al-fecha').value;
    const hora = document.getElementById('al-hora').value;
    if (!fecha || !hora) {
      document.getElementById('m-msg').textContent = 'Día y hora son obligatorios.';
      return;
    }
    const { error } = await S.sb.from('clase_excepciones').insert({
      clase_id: $clase.value,
      fecha,
      tipo: 'extra',
      hora,
      duracion_min: Number(document.getElementById('al-dur').value),
      nombre: $nombre.value.trim() || null
    });
    if (error) {
      document.getElementById('m-msg').textContent = 'Error: ' + error.message;
      return;
    }
    cerrarModal();
    await cargarClases();
    renderHorario();
    avisar(`Clase alternativa añadida el ${fmtFecha(fecha)} a las ${hora}.`);
  };
}

function modalClase(clase) {
  const esAdmin = S.profesor?.es_admin;
  const c = clase || {};
  // Horarios y alumnos se editan en local y se guardan al final.
  const hs = (c.clase_horarios || []).map(h => ({
    dia_semana: h.dia_semana, hora: horaCorta(h.hora), duracion_min: h.duracion_min
  }));
  if (!hs.length) hs.push({ dia_semana: 1, hora: '17:00', duracion_min: 60 });
  const marcados = new Set((c.clase_alumnos || []).map(ca => ca.alumno_id));

  abrirModal(`
  <h2>${clase ? 'Editar clase' : 'Nueva clase'}</h2>
  <div class="grid2">
    <label>Nombre del grupo *<input id="c-nombre" value="${e(c.nombre || '')}" placeholder="ej. B1 tardes"></label>
    <label>Asignatura *<select id="c-asig">
      ${opcionesAsignaturas(c.profesor_id || S.profesor.id, c.asignatura_id)}
    </select></label>
    ${esAdmin ? `<label>Profesor<select id="c-prof">
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === (c.profesor_id || S.profesor.id) ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select></label>` : ''}
    <label>Notas<input id="c-notas" value="${e(c.notas || '')}"></label>
  </div>
  <h3 class="seccion">Color de la clase</h3>
  <div class="colores" id="c-colores">
    ${COLORES_CLASE.map(col => `<button type="button" class="color-swatch ${c.color === col ? 'elegido' : ''}"
      data-color="${col}" style="background:${col}" title="${col}"></button>`).join('')}
  </div>
  <h3 class="seccion">Días y horas</h3>
  <div id="c-horarios"></div>
  <button class="btn chico" id="c-add-horario">+ Añadir día</button>
  <h3 class="seccion">Alumnos apuntados</h3>
  <div id="c-alumnos" class="lista-alumnos"></div>
  <div class="pie-modal">
    ${clase ? '<button class="btn liso peligro" id="c-borrar">Borrar clase</button>' : ''}
    <span class="flex1"></span>
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="c-guardar">Guardar</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  const btnBorrar = document.getElementById('c-borrar');
  if (btnBorrar) btnBorrar.onclick = async () => {
    if (!confirm(`¿Borrar la clase "${clase.nombre}"? Los alumnos no se borran, solo el grupo.`)) return;
    const { error } = await S.sb.from('clases').delete().eq('id', clase.id);
    if (error) return avisar('Error al borrar: ' + error.message, true);
    cerrarModal();
    await cargarClases();
    renderClases();
    avisar('Clase borrada.');
  };

  const profesorActual = () => (esAdmin ? document.getElementById('c-prof').value : S.profesor.id);

  let colorSel = c.color || null;
  document.querySelectorAll('.color-swatch').forEach(sw => sw.onclick = () => {
    colorSel = sw.dataset.color;
    document.querySelectorAll('.color-swatch').forEach(x => x.classList.toggle('elegido', x === sw));
  });

  const pintarHorarios = () => {
    document.getElementById('c-horarios').innerHTML = hs.map((h, i) => `
      <div class="fila-horario">
        <select data-h-dia="${i}">
          ${DIAS.map((d, j) => `<option value="${j + 1}" ${h.dia_semana === j + 1 ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <input type="time" data-h-hora="${i}" value="${e(h.hora)}">
        <select data-h-dur="${i}">
          ${[30, 45, 60, 90, 120].map(m => `<option value="${m}" ${h.duracion_min === m ? 'selected' : ''}>${m} min</option>`).join('')}
        </select>
        <button class="btn chico liso" data-h-quitar="${i}" ${hs.length === 1 ? 'disabled' : ''}>✕</button>
      </div>`).join('');
    const cont = document.getElementById('c-horarios');
    cont.querySelectorAll('[data-h-dia]').forEach(s => s.onchange = () => { hs[Number(s.dataset.hDia)].dia_semana = Number(s.value); });
    cont.querySelectorAll('[data-h-hora]').forEach(s => s.onchange = () => { hs[Number(s.dataset.hHora)].hora = s.value; });
    cont.querySelectorAll('[data-h-dur]').forEach(s => s.onchange = () => { hs[Number(s.dataset.hDur)].duracion_min = Number(s.value); });
    cont.querySelectorAll('[data-h-quitar]').forEach(b => b.onclick = () => { hs.splice(Number(b.dataset.hQuitar), 1); pintarHorarios(); });
  };

  const pintarAlumnos = () => {
    const pid = profesorActual();
    const candidatos = S.alumnos.filter(a => a.estado === 'activo' && matriculasDeProfesor(a, pid).length > 0);
    document.getElementById('c-alumnos').innerHTML = candidatos.length === 0
      ? '<p class="ayuda">Este profesor no tiene alumnos activos en sus asignaturas todavía.</p>'
      : candidatos.map(a => `
        <label class="mes"><input type="checkbox" data-c-alumno="${a.id}" ${marcados.has(a.id) ? 'checked' : ''}>
        ${e(a.nombre)} <small>· ${e(matriculasDeProfesor(a, pid).map(m => m.asignaturas?.nombre).join(', '))}</small></label>`).join('');
    document.querySelectorAll('[data-c-alumno]').forEach(ch => ch.onchange = () => {
      if (ch.checked) marcados.add(ch.dataset.cAlumno);
      else marcados.delete(ch.dataset.cAlumno);
    });
  };

  pintarHorarios();
  pintarAlumnos();
  const selProf = document.getElementById('c-prof');
  if (selProf) selProf.onchange = () => {
    marcados.clear();
    pintarAlumnos();
    document.getElementById('c-asig').innerHTML = opcionesAsignaturas(selProf.value, null);
  };

  document.getElementById('c-add-horario').onclick = () => {
    hs.push({ dia_semana: 1, hora: '17:00', duracion_min: 60 });
    pintarHorarios();
  };
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('c-guardar').onclick = async () => {
    const nombre = document.getElementById('c-nombre').value.trim();
    if (!nombre) {
      document.getElementById('m-msg').textContent = 'El nombre del grupo es obligatorio.';
      return;
    }
    const fila = {
      nombre,
      asignatura_id: Number(document.getElementById('c-asig').value),
      profesor_id: profesorActual(),
      color: colorSel,
      notas: document.getElementById('c-notas').value.trim() || null
    };
    let claseId = clase?.id;
    let error;
    if (clase) ({ error } = await S.sb.from('clases').update(fila).eq('id', clase.id));
    else {
      const res = await S.sb.from('clases').insert(fila).select('id').single();
      error = res.error;
      claseId = res.data?.id;
    }
    if (error) {
      document.getElementById('m-msg').textContent = 'Error al guardar: ' + error.message;
      return;
    }
    // Reemplaza horarios y alumnos por lo que hay en el modal. Si la base de
    // datos detecta un choque de horario del mismo alumno con otra clase
    // (de cualquier profesor), rechaza el guardado y se muestra el motivo.
    const mostrarError = (err) => {
      document.getElementById('m-msg').textContent =
        err.message.startsWith('Conflicto de horario') ? '⚠ ' + err.message : 'Error al guardar: ' + err.message;
    };
    await S.sb.from('clase_horarios').delete().eq('clase_id', claseId);
    if (hs.length) {
      const { error: eh } = await S.sb.from('clase_horarios').insert(hs.map(h => ({ ...h, clase_id: claseId })));
      if (eh) return mostrarError(eh);
    }
    await S.sb.from('clase_alumnos').delete().eq('clase_id', claseId);
    if (marcados.size) {
      const { error: ea } = await S.sb.from('clase_alumnos').insert([...marcados].map(id => ({ clase_id: claseId, alumno_id: id })));
      if (ea) return mostrarError(ea);
    }
    cerrarModal();
    await cargarClases();
    renderClases();
    avisar(clase ? 'Clase actualizada.' : 'Clase creada.');
  };
}

// ---------------------------------------------------------------- horario semanal

function renderHorario() {
  const esAdmin = S.profesor?.es_admin;
  const clases = clasesFiltradas();
  const modo = S.horarioModo || 'semana';
  if (!S.mesVisto) {
    const hoy = new Date();
    S.mesVisto = { anio: hoy.getFullYear(), mes: hoy.getMonth() };
  }

  const sesiones = [];
  for (const c of clases) {
    for (const h of c.clase_horarios || []) sesiones.push({ ...h, clase: c });
  }

  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <div class="segmentos">
      <button class="seg ${modo === 'semana' ? 'activo' : ''}" data-modo="semana">Semana</button>
      <button class="seg ${modo === 'mes' ? 'activo' : ''}" data-modo="mes">Mes</button>
    </div>
    ${modo === 'mes' ? `
    <div class="mes-nav">
      <button class="btn chico liso" id="mes-ant">‹</button>
      <strong>${MESES[S.mesVisto.mes]} ${S.mesVisto.anio}</strong>
      <button class="btn chico liso" id="mes-sig">›</button>
    </div>` : ''}
    <span class="flex1"></span>
    ${esAdmin ? `<select id="fh-prof">
      <option value="">Todos los profesores</option>
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === S.filtros.profesor ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select>` : ''}
    <button class="btn" id="btn-alternativa">+ Clase alternativa</button>
  </div>
  ${sesiones.length === 0 ? `<div class="vacio">No hay clases con horario todavía.<br>
    <small>Crea grupos en la pestaña Clases y asígnales días y horas.</small></div>`
    : (modo === 'semana' ? htmlSemana(sesiones, esAdmin) : htmlMes(sesiones))}`;

  document.querySelectorAll('[data-modo]').forEach(b => b.onclick = () => {
    S.horarioModo = b.dataset.modo;
    renderHorario();
  });
  const fh = document.getElementById('fh-prof');
  if (fh) fh.onchange = (ev) => { S.filtros.profesor = ev.target.value; renderHorario(); };
  const ant = document.getElementById('mes-ant');
  if (ant) ant.onclick = () => {
    S.mesVisto.mes--;
    if (S.mesVisto.mes < 0) { S.mesVisto.mes = 11; S.mesVisto.anio--; }
    renderHorario();
  };
  const sig = document.getElementById('mes-sig');
  if (sig) sig.onclick = () => {
    S.mesVisto.mes++;
    if (S.mesVisto.mes > 11) { S.mesVisto.mes = 0; S.mesVisto.anio++; }
    renderHorario();
  };
  document.getElementById('btn-alternativa').onclick = () => modalClaseAlternativa();
  document.querySelectorAll('[data-ver-clase]').forEach(el => el.onclick = () =>
    modalDetalleClase(S.clases.find(c => c.id === el.dataset.verClase), el.dataset.fecha || undefined));
  document.querySelectorAll('[data-ver-alt]').forEach(el => el.onclick = () =>
    modalDetalleAlternativa(S.excepciones.find(x => x.id === el.dataset.verAlt)));
}

// Semana actual: columnas por día (con su fecha) con las clases ordenadas por
// hora. Marca las anuladas y añade las sesiones alternativas de la semana.
function htmlSemana(sesiones, esAdmin) {
  const anuladas = setAnuladas();
  const idsVisibles = new Set(clasesFiltradas().map(c => c.id));
  const lunes = new Date();
  lunes.setDate(lunes.getDate() - ((lunes.getDay() + 6) % 7));
  const fechas = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(lunes);
    d.setDate(lunes.getDate() + i);
    return d;
  });
  const hoyIso = fechaISO(new Date());

  const porDia = Array.from({ length: 7 }, () => []);
  for (const s of sesiones) porDia[s.dia_semana - 1].push(s);
  // Sesiones alternativas cuya fecha cae en esta semana
  for (const x of S.excepciones.filter(x => x.tipo === 'extra' && idsVisibles.has(x.clase_id))) {
    const idx = fechas.findIndex(f => fechaISO(f) === x.fecha);
    if (idx === -1) continue;
    const clase = S.clases.find(c => c.id === x.clase_id);
    if (clase) porDia[idx].push({ hora: x.hora, duracion_min: x.duracion_min, clase, extra: x });
  }
  porDia.forEach(d => d.sort((a, b) => String(a.hora).localeCompare(String(b.hora))));
  const dias = [0, 1, 2, 3, 4, ...(porDia[5].length ? [5] : []), ...(porDia[6].length ? [6] : [])];

  return `<div class="horario-grid" style="grid-template-columns: repeat(${dias.length}, 1fr)">
    ${dias.map(d => {
      const fecha = fechaISO(fechas[d]);
      return `
    <div class="dia-col ${fecha === hoyIso ? 'dia-hoy' : ''}">
      <div class="dia-titulo">${DIAS[d]} <span class="dia-num">${fechas[d].getDate()}</span></div>
      ${porDia[d].length === 0 ? '<div class="dia-libre">—</div>' : porDia[d].map(s => {
        const color = colorClase(s.clase);
        const n = (s.clase.clase_alumnos || []).length;
        const estaAnulada = !s.extra && anuladas.has(s.clase.id + '|' + fecha);
        return `
      <div class="clase-card ${estaAnulada ? 'anulada' : ''} ${s.extra ? 'alternativa' : ''}"
        ${s.extra ? `data-ver-alt="${s.extra.id}"` : `data-ver-clase="${s.clase.id}"`} data-fecha="${fecha}"
        style="background:${color.fondo}; border-left-color:${color.borde}">
        ${estaAnulada ? '<div class="etiqueta-anulada">ANULADA</div>' : ''}
        ${s.extra ? '<div class="etiqueta-alternativa">ALTERNATIVA</div>' : ''}
        <div class="clase-hora">${horaCorta(s.hora)}–${horaFin(s.hora, s.duracion_min)}</div>
        <div class="clase-nombre">${e(s.extra?.nombre || s.clase.nombre)}</div>
        <div class="clase-detalle">${e(s.clase.asignaturas?.nombre || '')} · ${n} alumno${n === 1 ? '' : 's'}</div>
        ${esAdmin && !S.filtros.profesor ? `<div class="clase-detalle">${e(s.clase.profesores?.nombre || '')}</div>` : ''}
      </div>`;
      }).join('')}
    </div>`;
    }).join('')}
  </div>`;
}

// Mes: calendario en cuadrados; las clases semanales se pintan en su día.
function htmlMes(sesiones) {
  const { anio, mes } = S.mesVisto;
  const primerDia = new Date(anio, mes, 1);
  const diasMes = new Date(anio, mes + 1, 0).getDate();
  const offset = (primerDia.getDay() + 6) % 7; // lunes = 0
  const hoy = new Date();

  const anuladas = setAnuladas();
  const idsVisibles = new Set(clasesFiltradas().map(c => c.id));
  const porDiaSemana = Array.from({ length: 7 }, () => []);
  for (const s of sesiones) porDiaSemana[s.dia_semana - 1].push(s);
  porDiaSemana.forEach(l => l.sort((a, b) => String(a.hora).localeCompare(String(b.hora))));

  const celdas = [];
  for (let i = 0; i < offset; i++) celdas.push('<div class="mes-celda vacia"></div>');
  for (let dia = 1; dia <= diasMes; dia++) {
    const dow = (new Date(anio, mes, dia).getDay() + 6) % 7;
    const fecha = fechaISO(new Date(anio, mes, dia));
    const esHoy = dia === hoy.getDate() && mes === hoy.getMonth() && anio === hoy.getFullYear();
    let eventos = porDiaSemana[dow].map(s => {
      const color = colorClase(s.clase);
      const estaAnulada = anuladas.has(s.clase.id + '|' + fecha);
      return `<div class="mes-evento ${estaAnulada ? 'anulada' : ''}" data-ver-clase="${s.clase.id}" data-fecha="${fecha}"
        style="background:${color.fondo}; border-left-color:${color.borde}"
        title="${e(s.clase.nombre)} · ${horaCorta(s.hora)}–${horaFin(s.hora, s.duracion_min)}${estaAnulada ? ' · ANULADA' : ''}">
        ${estaAnulada ? 'ANULADA · ' : ''}${horaCorta(s.hora)} ${e(s.clase.nombre)}</div>`;
    }).join('');
    // Sesiones alternativas de esta fecha concreta
    eventos += S.excepciones
      .filter(x => x.tipo === 'extra' && x.fecha === fecha && idsVisibles.has(x.clase_id))
      .map(x => {
        const clase = S.clases.find(c => c.id === x.clase_id);
        if (!clase) return '';
        const color = colorClase(clase);
        return `<div class="mes-evento alternativa" data-ver-alt="${x.id}" data-fecha="${fecha}"
          style="background:${color.fondo}; border-left-color:${color.borde}"
          title="${e(x.nombre || clase.nombre)} · ${horaCorta(x.hora)}–${horaFin(x.hora, x.duracion_min)} (alternativa)">
          ★ ${horaCorta(x.hora)} ${e(x.nombre || clase.nombre)}</div>`;
      }).join('');
    celdas.push(`<div class="mes-celda ${esHoy ? 'hoy' : ''}">
      <div class="mes-num">${dia}</div>${eventos}</div>`);
  }

  return `<div class="mes-grid">
    ${DIAS.map(d => `<div class="mes-diasem">${d}</div>`).join('')}
    ${celdas.join('')}
  </div>`;
}

// ---------------------------------------------------------------- recibos

function selectorMeses(idPrefijo) {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  return `
  <div class="meses">
    <label class="inline">Año <select id="${idPrefijo}-anio">
      ${[anio - 1, anio, anio + 1].map(a => `<option ${a === anio ? 'selected' : ''}>${a}</option>`).join('')}
    </select></label>
    <div class="meses-grid">
      ${MESES.map((m, i) => `<label class="mes"><input type="checkbox" data-mes="${i}" ${i === hoy.getMonth() ? 'checked' : ''}> ${m}</label>`).join('')}
    </div>
  </div>`;
}

function mesesMarcados(cont) {
  return [...cont.querySelectorAll('[data-mes]:checked')].map(c => MESES[Number(c.dataset.mes)]);
}

// Meses marcados en formato 'YYYY-MM' (para el control anti-recibo-repetido).
function periodosMarcados(cont, idPrefijo) {
  const anio = document.getElementById(`${idPrefijo}-anio`)?.value || new Date().getFullYear();
  return [...cont.querySelectorAll('[data-mes]:checked')]
    .map(c => `${anio}-${String(Number(c.dataset.mes) + 1).padStart(2, '0')}`);
}

function modalRecibo(alumno) {
  const todasMats = alumno.matriculas || [];
  const idsMias = new Set(misMatriculas(alumno).map(m => m.id));
  if (!todasMats.length) return avisar('Este alumno no tiene ninguna asignatura apuntada.', true);
  abrirModal(`
  <h2>Recibo — ${e(alumno.nombre)}</h2>
  <p class="ayuda">Marca las asignaturas a cobrar y los meses. El concepto y el importe se calculan
  solos y puedes ajustarlos. Si este mes ha hecho horas de más, apúntalas en "Extra".</p>
  <div class="detalle-horarios">
    ${todasMats.map(m => `<label class="mes"><input type="checkbox" data-mat="${m.id}" ${idsMias.has(m.id) ? 'checked' : ''}>
      ${e(m.asignaturas?.nombre || '')} · ${formatoImporte(m.tarifa)}€/${m.tipo_tarifa === 'clase' ? 'clase' : 'mes'}</label>`).join('')}
  </div>
  ${selectorMeses('r')}
  <div class="grid2">
    <label>Extra (€) — horas sueltas, material…
      <input id="r-extra" type="number" min="0" step="0.01" placeholder="0"></label>
    <label>Descripción del extra
      <input id="r-extra-desc" placeholder="ej. 2 horas extra"></label>
    <label>Concepto<input id="r-concepto"></label>
    <label>Importe total (€)<input id="r-importe" type="number" min="0" step="0.01"></label>
    <label>Recibí de<input id="r-recibide" value="${e(alumno.facturacion_nombre || alumno.tutor_nombre || alumno.nombre)}"></label>
    <label>Fecha de emisión<input id="r-fecha" value="${hoyDDMMAAAA()}"></label>
  </div>
  <p class="letras">La cantidad de: <strong id="r-letras"></strong>€</p>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="r-generar">Generar recibo PDF</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  const cont = document.querySelector('.modal');
  const $concepto = document.getElementById('r-concepto');
  const $importe = document.getElementById('r-importe');
  const $letras = document.getElementById('r-letras');
  const $extra = document.getElementById('r-extra');
  const $extraDesc = document.getElementById('r-extra-desc');

  const recalcular = () => {
    const meses = mesesMarcados(cont);
    const extra = Number($extra.value) || 0;
    const desc = $extraDesc.value.trim();
    $concepto.value = conceptoDesdeMeses(meses) + (extra && desc ? ' + ' + desc : '');
    // Base = suma de las matrículas marcadas (las de €/mes multiplican por meses)
    const marcadas = [...cont.querySelectorAll('[data-mat]:checked')]
      .map(ch => todasMats.find(m => m.id === ch.dataset.mat)).filter(Boolean);
    const base = marcadas.reduce((s, m) =>
      s + (m.tipo_tarifa === 'mes' ? Number(m.tarifa) * meses.length : Number(m.tarifa)), 0);
    $importe.value = base + extra || '';
    $letras.textContent = importeALetras($importe.value || 0);
  };
  cont.querySelectorAll('[data-mes]').forEach(c => c.onchange = recalcular);
  cont.querySelectorAll('[data-mat]').forEach(c => c.onchange = recalcular);
  $extra.oninput = recalcular;
  $extraDesc.oninput = recalcular;
  $importe.oninput = () => { $letras.textContent = importeALetras($importe.value || 0); };
  recalcular();

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('r-generar').onclick = async () => {
    const concepto = $concepto.value.trim();
    const importe = Number($importe.value);
    if (!concepto || !importe) {
      document.getElementById('m-msg').textContent = 'Concepto e importe son obligatorios.';
      return;
    }
    const btn = document.getElementById('r-generar');
    btn.disabled = true; btn.textContent = 'Generando…';
    try {
      const recibo = await crearRecibo(alumno, {
        concepto, importe,
        recibiDe: document.getElementById('r-recibide').value.trim() || alumno.nombre,
        fechaEmision: document.getElementById('r-fecha').value.trim() || hoyDDMMAAAA(),
        periodos: periodosMarcados(cont, 'r')
      });
      cerrarModal();
      await cargarRecibos();
      modalReciboListo(recibo);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Generar recibo PDF';
      document.getElementById('m-msg').textContent = 'Error: ' + err.message;
    }
  };
}

// Crea el recibo: fila en BD + PDF en disco. Devuelve la fila con datos del alumno.
async function crearRecibo(alumno, { concepto, importe, recibiDe, fechaEmision, periodos }) {
  const letras = importeALetras(importe);
  // La fecha del PDF (DD/MM/AAAA, editable) y la de la BD deben coincidir.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fechaEmision || '');
  const fechaIso = m ? `${m[3]}-${m[2]}-${m[1]}` : new Date().toISOString().slice(0, 10);
  const { data: fila, error } = await S.sb.from('recibos').insert({
    alumno_id: alumno.id,
    profesor_id: S.profesor.id, // quien emite el recibo
    fecha_emision: fechaIso,
    concepto,
    importe,
    importe_letras: letras,
    estado: 'pendiente',
    periodos: periodos && periodos.length ? periodos : null
  }).select('*').single();
  if (error) throw new Error(error.message);

  const referencia = 'R-' + String(fila.referencia).padStart(5, '0');
  const bytes = await generarReciboPdf({
    fechaEmision, recibiDe,
    cantidadLetras: letras,
    concepto,
    totalCifra: formatoImporte(importe),
    referencia,
    logoPngBase64: S.logoBase64
  });
  const filename = nombreArchivoRecibo(alumno.nombre, concepto);
  const pdfPath = await window.api.savePdf(Array.from(bytes), filename);
  await S.sb.from('recibos').update({ pdf_path: pdfPath }).eq('id', fila.id);
  return { ...fila, pdf_path: pdfPath, alumnos: alumno };
}

function modalReciboListo(recibo) {
  const tel = recibo.alumnos?.telefono || recibo.alumnos?.tutor_telefono;
  abrirModal(`
  <h2>Recibo generado ✓</h2>
  <p>${e(recibo.alumnos?.nombre || '')} — ${e(recibo.concepto)} — <strong>${formatoImporte(recibo.importe)}€</strong></p>
  <p class="ayuda">PDF guardado como <code>${e(recibo.pdf_path)}</code></p>
  <div class="pie-modal columna">
    <button class="btn" id="rl-abrir">Ver PDF</button>
    <button class="btn" id="rl-carpeta">Mostrar en carpeta</button>
    <button class="btn primario" id="rl-wa" ${tel ? '' : 'disabled title="El alumno no tiene teléfono registrado"'}>Enviar por WhatsApp</button>
    <button class="btn liso" id="m-cancelar">Cerrar</button>
  </div>
  <p class="ayuda">Al pulsar “Enviar por WhatsApp” se abre el chat con el mensaje escrito y la carpeta
  del PDF: arrastra el archivo al chat y envíalo.</p>`);
  document.getElementById('m-cancelar').onclick = () => { cerrarModal(); if (S.vista === 'recibos') renderRecibos(); };
  document.getElementById('rl-abrir').onclick = () => window.api.openPdf(recibo.pdf_path);
  document.getElementById('rl-carpeta').onclick = () => window.api.revealPdf(recibo.pdf_path);
  const wa = document.getElementById('rl-wa');
  if (tel) wa.onclick = () => enviarWhatsApp(recibo);
}

async function enviarWhatsApp(recibo) {
  const tel = recibo.alumnos?.telefono || recibo.alumnos?.tutor_telefono;
  const msg = `Hola, te adjunto el recibo de la Academia Curiosamente.\nConcepto: ${recibo.concepto}\nTotal: ${formatoImporte(recibo.importe)}€\n¡Gracias!`;
  const telWa = telefonoWa(tel);
  if (!telWa) return avisar('Teléfono no válido para WhatsApp.', true);
  // Asegura que el PDF está en este equipo antes de abrir el chat.
  let ruta = recibo.pdf_path;
  if (!(await window.api.pdfExists(ruta))) ruta = await regenerarPdf(recibo);
  await window.api.openWhatsApp(telWa, msg);
  await window.api.revealPdf(ruta);
  // El envío no cambia el estado: sigue pendiente hasta que se marque pagado.
  await S.sb.from('recibos').update({
    fecha_envio_whatsapp: new Date().toISOString()
  }).eq('id', recibo.id);
  await cargarRecibos();
  if (S.vista === 'recibos') renderRecibos();
  avisar('Chat de WhatsApp abierto. Arrastra el PDF al chat para enviarlo.');
}

function modalReciboBulk() {
  const candidatos = alumnosFiltrados().filter(a => a.estado === 'activo' && misMatriculas(a).length > 0);
  abrirModal(`
  <h2>Recibos del mes (en lote)</h2>
  <p class="ayuda">Genera el recibo de los meses marcados para los <strong>${candidatos.length}</strong> alumnos
  activos del listado con asignaturas tuyas (se cobra la suma de tus asignaturas; las de tarifa
  por clase se aplican tal cual, ajústalas luego si hace falta).</p>
  ${selectorMeses('b')}
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="b-generar">Generar ${candidatos.length} recibos</button>
  </div>
  <p id="m-msg" class="error"></p>`);
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('b-generar').onclick = async () => {
    const cont = document.querySelector('.modal');
    const meses = mesesMarcados(cont);
    if (!meses.length) {
      document.getElementById('m-msg').textContent = 'Marca al menos un mes.';
      return;
    }
    const concepto = conceptoDesdeMeses(meses);
    const btn = document.getElementById('b-generar');
    btn.disabled = true;
    let ok = 0, mal = 0;
    for (const a of candidatos) {
      btn.textContent = `Generando ${ok + mal + 1}/${candidatos.length}…`;
      try {
        const importe = misMatriculas(a).reduce((s, m) =>
          s + (m.tipo_tarifa === 'mes' ? Number(m.tarifa) * meses.length : Number(m.tarifa)), 0);
        await crearRecibo(a, {
          concepto, importe,
          recibiDe: a.facturacion_nombre || a.tutor_nombre || a.nombre,
          fechaEmision: hoyDDMMAAAA(),
          periodos: periodosMarcados(cont, 'b')
        });
        ok++;
      } catch { mal++; }
    }
    cerrarModal();
    await cargarRecibos();
    S.vista = 'recibos';
    renderMain();
    avisar(`Generados ${ok} recibos${mal ? `, ${mal} con error` : ''}. Los PDF están en la carpeta de recibos.`);
  };
}

// Regenera el PDF de un recibo a partir de sus datos y actualiza la ruta en la BD.
// Los recibos automáticos llegan sin el importe en letras: se completa aquí.
async function regenerarPdf(r) {
  let letras = r.importe_letras;
  if (!letras) {
    letras = importeALetras(r.importe);
    await S.sb.from('recibos').update({ importe_letras: letras }).eq('id', r.id);
  }
  const bytes = await generarReciboPdf({
    fechaEmision: (r.fecha_emision || '').split('-').reverse().join('/'),
    recibiDe: r.alumnos?.facturacion_nombre || r.alumnos?.tutor_nombre || r.alumnos?.nombre || '',
    cantidadLetras: letras,
    concepto: r.concepto,
    totalCifra: formatoImporte(r.importe),
    referencia: 'R-' + String(r.referencia).padStart(5, '0'),
    logoPngBase64: S.logoBase64
  });
  const ruta = await window.api.savePdf(Array.from(bytes), nombreArchivoRecibo(r.alumnos?.nombre || 'alumno', r.concepto));
  await S.sb.from('recibos').update({ pdf_path: ruta }).eq('id', r.id);
  await cargarRecibos();
  return ruta;
}

function recibosFiltrados() {
  const f = S.filtros;
  const t = (f.textoRecibo || '').toLowerCase();
  return S.recibos.filter(r =>
    (!t || (r.alumnos?.nombre || '').toLowerCase().includes(t) || (r.concepto || '').toLowerCase().includes(t)) &&
    (!f.profesor || r.profesor_id === f.profesor)
  );
}

function claveMes(fechaIso) {
  return String(fechaIso || '').slice(0, 7); // "2026-07"
}

function tituloMes(clave) {
  const [anio, mes] = clave.split('-').map(Number);
  return `${MESES[(mes || 1) - 1]} ${anio || ''}`;
}

function filasRecibos(lista, esAdmin, pagados) {
  return `<table>
    <thead><tr>
      <th>Alumno</th><th>Concepto</th><th>Total</th>
      ${esAdmin ? '<th>Profesor</th>' : ''}<th>Estado</th><th></th>
    </tr></thead>
    <tbody>
    ${lista.map(r => `<tr>
      <td><strong>${e(r.alumnos?.nombre || '')}</strong><br>
        <small>R-${String(r.referencia).padStart(5, '0')} · ${e((r.fecha_emision || '').split('-').reverse().join('/'))}</small></td>
      <td>${e(r.concepto)}</td>
      <td><strong>${formatoImporte(r.importe)}€</strong></td>
      ${esAdmin ? `<td>${e(r.profesores?.nombre || '')}</td>` : ''}
      <td><span class="chip ${r.estado}">${r.estado}</span>
        <span class="chip ${r.fecha_envio_whatsapp ? 'envio-si' : 'envio-no'}">${r.fecha_envio_whatsapp ? 'enviado' : 'por enviar'}</span></td>
      <td class="acciones">
        ${pagados
          ? `<button class="btn chico liso" data-despagar="${r.id}">↩ Pendiente</button>`
          : `<button class="btn chico pagar" data-pagar="${r.id}">✓ Pagado</button>
             <button class="btn chico liso" data-wa="${r.id}">WhatsApp</button>
             <button class="btn chico liso" data-editar-recibo="${r.id}" title="Editar recibo">✏️</button>`}
        <button class="btn chico liso" data-pdf="${r.id}">PDF</button>
        <button class="btn chico liso peligro" data-borrar-recibo="${r.id}" title="Eliminar recibo">✕</button>
      </td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderRecibos() {
  const esAdmin = S.profesor?.es_admin;
  const sub = S.vistaRecibos || 'pendientes';
  const lista = recibosFiltrados();
  const pendientes = lista.filter(r => r.estado !== 'pagado');
  const pagados = lista.filter(r => r.estado === 'pagado');

  let cuerpo = '';
  let selectorMesPagados = '';

  if (sub === 'pendientes') {
    // Agrupados por mes de emisión (el más reciente primero): si alguien lleva
    // varios meses sin pagar, se ve cada mes con sus recibos pendientes.
    const meses = [...new Set(pendientes.map(r => claveMes(r.fecha_emision)))].sort().reverse();
    cuerpo = pendientes.length === 0
      ? `<div class="vacio">No hay recibos pendientes. 🎉<br><small>Genera recibos desde la pestaña Alumnos.</small></div>`
      : meses.map(m => {
        const delMes = pendientes.filter(r => claveMes(r.fecha_emision) === m);
        const total = delMes.reduce((s, r) => s + Number(r.importe), 0);
        return `<h3 class="mes-seccion">${tituloMes(m)}
          <small>${delMes.length} pendiente${delMes.length === 1 ? '' : 's'} · ${formatoImporte(total)}€</small>
          <button class="btn chico" data-descargar-mes="${m}">⬇ Descargar todos los PDF</button></h3>
        ${filasRecibos(delMes, esAdmin, false)}`;
      }).join('');
  } else {
    const meses = [...new Set(pagados.map(r => claveMes(r.fecha_emision)))].sort().reverse();
    if (!S.mesPagados || !meses.includes(S.mesPagados)) S.mesPagados = meses[0] || '';
    const delMes = pagados.filter(r => claveMes(r.fecha_emision) === S.mesPagados);
    const total = delMes.reduce((s, r) => s + Number(r.importe), 0);
    selectorMesPagados = meses.length ? `<select id="fr-mes">
      ${meses.map(m => `<option value="${m}" ${m === S.mesPagados ? 'selected' : ''}>${tituloMes(m)}</option>`).join('')}
    </select>` : '';
    cuerpo = pagados.length === 0
      ? `<div class="vacio">Todavía no hay recibos pagados.</div>`
      : `<h3 class="mes-seccion">${tituloMes(S.mesPagados)}
          <small>${delMes.length} pagado${delMes.length === 1 ? '' : 's'} · ${formatoImporte(total)}€</small>
          <button class="btn chico" data-descargar-mes="${S.mesPagados}">⬇ Descargar todos los PDF</button></h3>
        ${filasRecibos(delMes, esAdmin, true)}`;
  }

  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <div class="segmentos">
      <button class="seg ${sub === 'pendientes' ? 'activo' : ''}" data-sub="pendientes">Pendientes${pendientes.length ? ` (${pendientes.length})` : ''}</button>
      <button class="seg ${sub === 'pagados' ? 'activo' : ''}" data-sub="pagados">Pagados</button>
    </div>
    ${selectorMesPagados}
    <input id="fr-texto" type="search" placeholder="Buscar por alumno o concepto…" value="${e(S.filtros.textoRecibo)}">
    ${esAdmin ? `<select id="fr-prof">
      <option value="">Todos los profesores</option>
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === S.filtros.profesor ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select>` : ''}
    <span class="flex1"></span>
    <button class="btn" id="fr-csv">Exportar CSV</button>
  </div>
  ${cuerpo}`;

  document.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => {
    S.vistaRecibos = b.dataset.sub;
    renderRecibos();
  });
  const fm = document.getElementById('fr-mes');
  if (fm) fm.onchange = (ev) => { S.mesPagados = ev.target.value; renderRecibos(); };
  document.getElementById('fr-texto').oninput = (ev) => { S.filtros.textoRecibo = ev.target.value; renderRecibos(); };
  const fp = document.getElementById('fr-prof');
  if (fp) fp.onchange = (ev) => { S.filtros.profesor = ev.target.value; renderRecibos(); };
  document.getElementById('fr-csv').onclick = exportarRecibosCsv;

  document.querySelectorAll('[data-pagar]').forEach(b => b.onclick = async () => {
    const r = S.recibos.find(x => x.id === b.dataset.pagar);
    if (!confirm(`¿Estás seguro de que quieres marcar como PAGADO el recibo de ${r?.alumnos?.nombre || 'este alumno'} (${formatoImporte(r?.importe || 0)}€, ${r?.concepto || ''})?`)) return;
    await S.sb.from('recibos').update({ estado: 'pagado', fecha_pago: new Date().toISOString() })
      .eq('id', b.dataset.pagar);
    await cargarRecibos();
    renderRecibos();
    avisar('Recibo marcado como pagado.');
  });
  document.querySelectorAll('[data-despagar]').forEach(b => b.onclick = async () => {
    const r = S.recibos.find(x => x.id === b.dataset.despagar);
    if (!confirm(`¿Estás seguro de que quieres volver a dejar PENDIENTE el recibo de ${r?.alumnos?.nombre || 'este alumno'} (${formatoImporte(r?.importe || 0)}€, ${r?.concepto || ''})?`)) return;
    await S.sb.from('recibos').update({ estado: 'pendiente', fecha_pago: null })
      .eq('id', b.dataset.despagar);
    await cargarRecibos();
    renderRecibos();
    avisar('Recibo devuelto a pendientes.');
  });
  document.querySelectorAll('[data-borrar-recibo]').forEach(b => b.onclick = async () => {
    const r = S.recibos.find(x => x.id === b.dataset.borrarRecibo);
    if (!confirm(`¿Eliminar el recibo R-${String(r.referencia).padStart(5, '0')} de ${r.alumnos?.nombre || ''} (${formatoImporte(r.importe)}€, ${r.concepto})? Esta acción no se puede deshacer.`)) return;
    const { error } = await S.sb.from('recibos').delete().eq('id', r.id);
    if (error) return avisar('Error al eliminar: ' + error.message, true);
    await cargarRecibos();
    renderRecibos();
    avisar('Recibo eliminado.');
  });
  document.querySelectorAll('[data-descargar-mes]').forEach(b => b.onclick = () => {
    const m = b.dataset.descargarMes;
    const lista = recibosFiltrados().filter(r => claveMes(r.fecha_emision) === m
      && (S.vistaRecibos === 'pagados' ? r.estado === 'pagado' : r.estado !== 'pagado'));
    descargarPdfsMes(m, lista, b);
  });
  document.querySelectorAll('[data-editar-recibo]').forEach(b => b.onclick = () =>
    modalEditarRecibo(S.recibos.find(x => x.id === b.dataset.editarRecibo)));
  document.querySelectorAll('[data-wa]').forEach(b => b.onclick = () => {
    const r = S.recibos.find(x => x.id === b.dataset.wa);
    enviarWhatsApp(r);
  });
  document.querySelectorAll('[data-pdf]').forEach(b => b.onclick = async () => {
    const r = S.recibos.find(x => x.id === b.dataset.pdf);
    const abierto = await window.api.openPdf(r.pdf_path);
    // Si el archivo no está en este equipo (o se borró), se regenera desde los datos.
    if (!abierto) {
      const ruta = await regenerarPdf(r);
      window.api.openPdf(ruta);
    }
  });
}

// Genera todos los PDFs de un mes en una carpeta propia (ej. "Julio 2026
// recibos academia"), lista para ir arrastrando los archivos a WhatsApp.
async function descargarPdfsMes(claveM, lista, boton) {
  if (!lista.length) return avisar('No hay recibos en ese mes.', true);
  const carpeta = `${tituloMes(claveM)} recibos academia`;
  const textoOriginal = boton.textContent;
  boton.disabled = true;
  let ok = 0;
  let primeraRuta = null;
  for (const r of lista) {
    boton.textContent = `Generando ${ok + 1}/${lista.length}…`;
    try {
      let letras = r.importe_letras;
      if (!letras) {
        letras = importeALetras(r.importe);
        await S.sb.from('recibos').update({ importe_letras: letras }).eq('id', r.id);
      }
      const bytes = await generarReciboPdf({
        fechaEmision: (r.fecha_emision || '').split('-').reverse().join('/'),
        recibiDe: r.alumnos?.facturacion_nombre || r.alumnos?.tutor_nombre || r.alumnos?.nombre || '',
        cantidadLetras: letras,
        concepto: r.concepto,
        totalCifra: formatoImporte(r.importe),
        referencia: 'R-' + String(r.referencia).padStart(5, '0'),
        logoPngBase64: S.logoBase64
      });
      const ruta = await window.api.savePdfLote(
        Array.from(bytes),
        nombreArchivoRecibo(r.alumnos?.nombre || 'alumno', r.concepto),
        carpeta
      );
      // El recibo apunta a este PDF: el botón WhatsApp abrirá esta carpeta.
      await S.sb.from('recibos').update({ pdf_path: ruta }).eq('id', r.id);
      if (!primeraRuta) primeraRuta = ruta;
      ok++;
    } catch { /* se salta y sigue con el resto */ }
  }
  boton.disabled = false;
  boton.textContent = textoOriginal;
  await cargarRecibos();
  renderRecibos();
  if (primeraRuta) window.api.revealPdf(primeraRuta);
  avisar(`${ok} PDF${ok === 1 ? '' : 's'} en la carpeta "${carpeta}" (ya abierta).`);
}

// Editar un recibo pendiente (ej. añadir horas extra antes de enviarlo).
function modalEditarRecibo(r) {
  const conceptoOriginal = r.concepto;
  const importeOriginal = Number(r.importe);
  abrirModal(`
  <h2>Editar recibo R-${String(r.referencia).padStart(5, '0')} — ${e(r.alumnos?.nombre || '')}</h2>
  <p class="ayuda">Añade el extra (se suma solo al importe y al concepto) o toca el concepto
  y el importe directamente. El PDF se rehace con los datos nuevos.</p>
  <div class="grid2">
    <label>Extra (€) — horas de más, material…
      <input id="er-extra" type="number" min="0" step="0.01" placeholder="0"></label>
    <label>Descripción del extra
      <input id="er-extra-desc" placeholder="ej. 2 horas extra"></label>
    <label>Concepto<input id="er-concepto" value="${e(r.concepto)}"></label>
    <label>Importe total (€)<input id="er-importe" type="number" min="0" step="0.01" value="${importeOriginal}"></label>
  </div>
  <p class="letras">La cantidad de: <strong id="er-letras"></strong>€</p>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="er-guardar">Guardar cambios</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  const $extra = document.getElementById('er-extra');
  const $desc = document.getElementById('er-extra-desc');
  const $concepto = document.getElementById('er-concepto');
  const $importe = document.getElementById('er-importe');
  const $letras = document.getElementById('er-letras');

  const desdeExtra = () => {
    const extra = Number($extra.value) || 0;
    const desc = $desc.value.trim();
    $importe.value = importeOriginal + extra || '';
    $concepto.value = conceptoOriginal + (extra && desc ? ' + ' + desc : '');
    $letras.textContent = importeALetras($importe.value || 0);
  };
  $extra.oninput = desdeExtra;
  $desc.oninput = desdeExtra;
  $importe.oninput = () => { $letras.textContent = importeALetras($importe.value || 0); };
  $letras.textContent = importeALetras(importeOriginal);

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('er-guardar').onclick = async () => {
    const concepto = $concepto.value.trim();
    const importe = Number($importe.value);
    if (!concepto || !importe) {
      document.getElementById('m-msg').textContent = 'Concepto e importe son obligatorios.';
      return;
    }
    const btn = document.getElementById('er-guardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    const { error } = await S.sb.from('recibos').update({
      concepto,
      importe,
      importe_letras: importeALetras(importe),
      pdf_path: null // el PDF viejo ya no vale: se regenera con los datos nuevos
    }).eq('id', r.id);
    if (error) {
      btn.disabled = false; btn.textContent = 'Guardar cambios';
      document.getElementById('m-msg').textContent = 'Error: ' + error.message;
      return;
    }
    await cargarRecibos();
    const actualizado = S.recibos.find(x => x.id === r.id);
    if (actualizado) await regenerarPdf(actualizado);
    cerrarModal();
    renderRecibos();
    avisar('Recibo actualizado y PDF regenerado.');
  };
}

async function exportarRecibosCsv() {
  const csv = aCsv(recibosFiltrados(), [
    { titulo: 'Referencia', valor: r => 'R-' + String(r.referencia).padStart(5, '0') },
    { titulo: 'Fecha emisión', valor: r => r.fecha_emision },
    { titulo: 'Alumno', valor: r => r.alumnos?.nombre },
    { titulo: 'Profesor', valor: r => r.profesores?.nombre },
    { titulo: 'Concepto', valor: r => r.concepto },
    { titulo: 'Importe', valor: r => r.importe },
    { titulo: 'Importe en letras', valor: r => r.importe_letras },
    { titulo: 'Estado', valor: r => r.estado },
    { titulo: 'Fecha de pago', valor: r => r.fecha_pago ? String(r.fecha_pago).slice(0, 10) : '' },
    { titulo: 'Enviado por WhatsApp', valor: r => r.fecha_envio_whatsapp }
  ]);
  const ruta = await window.api.saveCsv(csv, 'recibos_curiosamente.csv');
  if (ruta) avisar('CSV guardado en ' + ruta);
}

// ---------------------------------------------------------------- notas (pósits)

const COLORES_POSIT = ['#FFF59D', '#FFCC80', '#F8BBD0', '#C5E1A5', '#B3E5FC', '#E1BEE7'];

function renderNotas() {
  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <p class="ayuda">Apuntes rápidos, solo tuyos. Se guardan solos al dejar de escribir.</p>
    <span class="flex1"></span>
    <button class="btn primario" id="btn-nueva-nota">+ Añadir nota</button>
  </div>
  ${S.notas.length === 0 ? `<div class="vacio">No tienes notas.<br>
    <small>Crea la primera con “+ Añadir nota”.</small></div>` : `
  <div class="posits">
    ${S.notas.map(n => `
    <div class="posit" style="background:${e(n.color || COLORES_POSIT[0])}">
      <button class="posit-borrar" data-borrar-nota="${n.id}" title="Borrar nota">✕</button>
      <textarea data-nota="${n.id}" placeholder="Escribe aquí…">${e(n.texto)}</textarea>
      <div class="posit-fecha">${e(String(n.created_at).slice(0, 10).split('-').reverse().join('/'))}</div>
    </div>`).join('')}
  </div>`}`;

  document.getElementById('btn-nueva-nota').onclick = async () => {
    const color = COLORES_POSIT[Math.floor(Math.random() * COLORES_POSIT.length)];
    const { error } = await S.sb.from('notas').insert({ profesor_id: S.profesor.id, texto: '', color });
    if (error) return avisar('Error al crear la nota: ' + error.message, true);
    await cargarNotas();
    renderNotas();
    document.querySelector('.posit textarea')?.focus();
  };

  document.querySelectorAll('[data-nota]').forEach(t => {
    // Guardado automático al dejar de escribir (1 s) o al salir del pósit.
    let temporizador;
    const guardar = async () => {
      const nota = S.notas.find(n => n.id === t.dataset.nota);
      if (!nota || nota.texto === t.value) return;
      nota.texto = t.value;
      await S.sb.from('notas').update({ texto: t.value }).eq('id', t.dataset.nota);
    };
    t.oninput = () => { clearTimeout(temporizador); temporizador = setTimeout(guardar, 1000); };
    t.onblur = () => { clearTimeout(temporizador); guardar(); };
  });

  document.querySelectorAll('[data-borrar-nota]').forEach(b => b.onclick = async () => {
    const nota = S.notas.find(n => n.id === b.dataset.borrarNota);
    if (nota?.texto.trim() && !confirm('¿Borrar esta nota?')) return;
    await S.sb.from('notas').delete().eq('id', b.dataset.borrarNota);
    await cargarNotas();
    renderNotas();
  });
}

// ---------------------------------------------------------------- profesores (solo admin)

function profesoresActivos() {
  return S.profesores.filter(p => p.estado !== 'baja');
}

function renderProfesores() {
  if (!S.profesor?.es_admin) return renderAjustes();
  const sub = S.vistaProfes || 'activos';
  const lista = S.profesores.filter(p => (sub === 'baja' ? p.estado === 'baja' : p.estado !== 'baja'));
  const nBajas = S.profesores.filter(p => p.estado === 'baja').length;
  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <div class="segmentos">
      <button class="seg ${sub === 'activos' ? 'activo' : ''}" data-sub-prof="activos">Activos</button>
      <button class="seg ${sub === 'baja' ? 'activo' : ''}" data-sub-prof="baja">Baja${nBajas ? ` (${nBajas})` : ''}</button>
    </div>
    <p class="ayuda">${sub === 'baja'
      ? 'Sin acceso a la app. Sus recibos, clases y datos se conservan.'
      : 'Profesores con acceso a la app. Cada uno ve solo sus asignaturas.'}</p>
    <span class="flex1"></span>
    <button class="btn primario" id="btn-nuevo-prof">+ Nuevo profesor</button>
  </div>
  ${lista.length === 0 ? `<div class="vacio">${sub === 'baja' ? 'No hay profesores de baja.' : 'No hay profesores.'}</div>` : `
  <table>
    <thead><tr><th>Profesor</th><th>Email de acceso</th><th>Asignaturas</th><th></th></tr></thead>
    <tbody>
    ${lista.map(p => {
      const asigs = S.profAsig.filter(x => x.profesor_id === p.id)
        .map(x => S.asignaturas.find(a => a.id === x.asignatura_id))
        .filter(Boolean);
      return `<tr class="${p.estado === 'baja' ? 'apagado' : ''}">
      <td><strong>${e(p.nombre)}</strong>${p.es_admin ? ' <span class="chip activo">admin</span>' : ''}
        ${p.estado === 'baja' ? ' <span class="chip baja">baja</span>' : ''}</td>
      <td>${e(p.email)}</td>
      <td>${p.es_admin ? '<small>Todas (administrador)</small>'
        : asigs.map(a => {
          const c = colorArea(a.nombre);
          return `<span class="chip-asig" style="background:${c.fondo}; border-left:3px solid ${c.borde}">${e(a.nombre)}</span>`;
        }).join(' ') || '<small>Sin asignaturas (ve todas)</small>'}</td>
      <td class="acciones">
        ${p.estado === 'baja'
          ? `<button class="btn chico" data-reactivar-prof="${p.id}">Reactivar</button>`
          : (p.id !== S.profesor.id && !p.es_admin
            ? `<button class="btn chico liso" data-editar-prof="${p.id}">Editar</button>` : '')}
      </td>
    </tr>`;
    }).join('')}
    </tbody>
  </table>`}`;

  document.querySelectorAll('[data-sub-prof]').forEach(b => b.onclick = () => {
    S.vistaProfes = b.dataset.subProf;
    renderProfesores();
  });
  document.getElementById('btn-nuevo-prof').onclick = () => modalNuevoProfesor();
  document.querySelectorAll('[data-editar-prof]').forEach(b =>
    b.onclick = () => modalEditarProfesor(S.profesores.find(p => p.id === b.dataset.editarProf)));
  document.querySelectorAll('[data-reactivar-prof]').forEach(b => b.onclick = async () => {
    const p = S.profesores.find(x => x.id === b.dataset.reactivarProf);
    if (!confirm(`¿Reactivar a ${p.nombre}? Recuperará su acceso a la app con su misma contraseña.`)) return;
    const { error } = await S.sb.rpc('cambiar_estado_profesor', { p_profesor: p.id, p_estado: 'activo' });
    if (error) return avisar('Error: ' + error.message, true);
    await cargarTodo();
    renderProfesores();
    avisar(`${p.nombre} reactivado: ya puede entrar de nuevo.`);
  });
}

function emailSugerido(nombre) {
  const limpio = String(nombre || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
  return limpio ? limpio + '@curiosamente.es' : '';
}

function passwordSugerida() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let p = '';
  const azar = new Uint32Array(10);
  crypto.getRandomValues(azar);
  for (const n of azar) p += letras[n % letras.length];
  return p + '!';
}

function checkboxesAsignaturas(marcadas = new Set()) {
  return S.asignaturas.map(a => {
    const c = colorArea(a.nombre);
    return `<label class="mes" style="border-left:3px solid ${c.borde}">
      <input type="checkbox" data-p-asig="${a.id}" ${marcadas.has(a.id) ? 'checked' : ''}> ${e(a.nombre)}</label>`;
  }).join('');
}

function asignaturasMarcadas() {
  return [...document.querySelectorAll('[data-p-asig]:checked')].map(ch => Number(ch.dataset.pAsig));
}

// Bloque de checkboxes + creación de asignaturas nuevas (para el alta/edición
// de profesores): así una materia nueva no tiene que "compartirse" con nadie.
function bloqueAsignaturas(marcadas = new Set()) {
  return `
  <div class="lista-alumnos" id="p-asigs">${checkboxesAsignaturas(marcadas)}</div>
  <div class="fila-horario" style="margin-top:8px">
    <input id="p-nueva-asig" placeholder="¿Materia nueva? ej. Latín — clases particulares">
    <button type="button" class="btn chico" id="p-crear-asig">+ Crear asignatura</button>
  </div>`;
}

function activarCreacionAsignatura() {
  const $in = document.getElementById('p-nueva-asig');
  const crear = async () => {
    const nombre = $in.value.trim();
    if (!nombre) return;
    const marcadasAhora = new Set(asignaturasMarcadas());
    const { data, error } = await S.sb.from('asignaturas').insert({ nombre }).select('*').single();
    if (error) {
      document.getElementById('m-msg').textContent =
        error.code === '23505' || /duplicate/.test(error.message)
          ? 'Ya existe una asignatura con ese nombre.'
          : 'Error al crear la asignatura: ' + error.message;
      return;
    }
    document.getElementById('m-msg').textContent = '';
    S.asignaturas.push(data);
    marcadasAhora.add(data.id); // la nueva queda marcada para este profesor
    document.getElementById('p-asigs').innerHTML = checkboxesAsignaturas(marcadasAhora);
    $in.value = '';
    avisar(`Asignatura "${data.nombre}" creada y marcada.`);
  };
  document.getElementById('p-crear-asig').onclick = crear;
  $in.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); crear(); } };
}

function modalNuevoProfesor() {
  abrirModal(`
  <h2>Nuevo profesor</h2>
  <p class="ayuda">Se crea su usuario con el email de la academia y su contraseña, y podrá entrar
  desde cualquier equipo. Solo verá los alumnos y clases de sus asignaturas.</p>
  <div class="grid2">
    <label>Nombre *<input id="p-nombre" placeholder="ej. Lucía"></label>
    <label>Email de acceso *<input id="p-email" placeholder="lucia@curiosamente.es"></label>
    <label>Contraseña * (mín. 8)<input id="p-pass" value="${e(passwordSugerida())}"></label>
  </div>
  <h3 class="seccion">Asignaturas que imparte *</h3>
  ${bloqueAsignaturas()}
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="p-crear">Crear profesor</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  activarCreacionAsignatura();
  const $nombre = document.getElementById('p-nombre');
  const $email = document.getElementById('p-email');
  let emailTocado = false;
  $email.oninput = () => { emailTocado = true; };
  $nombre.oninput = () => { if (!emailTocado) $email.value = emailSugerido($nombre.value); };

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('p-crear').onclick = async () => {
    const nombre = $nombre.value.trim();
    const email = $email.value.trim().toLowerCase();
    const pass = document.getElementById('p-pass').value;
    const asigs = asignaturasMarcadas();
    const btn = document.getElementById('p-crear');
    btn.disabled = true; btn.textContent = 'Creando…';
    const { error } = await S.sb.rpc('crear_profesor', {
      p_nombre: nombre, p_email: email, p_password: pass, p_asignaturas: asigs
    });
    if (error) {
      btn.disabled = false; btn.textContent = 'Crear profesor';
      document.getElementById('m-msg').textContent = error.message;
      return;
    }
    cerrarModal();
    await cargarTodo();
    renderMain();
    abrirModal(`
    <h2>Profesor creado ✓</h2>
    <p>Apunta y entrégale sus credenciales de acceso:</p>
    <p class="letras">Email: <strong>${e(email)}</strong><br>Contraseña: <strong>${e(pass)}</strong></p>
    <p class="ayuda">Podrá entrar desde cualquier equipo de la academia con estos datos.</p>
    <div class="pie-modal"><button class="btn primario" id="m-cancelar">Entendido</button></div>`);
    document.getElementById('m-cancelar').onclick = cerrarModal;
  };
}

function modalEditarProfesor(prof) {
  const marcadas = new Set(S.profAsig.filter(x => x.profesor_id === prof.id).map(x => x.asignatura_id));
  abrirModal(`
  <h2>Editar — ${e(prof.nombre)}</h2>
  <p class="ayuda">${e(prof.email)}</p>
  <h3 class="seccion">Asignaturas que imparte</h3>
  ${bloqueAsignaturas(marcadas)}
  <h3 class="seccion">Cambiar contraseña (opcional)</h3>
  <label>Nueva contraseña (mín. 8; en blanco = no cambiar)<input id="p-pass"></label>
  <div class="pie-modal">
    <button class="btn liso peligro" id="p-baja">Dar de baja</button>
    <span class="flex1"></span>
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="p-guardar">Guardar</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  activarCreacionAsignatura();
  document.getElementById('p-baja').onclick = async () => {
    if (!confirm(`¿Dar de baja a ${prof.nombre}? No podrá volver a entrar en la app hasta que lo reactives. Sus recibos, clases y datos se conservan.`)) return;
    const { error } = await S.sb.rpc('cambiar_estado_profesor', { p_profesor: prof.id, p_estado: 'baja' });
    if (error) {
      document.getElementById('m-msg').textContent = 'Error: ' + error.message;
      return;
    }
    cerrarModal();
    await cargarTodo();
    S.vistaProfes = 'baja';
    renderProfesores();
    avisar(`${prof.nombre} dado de baja: su acceso queda bloqueado.`);
  };

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('p-guardar').onclick = async () => {
    const asigs = asignaturasMarcadas();
    if (!asigs.length) {
      document.getElementById('m-msg').textContent = 'Elige al menos una asignatura.';
      return;
    }
    await S.sb.from('profesor_asignaturas').delete().eq('profesor_id', prof.id);
    const { error } = await S.sb.from('profesor_asignaturas')
      .insert(asigs.map(id => ({ profesor_id: prof.id, asignatura_id: id })));
    if (error) {
      document.getElementById('m-msg').textContent = 'Error: ' + error.message;
      return;
    }
    const pass = document.getElementById('p-pass').value;
    if (pass) {
      const { error: ep } = await S.sb.rpc('cambiar_password_profesor', { p_profesor: prof.id, p_password: pass });
      if (ep) {
        document.getElementById('m-msg').textContent = 'Asignaturas guardadas, pero la contraseña falló: ' + ep.message;
        return;
      }
    }
    cerrarModal();
    await cargarTodo();
    renderProfesores();
    avisar('Profesor actualizado.');
  };
}

// ---------------------------------------------------------------- ajustes

async function renderAjustes() {
  const dir = await window.api.getRecibosDir();
  document.getElementById('contenido').innerHTML = `
  <div class="tarjeta ajustes">
    <h2>Ajustes</h2>
    <h3>Carpeta de recibos</h3>
    <p class="ayuda">Los PDF se guardan en:<br><code>${e(dir)}</code></p>
    <button class="btn" id="aj-carpeta">Cambiar carpeta…</button>

    <h3>Copia de seguridad</h3>
    <p class="ayuda">Los datos viven en Supabase (nube), compartidos por todos los equipos de la academia.
    Además, cada día al abrir la app se guarda automáticamente una copia local en
    <code>Documentos\\Curiosamente\\Backups</code> (se conservan las 30 últimas), y puedes exportar
    un CSV cuando quieras desde las pestañas Alumnos y Recibos.</p>

    ${S.profesor?.es_admin ? `
    <h3>Conexión (solo administrador)</h3>
    <p class="ayuda">Proyecto: <code>${e(S.cfg.supabaseUrl || '')}</code></p>
    <button class="btn liso" id="aj-reconf">Cambiar datos de conexión…</button>` : ''}
  </div>`;
  document.getElementById('aj-carpeta').onclick = async () => {
    const nuevo = await window.api.chooseRecibosDir();
    if (nuevo) { avisar('Carpeta cambiada.'); renderAjustes(); }
  };
  const reconf = document.getElementById('aj-reconf');
  if (reconf) reconf.onclick = () => renderSetup();
}

// ---------------------------------------------------------------- modal y toast

function abrirModal(html) {
  document.getElementById('modal-raiz').innerHTML =
    `<div class="velo"><div class="modal">${html}</div></div>`;
  document.querySelector('.velo').onclick = (ev) => { if (ev.target.classList.contains('velo')) cerrarModal(); };
}

function cerrarModal() {
  document.getElementById('modal-raiz').innerHTML = '';
}

let toastTimer;
function avisar(texto, esError = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = texto;
  t.className = 'visible' + (esError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 4500);
}

init();
