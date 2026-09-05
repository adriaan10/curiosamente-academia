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
  profesorHorario: [],
  cambiosHorario: [],
  reactivaciones: [],
  bajasAsignatura: [],
  avisosDescartados: [],
  finanzas: [],
  finanzasCategorias: [],
  cuentasSaldoInicial: [],
  vista: 'inicio',
  vistaRecibos: 'pendientes',
  mesRecibos: '',
  recibosSeleccionados: new Set(),
  vistaRosterRecibos: false,
  filtros: { texto: '', asignatura: '', estado: 'activo', profesor: '', textoRecibo: '' },
  logoBase64: null,
  actualizacionPendiente: null
};

const $app = () => document.getElementById('app');
const e = escapeHtml;

// ---------------------------------------------------------------- arranque

async function init() {
  // Aviso de "sin conexión" ya desde el login: si no hay adaptador de red
  // en absoluto, es instantáneo. La vuelta a "conectado" NO se decide aquí
  // (puede haber wifi sin internet de verdad) — de eso se encarga el canal
  // de tiempo real, ver iniciarTiempoReal().
  window.addEventListener('offline', marcarDesconectado);
  window.addEventListener('online', () => { /* solo informativo; la reconexión real la confirma el canal */ });

  // Si ya hay una versión descargada esperando (el proceso principal la
  // recuerda aunque haya terminado antes de que esta ventana cargara), se
  // avisa antes que nada; si llega mientras se usa la app, el aviso salta en
  // cuanto llegue (o al cerrar un modal que estuviera abierto, ver cerrarModal).
  window.api.onActualizacionLista((version) => avisoActualizacionPendiente(version));
  const yaLista = await window.api.getActualizacionPendiente();
  if (yaLista) return avisoActualizacionPendiente(yaLista);

  S.cfg = await window.api.getConfig();
  S.logoBase64 = await window.api.getLogo();
  if (!S.cfg.supabaseUrl || !S.cfg.supabaseKey) return renderSetup();
  S.sb = createClient(S.cfg.supabaseUrl, S.cfg.supabaseKey);
  // Nuevo cliente (o venimos de reconfigurar la conexión en Ajustes): el canal
  // en tiempo real anterior, si había, quedaba atado al cliente viejo.
  canalTiempoReal = null;
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
  // Si esta consulta falla justo al entrar (un hipo de red puntual), no se
  // sigue con un perfil vacío — se vuelve al login y se puede reintentar,
  // en vez de arrastrar una sesión a medio cargar por el resto de la app.
  if (prof.error) {
    renderLogin();
    setTimeout(() => {
      const m = document.getElementById('msg');
      if (m) m.textContent = 'No se pudo cargar tu perfil (' + prof.error.message + '). Inténtalo de nuevo.';
    }, 0);
    throw new Error('error cargando perfil');
  }
  S.profesor = prof.data;
  // Si el profesor fue dado de baja con la sesión aún abierta, se le expulsa.
  if (S.profesor?.estado === 'baja') {
    detenerTiempoReal();
    detenerControlInactividad();
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
  if (profs.error) avisar('Error cargando profesores: ' + profs.error.message, true);
  else S.profesores = profs.data || [];
  if (asigs.error) avisar('Error cargando asignaturas: ' + asigs.error.message, true);
  else S.asignaturas = asigs.data || [];
  if (profAsig.error) avisar('Error cargando asignaturas de profesor: ' + profAsig.error.message, true);
  else S.profAsig = profAsig.data || [];
  await Promise.all([
    cargarAlumnos(), cargarRecibos(), cargarClases(), cargarNotas(),
    cargarHorarioTrabajo(), cargarCambiosHorario(), cargarReactivaciones(), cargarBajasAsignatura(),
    cargarFinanzas(), cargarFinanzasCategorias(), cargarCuentasSaldoInicial(), cargarAvisosDescartados()
  ]);
  backupAutomatico();
  window.api.getRecibosDir(); // crea la carpeta de recibos de este equipo si no existía aún
  iniciarTiempoReal();
  iniciarControlInactividad();
}

// ---------------------------------------------------------------- tiempo real
//
// La app carga los datos una vez al iniciar sesión; sin esto, un cambio hecho
// en otro ordenador no se vería hasta cerrar y volver a abrir. Aquí nos
// suscribimos a los cambios de Supabase en las tablas compartidas y, cuando
// llega uno, recargamos y repintamos solos.
//
// No se aplican parches fila a fila (sería mucho más código y más frágil,
// sobre todo con las tablas que se cruzan entre sí como alumnos+matrículas o
// clases+horarios+inscritos): al llegar cualquier cambio, se recarga todo de
// golpe. Con los tamaños de datos de una academia esto es prácticamente
// instantáneo, así que no compensa la complejidad de ir más fino.
const TABLAS_TIEMPO_REAL = [
  'alumnos', 'matriculas', 'clases', 'clase_horarios', 'clase_alumnos', 'clase_excepciones',
  'recibos', 'notas', 'profesor_horario', 'cambios_horario', 'reactivaciones_alumno', 'bajas_asignatura',
  'finanzas_movimientos', 'finanzas_categorias', 'profesores', 'asignaturas', 'profesor_asignaturas',
  'cuentas_saldo_inicial', 'avisos_descartados'
];

let canalTiempoReal = null;
let timerRecargaTiempoReal = null;

// Aviso de Inicio actualmente mostrado en un modal (fichas sin precio,
// cambios de horario, altas fuera de fecha, reactivaciones, bajas de
// asignatura) — { tipo, ids } — o null si no hay ninguno abierto. Lo limpia
// abrirModal() en cuanto se abre CUALQUIER otro modal (ver más abajo).
let avisoAbierto = null;

function iniciarTiempoReal() {
  if (canalTiempoReal) return; // ya está en marcha, no crear otro canal duplicado
  let canal = S.sb.channel('cambios-academia');
  for (const tabla of TABLAS_TIEMPO_REAL) {
    canal = canal.on('postgres_changes', { event: '*', schema: 'public', table: tabla }, programarRecargaTiempoReal);
  }
  // Aviso instantáneo de actualización: en cuanto se publica una versión
  // nueva se cambia esta fila (a mano, no desde la app), y todas las
  // sesiones abiertas lo notan al momento y comprueban ya la actualización,
  // en vez de esperar a que alguien cierre y vuelva a abrir la app.
  canal = canal.on('postgres_changes', { event: '*', schema: 'public', table: 'app_version' },
    () => window.api.comprobarActualizacionesAhora());
  // El estado de este canal es también la señal de "hay conexión de verdad
  // con Supabase" (no solo con la red local) para la pantalla de "Sin
  // conexión": la librería reconecta sola con reintentos, así que basta con
  // escuchar cuándo lo consigue o lo pierde, sin sondear nada por nuestra cuenta.
  canal.subscribe((status) => {
    if (status === 'SUBSCRIBED') marcarConectado();
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') marcarDesconectado();
  });
  canalTiempoReal = canal;
}

function detenerTiempoReal() {
  if (canalTiempoReal) S.sb.removeChannel(canalTiempoReal);
  canalTiempoReal = null;
  clearTimeout(timerRecargaTiempoReal);
}

// Cierra la sesión sola si nadie toca nada durante 20 minutos, para no
// dejar la app abierta indefinidamente en un ordenador compartido.
const INACTIVIDAD_MS = 20 * 60 * 1000;
const EVENTOS_ACTIVIDAD = ['mousemove', 'keydown', 'click', 'scroll'];
let timerInactividad = null;

function reiniciarTimerInactividad() {
  clearTimeout(timerInactividad);
  timerInactividad = setTimeout(() => cerrarSesion('Sesión cerrada por inactividad.'), INACTIVIDAD_MS);
}
function iniciarControlInactividad() {
  EVENTOS_ACTIVIDAD.forEach(ev => document.addEventListener(ev, reiniciarTimerInactividad));
  reiniciarTimerInactividad();
}
function detenerControlInactividad() {
  clearTimeout(timerInactividad);
  EVENTOS_ACTIVIDAD.forEach(ev => document.removeEventListener(ev, reiniciarTimerInactividad));
}

// Varios cambios pueden llegar seguidos (ej. un envío de recibos en lote): se
// agrupan en una sola recarga en vez de una por cada aviso.
function programarRecargaTiempoReal() {
  clearTimeout(timerRecargaTiempoReal);
  timerRecargaTiempoReal = setTimeout(recargarTrasCambioRemoto, 400);
}

async function recargarTrasCambioRemoto() {
  const [profs, asigs, profAsig] = await Promise.all([
    S.sb.from('profesores').select('*').order('nombre'),
    S.sb.from('asignaturas').select('*').order('id'),
    S.sb.from('profesor_asignaturas').select('*'),
    cargarAlumnos(), cargarRecibos(), cargarClases(), cargarNotas(),
    cargarHorarioTrabajo(), cargarCambiosHorario(), cargarReactivaciones(), cargarBajasAsignatura(),
    cargarFinanzas(), cargarFinanzasCategorias(), cargarCuentasSaldoInicial(), cargarAvisosDescartados()
  ]);
  // Si alguna de estas tres falla (un hipo de red, el token de sesión
  // renovándose justo en ese momento…) no se pisa lo que ya había: hacerlo
  // sin comprobar el error es lo que provocaba que, tras dejar la app
  // abierta un rato, "desaparecieran" los profesores (o asignaturas) de la
  // pantalla hasta el siguiente cambio en tiempo real.
  if (profs.error) avisar('Error recargando profesores: ' + profs.error.message, true);
  else S.profesores = profs.data || [];
  if (asigs.error) avisar('Error recargando asignaturas: ' + asigs.error.message, true);
  else S.asignaturas = asigs.data || [];
  if (profAsig.error) avisar('Error recargando asignaturas de profesor: ' + profAsig.error.message, true);
  else S.profAsig = profAsig.data || [];

  // La lista de profesores ya incluye la propia fila: se actualiza S.profesor
  // con ella para que un cambio hecho por otra persona (quitar admin, quitar
  // asignaturas, marcar de baja…) se note en la propia sesión ya abierta, sin
  // esperar a un cierre y apertura. Si a alguien lo dan de baja mientras
  // tiene la app abierta, se le expulsa igual que al iniciar sesión.
  if (!profs.error && S.profesor) {
    const propia = S.profesores.find(p => p.id === S.profesor.id);
    if (propia?.estado === 'baja') {
      detenerTiempoReal();
      detenerControlInactividad();
      await S.sb.auth.signOut();
      S.session = null;
      S.profesor = null;
      renderLogin();
      setTimeout(() => {
        const m = document.getElementById('msg');
        if (m) m.textContent = 'Tu acceso está desactivado. Habla con la academia.';
      }, 0);
      return;
    }
    // Un cambio de es_admin a mitad de sesión deja desactualizado demasiado
    // (finanzas cargadas o no, gestión de profesores visible o no...) para
    // parchearlo en caliente: mejor forzar un reinicio limpio, como con la
    // baja de arriba, en vez de arriesgarse a que la app se quede rara.
    if (propia && propia.es_admin !== S.profesor.es_admin) {
      const esAdminNuevo = propia.es_admin;
      detenerTiempoReal();
      detenerControlInactividad();
      mostrarPantallaReinicioAdmin(esAdminNuevo);
      return;
    }
    if (propia) S.profesor = propia;
  }

  // No interrumpir con un repintado completo si hay una ficha/modal abierta:
  // se vería la pantalla de golpe y se perdería lo que se estuviera editando.
  // Excepción: un aviso de Inicio (fichas sin precio, cambios de horario...)
  // abierto en modal SÍ se refresca en su sitio — es solo una lista de
  // solo-lectura + botones, sin nada que se pueda estar escribiendo, y así
  // un admin no se queda mirando una fila ya resuelta por el otro sin saberlo.
  const modal = document.getElementById('modal-raiz');
  if (modal && modal.innerHTML.trim()) {
    refrescarAvisoAbierto();
    return;
  }
  renderVistaActual();
}

async function cargarCambiosHorario() {
  // profesores!profesor_id: ahora que la tabla tiene una SEGUNDA FK a
  // profesores (visto_por, para saber quién marcó el aviso como visto), hay
  // que decir cuál de las dos relaciones es "profesores(nombre)" o
  // PostgREST la da por ambigua. Esta sigue siendo el profesor que ORIGINÓ
  // el cambio, no quien lo revisó.
  const { data, error } = await S.sb.from('cambios_horario')
    .select('*, alumnos(nombre), profesores!profesor_id(nombre)')
    .order('fecha', { ascending: false });
  if (error) return avisar('Error cargando modificaciones: ' + error.message, true);
  S.cambiosHorario = data || [];
}

async function cargarReactivaciones() {
  const { data, error } = await S.sb.from('reactivaciones_alumno')
    .select('*, alumnos(nombre), profesores!profesor_id(nombre)')
    .order('fecha', { ascending: false });
  if (error) return avisar('Error cargando reactivaciones: ' + error.message, true);
  S.reactivaciones = data || [];
}

async function cargarBajasAsignatura() {
  const { data, error } = await S.sb.from('bajas_asignatura')
    .select('*, alumnos(nombre), profesores!profesor_id(nombre), asignaturas(nombre)')
    .order('fecha', { ascending: false });
  if (error) return avisar('Error cargando bajas de asignatura: ' + error.message, true);
  S.bajasAsignatura = data || [];
}

// Avisos que este admin ya ha descartado a mano ("Marcar visto" sobre algo
// que resolvió OTRO admin) — la RLS ya limita esta tabla a las filas del
// propio admin, así que no hace falta filtrar por profesor_id aquí.
async function cargarAvisosDescartados() {
  if (!S.profesor?.es_admin) { S.avisosDescartados = []; return; }
  const { data, error } = await S.sb.from('avisos_descartados').select('*');
  if (error) return avisar('Error cargando avisos descartados: ' + error.message, true);
  S.avisosDescartados = data || [];
}

// Solo el administrador ve/gestiona finanzas (RLS ya lo restringe también).
async function cargarFinanzas() {
  if (!S.profesor?.es_admin) { S.finanzas = []; return; }
  const { data, error } = await S.sb.from('finanzas_movimientos').select('*').order('fecha', { ascending: false });
  if (error) return avisar('Error cargando finanzas: ' + error.message, true);
  S.finanzas = data || [];
}

// Categorías extra que el admin haya creado (además de las fijas de siempre).
async function cargarFinanzasCategorias() {
  if (!S.profesor?.es_admin) { S.finanzasCategorias = []; return; }
  const { data, error } = await S.sb.from('finanzas_categorias').select('*');
  if (error) return avisar('Error cargando categorías: ' + error.message, true);
  S.finanzasCategorias = data || [];
}

// Saldo de partida de Efectivo/Banco (como mucho 2 filas, una por cuenta).
async function cargarCuentasSaldoInicial() {
  if (!S.profesor?.es_admin) { S.cuentasSaldoInicial = []; return; }
  const { data, error } = await S.sb.from('cuentas_saldo_inicial').select('*');
  if (error) return avisar('Error cargando saldos iniciales: ' + error.message, true);
  S.cuentasSaldoInicial = data || [];
}

async function cargarHorarioTrabajo() {
  const { data, error } = await S.sb.from('profesor_horario').select('*');
  if (error) return avisar('Error cargando horario de trabajo: ' + error.message, true);
  S.profesorHorario = data || [];
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
  if (excepciones.error) avisar('Error cargando excepciones de clase: ' + excepciones.error.message, true);
  else S.excepciones = excepciones.data || [];
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
    .select('*, alumnos(nombre, telefono, tutor_telefono, tutor_nombre, facturacion_nombre, madre_nombre, madre_telefono, padre_nombre, padre_telefono), profesores(nombre)')
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

// Pantalla completa que obliga a actualizar: se dispara en cuanto el proceso
// principal avisa de que ya hay una versión descargada y lista para instalar.
// Bloqueo por desconexión: en vez de dejar navegar por una app que va a
// fallar en cada acción sin internet, se tapa todo con un aviso claro
// hasta que vuelva la conexión — sola, sin tener que recargar nada.
let conectado = true;

function mostrarPantallaSinConexion() {
  $app().innerHTML = `
  <div class="centrado">
    <div class="tarjeta login">
      ${logoHtml()}
      <p class="sub">tu centro de estudios</p>
      <h2>Sin conexión</h2>
      <p class="ayuda">Se ha perdido la conexión a internet. La app se recupera sola en cuanto vuelva.</p>
    </div>
  </div>`;
}

// Pantalla completa (igual de bloqueante que la de "Sin conexión") cuando un
// admin te acaba de hacer o quitar administrador mientras tenías la app
// abierta: en vez de intentar parchear en caliente todo lo que depende de
// es_admin (finanzas, gestión de profesores...), se fuerza un reinicio limpio.
function mostrarPantallaReinicioAdmin(esAdminNuevo) {
  $app().innerHTML = `
  <div class="centrado">
    <div class="tarjeta login">
      ${logoHtml()}
      <p class="sub">tu centro de estudios</p>
      <h2>Tus permisos han cambiado</h2>
      <p class="ayuda">${esAdminNuevo
        ? 'Un administrador te acaba de dar permisos de administrador.'
        : 'Un administrador te acaba de quitar los permisos de administrador.'}
      Reinicia la app para que se apliquen bien.</p>
      <button class="btn primario" id="btn-reiniciar-admin" style="margin-top:14px; width:100%">Reiniciar ahora</button>
    </div>
  </div>`;
  document.getElementById('btn-reiniciar-admin').onclick = () => window.api.restartApp();
}

function marcarDesconectado() {
  if (!conectado) return; // ya se sabía, no repintar de más
  conectado = false;
  mostrarPantallaSinConexion();
}

function marcarConectado() {
  if (conectado) return;
  conectado = true;
  // Puede haberse perdido algo mientras tanto: recarga todo si hay sesión;
  // si no, vuelve al login tal cual.
  if (S.session) cargarTodo().then(renderMain).catch(() => {});
  else renderLogin();
}

function mostrarPantallaActualizacion(version) {
  $app().innerHTML = `
  <div class="centrado">
    <div class="tarjeta login">
      ${logoHtml()}
      <p class="sub">tu centro de estudios</p>
      <h2>Hay una versión nueva</h2>
      <p class="ayuda">La versión ${e(version)} ya está descargada. Actualiza para seguir usando la app con las últimas mejoras.</p>
      <button class="btn primario" id="actualizar-btn">Actualizar</button>
    </div>
  </div>`;
  document.getElementById('actualizar-btn').onclick = (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Actualizando…';
    window.api.instalarActualizacion();
  };
}

// Si hay un modal abierto (una ficha a medio editar, un recibo a medio
// generar…) se espera a que se cierre antes de tapar la pantalla entera:
// cerrarModal() se encarga de mostrarla en cuanto quede libre.
function avisoActualizacionPendiente(version) {
  S.actualizacionPendiente = version;
  const modalAbierto = document.getElementById('modal-raiz')?.innerHTML.trim();
  if (!modalAbierto) mostrarPantallaActualizacion(version);
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
      ${esAdmin ? `<button data-v="finanzas" class="tab ${S.vista === 'finanzas' ? 'activa' : ''}">Ingresos y gastos</button>` : ''}
      ${esAdmin ? `<button data-v="reestructuracion" class="tab ${S.vista === 'reestructuracion' ? 'activa' : ''}">Reestructuración</button>` : ''}
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
  document.getElementById('logout').onclick = () => cerrarSesion();
  renderVistaActual();
}

// Compartido por el botón "Salir" y el cierre automático por inactividad.
async function cerrarSesion(mensaje) {
  detenerTiempoReal();
  detenerControlInactividad();
  await S.sb.auth.signOut();
  S.session = null; S.profesor = null;
  renderLogin();
  if (mensaje) setTimeout(() => {
    const m = document.getElementById('msg');
    if (m) m.textContent = mensaje;
  }, 0);
}

// Repinta solo la pestaña actual (sin reconstruir cabecera/menú), usada tanto
// al cambiar de pestaña como al recibir un cambio en tiempo real de otro equipo.
function renderVistaActual() {
  if (S.vista === 'inicio') renderInicio();
  else if (S.vista === 'alumnos') renderAlumnos();
  else if (S.vista === 'clases') renderClases();
  else if (S.vista === 'horario') renderHorario();
  else if (S.vista === 'recibos') renderRecibos();
  else if (S.vista === 'notas') renderNotas();
  else if (S.vista === 'profesores') renderProfesores();
  else if (S.vista === 'finanzas') renderFinanzas();
  else if (S.vista === 'reestructuracion') renderReestructuracion();
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
  // Siempre las clases de quien ha entrado, nunca las del filtro compartido
  // de Clases/Horario/Recibos (S.filtros.profesor) — si no, un admin que
  // hubiera mirado el horario de otro profesor vería esas clases "de hoy"
  // coladas en su propia portada.
  const clasesHoy = [];
  for (const c of S.clases.filter(c2 => c2.profesor_id === S.profesor?.id)) {
    for (const h of c.clase_horarios || []) {
      if (h.dia_semana === diaHoy) clasesHoy.push({ ...h, clase: c });
    }
  }
  clasesHoy.sort((a, b) => String(a.hora).localeCompare(String(b.hora)));

  // Avisos solo para el administrador: fichas sin precio, modificaciones de
  // horas sin revisar, altas tardías con recibo pendiente de generar a mano,
  // y recibos ya marcados pagados (por cualquier profesor) que faltan por
  // mandar el justificante — solo el admin tiene acceso al envío.
  const esAdmin = S.profesor?.es_admin;
  const daClases = S.profesor?.da_clases !== false;
  const fichasIncompletas = esAdmin ? fichasParaAdmin() : [];
  const modificacionesSinVer = esAdmin ? cambiosParaAdmin() : [];
  const altasFueraDeFecha = esAdmin ? altasFueraDeFechaParaAdmin() : [];
  const reactivacionesSinVer = esAdmin ? reactivacionesParaAdmin() : [];
  const bajasAsignaturaSinVer = esAdmin ? bajasAsignaturaParaAdmin() : [];
  const pagadosPorEnviar = esAdmin
    ? S.recibos.filter(r => r.estado === 'pagado' && !r.fecha_envio_whatsapp_pago)
    : [];

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
      ${daClases ? `
      <div class="portada-card" data-ir="horario">
        <div class="pc-num">${clasesHoy.length}</div>
        <div class="pc-titulo">clase${clasesHoy.length === 1 ? '' : 's'} hoy</div>
        <div class="pc-detalle">${clasesHoy.length
          ? e(clasesHoy.slice(0, 3).map(s => `${horaCorta(s.hora)} ${s.clase.nombre}`).join(' · ')) + (clasesHoy.length > 3 ? '…' : '')
          : 'Nada en el horario de hoy'}</div>
      </div>` : ''}
      <div class="portada-card" data-ir="alumnos">
        <div class="pc-num">${activos}</div>
        <div class="pc-titulo">alumno${activos === 1 ? '' : 's'} activo${activos === 1 ? '' : 's'}</div>
        <div class="pc-detalle">Ver la base de datos</div>
      </div>
      <div class="portada-card ${pendientes.length ? 'alerta' : ''}" data-ir="recibos">
        <div class="pc-num">${pendientes.length}</div>
        <div class="pc-titulo">recibo${pendientes.length === 1 ? '' : 's'} pendiente${pendientes.length === 1 ? '' : 's'}</div>
        <div class="pc-detalle">${!pendientes.length ? 'Todo cobrado 🎉' : esAdmin ? formatoImporte(totalPendiente) + '€ por cobrar' : 'Ver quién falta'}</div>
      </div>
      <div class="portada-card" data-ir="notas">
        <div class="pc-num">${S.notas.length}</div>
        <div class="pc-titulo">nota${S.notas.length === 1 ? '' : 's'}</div>
        <div class="pc-detalle">Tus pósits</div>
      </div>
    </div>
    ${esAdmin && (fichasIncompletas.length || modificacionesSinVer.length || altasFueraDeFecha.length || reactivacionesSinVer.length || bajasAsignaturaSinVer.length || pagadosPorEnviar.length) ? `
    <h3 class="seccion" style="margin-top:28px">Pendiente de revisar</h3>
    <div class="portada-cards">
      ${pagadosPorEnviar.length ? `
      <div class="portada-card alerta" id="pc-pagados-enviar">
        <div class="pc-num">${pagadosPorEnviar.length}</div>
        <div class="pc-titulo">recibo${pagadosPorEnviar.length === 1 ? '' : 's'} cobrado${pagadosPorEnviar.length === 1 ? '' : 's'} por enviar</div>
        <div class="pc-detalle">Un profesor ha marcado un pago: manda el justificante</div>
      </div>` : ''}
      ${fichasIncompletas.length ? `
      <div class="portada-card alerta" id="pc-fichas">
        <div class="pc-num">${fichasIncompletas.length}</div>
        <div class="pc-titulo">ficha${fichasIncompletas.length === 1 ? '' : 's'} sin precio</div>
        <div class="pc-detalle">Completar para que se generen sus recibos</div>
      </div>` : ''}
      ${modificacionesSinVer.length ? `
      <div class="portada-card alerta" id="pc-modificaciones">
        <div class="pc-num">${modificacionesSinVer.length}</div>
        <div class="pc-titulo">modificación${modificacionesSinVer.length === 1 ? '' : 'es'} horas alumnos</div>
        <div class="pc-detalle">Un profesor ha cambiado las horas de un alumno</div>
      </div>` : ''}
      ${altasFueraDeFecha.length ? `
      <div class="portada-card alerta" id="pc-fuera-fecha">
        <div class="pc-num">${altasFueraDeFecha.length}</div>
        <div class="pc-titulo">recibo${altasFueraDeFecha.length === 1 ? '' : 's'} para generar a mano</div>
        <div class="pc-detalle">Alta posterior al día 1, fuera del envío automático</div>
      </div>` : ''}
      ${reactivacionesSinVer.length ? `
      <div class="portada-card alerta" id="pc-reactivaciones">
        <div class="pc-num">${reactivacionesSinVer.length}</div>
        <div class="pc-titulo">alumno${reactivacionesSinVer.length === 1 ? '' : 's'} reactivado${reactivacionesSinVer.length === 1 ? '' : 's'}</div>
        <div class="pc-detalle">Un profesor ha reactivado a un alumno</div>
      </div>` : ''}
      ${bajasAsignaturaSinVer.length ? `
      <div class="portada-card alerta" id="pc-bajas-asignatura">
        <div class="pc-num">${bajasAsignaturaSinVer.length}</div>
        <div class="pc-titulo">baja${bajasAsignaturaSinVer.length === 1 ? '' : 's'} de asignatura</div>
        <div class="pc-detalle">Un profesor ha dado de baja a un alumno de una asignatura: revisa el precio</div>
      </div>` : ''}
    </div>` : ''}
  </div>`;

  document.querySelectorAll('[data-ir]').forEach(c => c.onclick = () => {
    S.vista = c.dataset.ir;
    renderMain();
  });
  const pcFichas = document.getElementById('pc-fichas');
  if (pcFichas) pcFichas.onclick = () => modalFichasIncompletas(fichasIncompletas);
  const pcMod = document.getElementById('pc-modificaciones');
  if (pcMod) pcMod.onclick = () => modalModificacionesSinVer(modificacionesSinVer);
  const pcFuera = document.getElementById('pc-fuera-fecha');
  if (pcFuera) pcFuera.onclick = () => modalRecibosFueraDeFecha(altasFueraDeFecha);
  const pcReact = document.getElementById('pc-reactivaciones');
  if (pcReact) pcReact.onclick = () => modalReactivacionesSinVer(reactivacionesSinVer);
  const pcBajasAsig = document.getElementById('pc-bajas-asignatura');
  if (pcBajasAsig) pcBajasAsig.onclick = () => modalBajasAsignaturaSinVer(bajasAsignaturaSinVer);
  const pcPagados = document.getElementById('pc-pagados-enviar');
  if (pcPagados) pcPagados.onclick = () => {
    S.vista = 'recibos';
    S.vistaRosterRecibos = false;
    S.vistaRecibos = 'pagados-enviar';
    renderMain();
  };
}

// Alumnos dados de alta este mes DESPUÉS del día 1 (fuera de la generación
// automática) que ya tienen precio fijado pero todavía no tienen recibo de
// este mes: hay que generárselo a mano una vez.
// Mes actual en formato 'YYYY-MM', para comparar con recibos.periodos.
function periodoActualClave() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
}

// ¿Este alumno pudo quedarse fuera del envío automático del mes? (alta tardía,
// con precio ya puesto). No dice nada de si YA tiene recibo o no — eso se
// mira aparte, para poder reusar este mismo criterio tanto para "todavía
// pendiente" como para "ya se generó, pero por otro admin".
function candidataAltaFueraDeFecha(a) {
  const hoy = new Date();
  // En julio, agosto y septiembre no hay generación automática de recibos
  // (receso de verano, ver generar_recibos_mensuales() en el servidor), así
  // que no tiene sentido avisar de "se quedó fuera del envío automático" en
  // esos meses — nadie tiene recibo automático esos meses, se den de alta
  // cuando se den de alta.
  if ([6, 7, 8].includes(hoy.getMonth())) return false;
  // Marcado como "empieza el próximo mes": no se le genera nada este mes a
  // propósito, así que tampoco tiene sentido avisar de "se quedó fuera".
  if (a.empieza_proximo_mes) return false;
  if (a.estado !== 'activo' || !a.fecha_alta) return false;
  const alta = new Date(a.fecha_alta + 'T00:00:00');
  if (alta.getFullYear() !== hoy.getFullYear() || alta.getMonth() !== hoy.getMonth()) return false;
  if (alta.getDate() <= 1) return false;
  return (a.matriculas || []).some(m => m.tipo_tarifa === 'mes' && m.tarifa != null);
}
// Recibo ya generado para este alumno en el mes actual (si lo hay).
function reciboDelPeriodoActual(alumnoId) {
  const periodoActual = periodoActualClave();
  return S.recibos.find(r => r.alumno_id === alumnoId && (r.periodos || []).includes(periodoActual));
}
function recibosPendientesFueraDeFecha() {
  return S.alumnos.filter(a => candidataAltaFueraDeFecha(a) && !reciboDelPeriodoActual(a.id));
}

// ---- Avisos de Inicio: no repetir una acción que ya hizo el otro admin ----
// Un aviso resuelto (ficha ya con precio, cambio ya marcado visto, alta ya
// con recibo...) sigue saliéndole a los admins que NO lo resolvieron, hasta
// que cada uno lo descarta a mano ("Marcar visto") — sea cual sea el momento
// en que entren (no basta con que tuvieran el modal abierto en el instante
// exacto: avisos_descartados guarda quién ya lo ha visto, de verdad).

function descartado(tipo, referencia) {
  return S.avisosDescartados.some(d => d.tipo === tipo && d.referencia === String(referencia));
}
async function marcarDescartado(tipo, referencia) {
  const { error } = await S.sb.from('avisos_descartados')
    .insert({ tipo, referencia: String(referencia), profesor_id: S.profesor.id });
  if (error) return avisar('Error: ' + error.message, true);
  await cargarAvisosDescartados();
}
function nombreProfesor(id) {
  return S.profesores.find(p => p.id === id)?.nombre || 'otro admin';
}

// Fila ya resuelta por OTRO admin: sin botón de acción, con quién lo hizo, y
// un "Marcar visto" que guarda el descarte para este admin (persiste: no
// vuelve a salirle a él, siga o no abierto el modal, entre cuando entre).
function filaAvisoResuelto(tipo, id, etiquetaHtml, nombreQuien) {
  return `<li data-item="${e(String(id))}">${etiquetaHtml}
    <br><span class="chip envio-si">✓ Hecho por ${e(nombreQuien)}</span>
    <button class="btn chico liso" data-marcar-visto-tipo="${tipo}" data-marcar-visto-ref="${e(String(id))}">Marcar visto</button></li>`;
}
function activarMarcarVistoAviso() {
  document.querySelectorAll('[data-marcar-visto-tipo]').forEach(b => b.onclick = async () => {
    await marcarDescartado(b.dataset.marcarVistoTipo, b.dataset.marcarVistoRef);
    b.closest('[data-item]')?.remove();
    if (S.vista === 'inicio') renderInicio();
  });
}

// ---- Fichas sin precio ----
// Cada elemento: { alumno, matricula, resuelto }. resuelto=true cuando la
// matrícula ya tiene precio, lo puso OTRO admin (no yo) y yo no lo he
// descartado todavía — matriculas.actualizado_por solo se guarda cuando el
// precio pasa de vacío a puesto (ver guardarFicha), así que no hay ruido de
// ediciones normales de matrículas que siempre tuvieron precio.
function fichasParaAdmin() {
  const items = [];
  for (const al of S.alumnos) {
    for (const m of al.matriculas || []) {
      if (m.tarifa == null) { items.push({ alumno: al, matricula: m, resuelto: false }); continue; }
      const ref = `${al.id}|${m.asignatura_id}`;
      if (m.actualizado_por && m.actualizado_por !== S.profesor.id && !descartado('ficha', ref)) {
        items.push({ alumno: al, matricula: m, resuelto: true });
      }
    }
  }
  return items;
}
function filaFichaIncompleta({ alumno, matricula, resuelto }) {
  const id = `${alumno.id}|${matricula.asignatura_id}`;
  if (resuelto) {
    return filaAvisoResuelto('ficha', id,
      `${e(alumno.nombre)} <small>· ${e(matricula.asignaturas?.nombre || '')}</small>`,
      nombreProfesor(matricula.actualizado_por));
  }
  return `<li data-item="${id}">
    <button class="btn chico" data-completar="${alumno.id}">Completar</button>
    &nbsp;${e(alumno.nombre)} <small>· ${e(matricula.asignaturas?.nombre || '')}</small>
  </li>`;
}
function activarBotonesFichasIncompletas() {
  document.querySelectorAll('[data-completar]').forEach(b => b.onclick = () => {
    cerrarModal();
    modalAlumno(S.alumnos.find(a => a.id === b.dataset.completar));
  });
}
function modalFichasIncompletas(lista) {
  abrirModal(`
  <h2>Fichas sin precio</h2>
  <p class="ayuda">Estos alumnos tienen alguna asignatura sin tarifa fijada — no se les generará
  recibo hasta que se complete.</p>
  <ul class="detalle-alumnos" id="av-fichas">
    ${lista.map(filaFichaIncompleta).join('')}
  </ul>
  <div class="pie-modal"><button class="btn liso" id="m-cancelar">Cerrar</button></div>`);
  avisoAbierto = { tipo: 'fichas', ids: lista.map(({ alumno, matricula }) => `${alumno.id}|${matricula.asignatura_id}`) };
  document.getElementById('m-cancelar').onclick = cerrarModal;
  activarBotonesFichasIncompletas();
  activarMarcarVistoAviso();
}

// ---- Altas fuera de fecha ----
// Cada elemento: { alumno, resuelto }. resuelto=true cuando ya hay recibo de
// este mes, lo generó OTRO admin y yo no lo he descartado todavía.
function altasFueraDeFechaParaAdmin() {
  const pendientes = recibosPendientesFueraDeFecha().map(alumno => ({ alumno, resuelto: false }));
  const resueltas = S.alumnos.filter(a => {
    if (!candidataAltaFueraDeFecha(a)) return false;
    const recibo = reciboDelPeriodoActual(a.id);
    if (!recibo || recibo.profesor_id === S.profesor.id) return false;
    return !descartado('alta_fuera_fecha', a.id);
  }).map(alumno => ({ alumno, resuelto: true }));
  return [...pendientes, ...resueltas];
}
function filaAltaFueraDeFecha({ alumno: a, resuelto }) {
  if (resuelto) {
    const recibo = reciboDelPeriodoActual(a.id);
    return filaAvisoResuelto('alta_fuera_fecha', a.id,
      `${e(a.nombre)} <small>· alta ${fmtFecha(a.fecha_alta)}</small>`,
      nombreProfesor(recibo?.profesor_id));
  }
  return `<li data-item="${a.id}">
    <button class="btn chico" data-generar="${a.id}">Generar recibo</button>
    &nbsp;${e(a.nombre)} <small>· alta ${fmtFecha(a.fecha_alta)}</small>
  </li>`;
}
function activarBotonesAltasFueraDeFecha() {
  document.querySelectorAll('[data-generar]').forEach(b => b.onclick = async () => {
    const alumno = S.alumnos.find(a => a.id === b.dataset.generar);
    // Última comprobación antes de generar: si el otro admin lo generó justo
    // antes de que este clic llegara, no duplicar el recibo.
    const periodoActual = periodoActualClave();
    const { data: recibosAlumno } = await S.sb.from('recibos').select('id, periodos').eq('alumno_id', alumno.id);
    if ((recibosAlumno || []).some(r => (r.periodos || []).includes(periodoActual))) {
      await cargarRecibos();
      cerrarModal();
      if (S.vista === 'inicio') renderInicio();
      return avisar('Ya se generó el recibo de este alumno (lo hizo el otro admin).', true);
    }
    cerrarModal();
    modalRecibo(alumno);
  });
}
function modalRecibosFueraDeFecha(lista) {
  abrirModal(`
  <h2>Recibos para generar a mano</h2>
  <p class="ayuda">Se dieron de alta después del día 1, así que el envío automático de este mes
  ya no los recogió. Genera su recibo con el botón y listo.</p>
  <ul class="detalle-alumnos" id="av-altas">
    ${lista.map(filaAltaFueraDeFecha).join('')}
  </ul>
  <div class="pie-modal"><button class="btn liso" id="m-cancelar">Cerrar</button></div>`);
  avisoAbierto = { tipo: 'altas', ids: lista.map(({ alumno }) => alumno.id) };
  document.getElementById('m-cancelar').onclick = cerrarModal;
  activarBotonesAltasFueraDeFecha();
  activarMarcarVistoAviso();
}

// ---- cambios de horario / reactivaciones / bajas de asignatura ----
// Comparten forma: fila con visto/visto_por. Pendiente si !visto; resuelta
// (para mí) si visto=true, lo marcó OTRO admin y yo no lo he descartado.
function cambiosParaAdmin() {
  return S.cambiosHorario.filter(c => !c.visto || (c.visto_por !== S.profesor.id && !descartado('cambio', c.id)));
}
function reactivacionesParaAdmin() {
  return S.reactivaciones.filter(r => !r.visto || (r.visto_por !== S.profesor.id && !descartado('reactivacion', r.id)));
}
function bajasAsignaturaParaAdmin() {
  return S.bajasAsignatura.filter(b => !b.visto || (b.visto_por !== S.profesor.id && !descartado('baja_asignatura', b.id)));
}

// Refresca en su sitio el aviso que se tenga abierto (si hay uno) cuando
// llega un cambio en tiempo real, en vez de dejarlo con la foto fija de
// cuando se abrió. La llama recargarTrasCambioRemoto().
function refrescarAvisoAbierto() {
  if (!avisoAbierto) return;
  const cont = document.getElementById('av-' + avisoAbierto.tipo);
  if (!cont) { avisoAbierto = null; return; } // el modal ya no es este aviso

  const FUENTES = {
    fichas: () => fichasParaAdmin().filter(it => avisoAbierto.ids.includes(`${it.alumno.id}|${it.matricula.asignatura_id}`)),
    altas: () => altasFueraDeFechaParaAdmin().filter(it => avisoAbierto.ids.includes(it.alumno.id)),
    cambios: () => cambiosParaAdmin().filter(c => avisoAbierto.ids.includes(c.id)),
    reactivaciones: () => reactivacionesParaAdmin().filter(r => avisoAbierto.ids.includes(r.id)),
    bajas: () => bajasAsignaturaParaAdmin().filter(b => avisoAbierto.ids.includes(b.id))
  };
  const FILAS = {
    fichas: filaFichaIncompleta, altas: filaAltaFueraDeFecha,
    cambios: filaCambioHorario, reactivaciones: filaReactivacion, bajas: filaBajaAsignatura
  };
  const ACTIVAR = {
    fichas: activarBotonesFichasIncompletas, altas: activarBotonesAltasFueraDeFecha,
    cambios: activarBotonesCambiosHorario, reactivaciones: activarBotonesReactivaciones, bajas: activarBotonesBajasAsignatura
  };
  const fuente = FUENTES[avisoAbierto.tipo];
  if (!fuente) return;
  cont.innerHTML = fuente().map(FILAS[avisoAbierto.tipo]).join('');
  ACTIVAR[avisoAbierto.tipo]();
  activarMarcarVistoAviso();
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

// Teléfono a mostrar en el listado de alumnos: el normal si lo hay; si no y
// tiene padres separados, los dos (madre y padre) para que no quede vacío.
function telefonosParaLista(a) {
  if (a.telefono || a.tutor_telefono) return a.telefono || a.tutor_telefono;
  if (a.padres_separados) {
    const partes = [];
    if (a.madre_telefono) partes.push(`M: ${a.madre_telefono}`);
    if (a.padre_telefono) partes.push(`P: ${a.padre_telefono}`);
    return partes.join(' · ');
  }
  return '';
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
    <button class="btn" id="btn-modificaciones">🔧 Modificación horas alumnos</button>
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
      <td><strong>${e(a.nombre)}</strong>${a.tutor_nombre ? `<br><small>Tutor: ${e(a.tutor_nombre)}</small>` : ''}${a.empieza_proximo_mes ? '<br><small>⏳ Empieza el próximo mes</small>' : ''}</td>
      <td>${(a.matriculas || []).map(m => chipAsignatura(m)).join(' ')
        || '<small>Sin asignaturas</small>'}</td>
      <td>${e(telefonosParaLista(a))}</td>
      <td><span class="chip ${a.estado}">${a.estado}</span></td>
      <td class="acciones">
        <button class="btn chico" data-recibo="${a.id}">Recibo</button>
        <button class="btn chico liso" data-editar="${a.id}">Editar</button>
      </td>
    </tr>`).join('')}
    </tbody>
  </table>`}`;

  const rerender = () => renderAlumnos();
  document.getElementById('f-texto').oninput = (ev) => { S.filtros.texto = ev.target.value; conFocoPreservado(rerender); };
  document.getElementById('f-asig').onchange = (ev) => { S.filtros.asignatura = ev.target.value; rerender(); };
  document.getElementById('f-estado').onchange = (ev) => { S.filtros.estado = ev.target.value; rerender(); };
  const fp = document.getElementById('f-prof');
  if (fp) fp.onchange = (ev) => { S.filtros.profesor = ev.target.value; rerender(); };
  const ft = document.getElementById('f-todos');
  if (ft) ft.onchange = (ev) => { S.filtros.verTodos = ev.target.checked; rerender(); };
  document.getElementById('btn-nuevo').onclick = () => modalAlumno(null);
  document.getElementById('btn-modificaciones').onclick = () => modalModificaciones();
  document.getElementById('btn-bulk').onclick = () => modalReciboBulk();
  document.getElementById('btn-csv').onclick = exportarAlumnosCsv;
  document.querySelectorAll('[data-editar]').forEach(b =>
    b.onclick = () => modalAlumno(S.alumnos.find(a => a.id === b.dataset.editar)));
  document.querySelectorAll('[data-recibo]').forEach(b =>
    b.onclick = () => modalRecibo(S.alumnos.find(a => a.id === b.dataset.recibo)));
}

// Separa nombre de pila y apellidos para rellenar las dos casillas. Si el
// alumno ya tiene apellidos guardados, se quitan del final de "nombre" (por
// si quedó sin limpiar de un guardado anterior); si no los tiene aún (fichas
// de antes del cambio), se adivinan solos con la primera palabra como nombre
// y el resto como apellidos — así el admin no tiene que recortar nada a mano,
// que fue justo lo que provocó apellidos duplicados la primera vez.
function separarNombreApellidos(a) {
  if (a.apellidos) {
    let base = a.nombre || '';
    while (base.length > a.apellidos.length && base.endsWith(' ' + a.apellidos)) {
      base = base.slice(0, -(a.apellidos.length + 1));
    }
    return { nombre: base, apellidos: a.apellidos };
  }
  const partes = (a.nombre || '').trim().split(/\s+/).filter(Boolean);
  return { nombre: partes[0] || '', apellidos: partes.slice(1).join(' ') };
}

// "612345678" -> "612 345 678", solo para que se lea mejor en la ficha — se
// guarda siempre sin espacios (quitarEspacios() al leer el campo al guardar).
function formatearTelefono(valor) {
  return String(valor || '').replace(/\D/g, '').slice(0, 9).replace(/(\d{3})(?=\d)/g, '$1 ');
}
function quitarEspacios(valor) {
  return String(valor || '').replace(/\s+/g, '');
}

function modalAlumno(alumno) {
  const esAdmin = S.profesor?.es_admin;
  const a = alumno || {};
  const nombreForm = separarNombreApellidos(a);
  // Matrículas en edición local: las de mis asignaturas (o todas si admin) se
  // pueden tocar; las del resto de profesores se muestran solo informativas.
  const ms = alumno ? misMatriculas(alumno).map(m => ({ ...m })) : [];
  const soloLectura = alumno ? (alumno.matriculas || []).filter(m => !ms.some(x => x.id === m.id)) : [];
  const idsOriginales = ms.map(m => m.id);
  // Precio que tenía cada matrícula ANTES de abrir este modal — para saber,
  // al guardar, si de verdad se acaba de completar una que estaba sin precio
  // (y así avisar en tiempo real al otro admin) o si solo se ha tocado otra
  // cosa de una matrícula que ya tenía precio de antes.
  const tarifasOriginales = new Map(ms.map(m => [m.id, m.tarifa]));
  const nuevaMatricula = () => ({ id: null, asignatura_id: misAsignaturas()[0]?.id, tarifa: '', tipo_tarifa: 'mes', horas_semana: '' });
  if (!alumno) ms.push(nuevaMatricula());

  // Historial de recibos de este alumno (ya filtrado por lo que el usuario
  // puede ver, según las reglas de seguridad del servidor).
  const historialRecibos = alumno
    ? S.recibos.filter(r => r.alumno_id === alumno.id)
      .sort((x, y) => (y.fecha_emision || '').localeCompare(x.fecha_emision || ''))
    : [];

  abrirModal(`
  <h2>${alumno ? 'Ficha de ' + e(a.nombre) : 'Nuevo alumno'}</h2>
  ${alumno && a.estado === 'baja' ? '<p class="ayuda">⚠ Este alumno está <strong>de baja</strong>. Puedes corregir sus datos (nivel, precio, horas…) y reactivarlo a la vez con el botón de abajo.</p>' : ''}
  <div class="grid2">
    <label>Nombre *<input id="a-nombre" value="${e(nombreForm.nombre)}"></label>
    <label>Apellidos <small>(para detectar hermanos automáticamente)</small>
      <input id="a-apellidos" value="${e(nombreForm.apellidos)}" placeholder="ej. García López"></label>
    <label>Teléfono / WhatsApp (si es menor, el del padre/madre)
      <input id="a-tel" value="${e(formatearTelefono(a.telefono || a.tutor_telefono))}" inputmode="numeric" maxlength="11" placeholder="612 345 678"></label>
    <label>Padre / madre / tutor (nombre y apellidos)
      <input id="a-tutor" value="${e(a.tutor_nombre || '')}" placeholder="El recibo irá a su nombre"></label>
    <label>Fecha de alta<input id="a-alta" type="date" value="${e(a.fecha_alta || new Date().toISOString().slice(0, 10))}"></label>
    <label>Facturar a (si difiere)<input id="a-fact-nombre" value="${e(a.facturacion_nombre || '')}"></label>
    <label>Dirección de facturación<input id="a-fact-dir" value="${e(a.facturacion_direccion || '')}"></label>
    <label>Descuento especial (€/mes)${esAdmin ? '' : ' <small>(solo admin)</small>'}
      <input id="a-descuento" type="number" min="0" step="0.01" value="${a.descuento_extra || ''}" placeholder="0" ${esAdmin ? '' : 'disabled'}></label>
  </div>
  <label class="check-inline" style="margin-top:10px">
    <input type="checkbox" id="a-empieza-prox-mes" ${a.empieza_proximo_mes ? 'checked' : ''}>
    Empieza el próximo mes — no generará recibo este mes; el día 1 del que viene entra solo
  </label>
  <label class="check-inline" style="margin-top:10px">
    <input type="checkbox" id="a-padres-sep" ${a.padres_separados ? 'checked' : ''}>
    Padres separados — repartir el recibo entre los dos, cada uno a su teléfono
  </label>
  <div id="a-padres-sep-bloque" style="${a.padres_separados ? '' : 'display:none'}; margin-top:8px">
    <div class="grid2">
      <label>Nombre de la madre<input id="a-madre-nombre" value="${e(a.madre_nombre || '')}"></label>
      <label>Teléfono de la madre<input id="a-madre-tel" value="${e(formatearTelefono(a.madre_telefono))}" inputmode="numeric" maxlength="11" placeholder="612 345 678"></label>
      <label>Nombre del padre<input id="a-padre-nombre" value="${e(a.padre_nombre || '')}"></label>
      <label>Teléfono del padre<input id="a-padre-tel" value="${e(formatearTelefono(a.padre_telefono))}" inputmode="numeric" maxlength="11" placeholder="612 345 678"></label>
    </div>
    <label class="check-inline">
      <input type="radio" name="a-reparto" id="a-reparto-igual" ${Number(a.madre_porcentaje ?? 50) === 50 ? 'checked' : ''}> 50% / 50%
    </label>
    <label class="check-inline">
      <input type="radio" name="a-reparto" id="a-reparto-custom" ${Number(a.madre_porcentaje ?? 50) !== 50 ? 'checked' : ''}> Personalizado
    </label>
    <div class="grid2" id="a-reparto-custom-bloque" style="${Number(a.madre_porcentaje ?? 50) !== 50 ? '' : 'display:none'}">
      <label>% que paga la madre<input id="a-madre-pct" type="number" min="1" max="99" value="${a.madre_porcentaje ?? 50}"></label>
      <label>% que paga el padre (automático)<input id="a-padre-pct" type="number" disabled value="${100 - Number(a.madre_porcentaje ?? 50)}"></label>
    </div>
  </div>
  <h3 class="seccion">Asignaturas apuntadas</h3>
  ${soloLectura.length ? `<div class="detalle-horarios">
    ${soloLectura.map(m => chipAsignatura(m, ' <small>(otro profesor)</small>')).join('')}
  </div>` : ''}
  <div id="a-matriculas"></div>
  <button class="btn chico" id="a-add-mat">+ Añadir asignatura</button>
  ${!esAdmin ? '<p class="ayuda">El precio lo fija la administradora; deja ese campo en blanco.</p>' : ''}
  <div id="a-descuentos-resumen"></div>
  ${alumno ? `
  <h3 class="seccion">Historial de recibos</h3>
  ${historialRecibos.length === 0 ? '<p class="ayuda">Todavía no tiene recibos.</p>' : `
  <div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Concepto</th><th>Importe</th><th>Estado</th><th></th></tr></thead>
    <tbody>
    ${historialRecibos.map(r => `<tr>
      <td>${e(fmtFecha(r.fecha_emision))}</td>
      <td>${e(r.concepto)}</td>
      <td><strong>${formatoImporte(r.importe)}€</strong></td>
      <td><span class="chip ${r.estado}">${r.estado}</span></td>
      <td class="acciones"><button class="btn chico liso" data-pdf-hist="${r.id}">PDF</button></td>
    </tr>`).join('')}
    </tbody>
  </table></div>`}` : ''}
  <label>Notas / observaciones<textarea id="a-notas" rows="3">${e(a.notas || '')}</textarea></label>
  <div class="pie-modal">
    ${alumno ? (a.estado === 'baja'
      ? '<button class="btn" id="a-reactivar">Reactivar y guardar cambios</button>'
      : '<button class="btn liso peligro" id="a-baja">Sistema de bajas</button>') : ''}
    <span class="flex1"></span>
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="m-guardar">Guardar</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  const pintarMatriculas = () => {
    document.getElementById('a-matriculas').innerHTML = ms.map((m, i) => `
      <div class="fila-horario">
        <select data-m-asig="${i}">${opcionesAsignaturas(esAdmin ? null : S.profesor.id, m.asignatura_id)}</select>
        <input type="number" data-m-tarifa="${i}" min="0" step="0.01" placeholder="${esAdmin ? '€' : 'lo pone el admin'}"
          value="${m.tarifa ?? ''}" class="ancho-tarifa" ${esAdmin ? '' : 'disabled'}>
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
  document.getElementById('a-tel').oninput = (ev) => {
    ev.target.value = formatearTelefono(ev.target.value);
  };
  document.getElementById('a-madre-tel').oninput = (ev) => {
    ev.target.value = formatearTelefono(ev.target.value);
  };
  document.getElementById('a-padre-tel').oninput = (ev) => {
    ev.target.value = formatearTelefono(ev.target.value);
  };
  document.getElementById('a-padres-sep').onchange = (ev) => {
    document.getElementById('a-padres-sep-bloque').style.display = ev.target.checked ? '' : 'none';
  };
  const $repartoCustomBloque = document.getElementById('a-reparto-custom-bloque');
  document.getElementById('a-reparto-igual').onchange = () => { $repartoCustomBloque.style.display = 'none'; };
  document.getElementById('a-reparto-custom').onchange = () => { $repartoCustomBloque.style.display = ''; };
  document.getElementById('a-madre-pct').oninput = (ev) => {
    const pct = Math.min(99, Math.max(1, Number(ev.target.value) || 0));
    document.getElementById('a-padre-pct').value = 100 - pct;
  };

  // Resumen de descuentos ya aplicados (solo tiene sentido con datos guardados).
  if (alumno) {
    S.sb.rpc('calcular_descuentos_alumno', { p_alumno_id: alumno.id }).then(({ data }) => {
      const cont = document.getElementById('a-descuentos-resumen');
      if (!cont) return; // el modal ya se cerró antes de que respondiera
      const d = data?.[0];
      if (!d || d.base == null) {
        cont.innerHTML = '<p class="ayuda">Sin precio fijado todavía: no se puede calcular el importe con descuentos.</p>';
        return;
      }
      const partes = [];
      if (d.descuento_multi > 0) partes.push(`−${formatoImporte(d.descuento_multi)}€ por varias asignaturas`);
      if (d.descuento_hermano > 0) partes.push(`−${formatoImporte(d.descuento_hermano)}€ por hermano/a matriculado/a`);
      if (d.descuento_extra > 0) partes.push(`−${formatoImporte(d.descuento_extra)}€ descuento especial`);
      cont.innerHTML = `<p class="letras">Precio base: ${formatoImporte(d.base)}€${partes.length ? '<br>' + partes.join('<br>') : ''}<br>
        <strong>Total mensual: ${formatoImporte(d.total)}€</strong></p>`;
    });
  }

  const msg = (t) => { document.getElementById('m-msg').textContent = t; };

  if (alumno) {
    const btnBaja = document.getElementById('a-baja');
    if (btnBaja) btnBaja.onclick = () => modalSistemaBajas(alumno);
    const btnRe = document.getElementById('a-reactivar');
    if (btnRe) btnRe.onclick = () => guardarFicha('activo');
    document.querySelectorAll('[data-pdf-hist]').forEach(b => b.onclick = async () => {
      const r = S.recibos.find(x => x.id === b.dataset.pdfHist);
      const abierto = await window.api.openPdf(r.pdf_path);
      if (!abierto) {
        const ruta = await regenerarPdf(r);
        window.api.openPdf(ruta);
      }
    });
  }

  // Guarda la ficha (alta o edición) y, si se pasa estadoNuevo, reactiva en el
  // mismo paso: así al volver a septiembre se puede corregir nivel/precio/horas
  // y dar de alta a la vez, sin tener que reactivar primero y editar después.
  const guardarFicha = async (estadoNuevo) => {
    const v = (id) => document.getElementById(id)?.value.trim();
    const nombreSolo = v('a-nombre');
    const apellidos = v('a-apellidos') || null;
    const fila = {
      // La ficha ahora pide nombre y apellidos por separado (antes había que
      // escribir el apellido dos veces); el nombre completo que usan los
      // recibos, la búsqueda, etc. se sigue guardando junto, como siempre.
      nombre: [nombreSolo, apellidos].filter(Boolean).join(' '),
      apellidos,
      telefono: quitarEspacios(v('a-tel')) || null,
      tutor_nombre: v('a-tutor') || null,
      fecha_alta: v('a-alta') || null,
      facturacion_nombre: v('a-fact-nombre') || null,
      facturacion_direccion: v('a-fact-dir') || null,
      notas: v('a-notas') || null,
      descuento_extra: esAdmin ? (Number(v('a-descuento')) || 0) : undefined,
      empieza_proximo_mes: document.getElementById('a-empieza-prox-mes').checked
    };
    // Padres separados: si se desmarca, se limpian los datos del reparto (no
    // dejar configuración vieja colgando de una familia que ya no la usa).
    const padresSeparados = document.getElementById('a-padres-sep').checked;
    fila.padres_separados = padresSeparados;
    if (padresSeparados) {
      fila.madre_nombre = v('a-madre-nombre') || null;
      fila.madre_telefono = quitarEspacios(v('a-madre-tel')) || null;
      fila.padre_nombre = v('a-padre-nombre') || null;
      fila.padre_telefono = quitarEspacios(v('a-padre-tel')) || null;
      const repartoCustom = document.getElementById('a-reparto-custom').checked;
      fila.madre_porcentaje = repartoCustom ? Number(v('a-madre-pct')) || 50 : 50;
    } else {
      fila.madre_nombre = null;
      fila.madre_telefono = null;
      fila.padre_nombre = null;
      fila.padre_telefono = null;
      fila.madre_porcentaje = 50;
    }
    if (estadoNuevo) fila.estado = estadoNuevo;
    if (!esAdmin) delete fila.descuento_extra; // el profesor no lo toca, no se envía
    if (!nombreSolo) return msg('El nombre es obligatorio.');
    if (padresSeparados && (!fila.madre_telefono || !fila.padre_telefono)) {
      return msg('Si los padres están separados, hacen falta los dos teléfonos.');
    }
    if (padresSeparados && (fila.madre_porcentaje <= 0 || fila.madre_porcentaje >= 100)) {
      return msg('El % de la madre tiene que estar entre 1 y 99.');
    }
    if (ms.some(m => !m.asignatura_id)) return msg('Elige la asignatura en cada fila.');
    if (esAdmin && ms.some(m => m.tarifa !== '' && m.tarifa != null && Number(m.tarifa) <= 0)) {
      return msg('Si pones un precio, tiene que ser mayor que 0.');
    }

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
      const tarifaNueva = (m.tarifa === '' || m.tarifa == null) ? null : Number(m.tarifa);
      const datos = {
        alumno_id: alumnoId,
        asignatura_id: Number(m.asignatura_id),
        tarifa: tarifaNueva,
        tipo_tarifa: m.tipo_tarifa,
        horas_semana: m.horas_semana ? Number(m.horas_semana) : null
      };
      // Solo se marca "quién lo completó" cuando de verdad se acaba de poner
      // precio a una matrícula que no lo tenía — para que el aviso de
      // "fichas sin precio" se entere de esta transición concreta, y no
      // salga ruido cada vez que se toca cualquier otra cosa de una
      // matrícula que ya tenía precio de antes.
      if (m.id && tarifasOriginales.get(m.id) == null && tarifaNueva != null) {
        datos.actualizado_por = S.profesor.id;
        datos.actualizado_en = new Date().toISOString();
      }
      const { error } = m.id
        ? await S.sb.from('matriculas').update(datos).eq('id', m.id)
        : await S.sb.from('matriculas').insert(datos);
      if (error) return msg(errorMatricula(error));
    }
    // Si reactiva un profesor (no la admin), se avisa a la admin para que lo revise.
    if (estadoNuevo === 'activo' && !esAdmin) {
      await S.sb.from('reactivaciones_alumno').insert({ alumno_id: alumnoId, profesor_id: S.profesor.id });
    }
    cerrarModal();
    await Promise.all([cargarAlumnos(), cargarReactivaciones()]);
    renderAlumnos();
    avisar(estadoNuevo ? `${fila.nombre} reactivado.` : (alumno ? 'Ficha actualizada.' : 'Alumno dado de alta.'));
  };

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('m-guardar').onclick = () => guardarFicha();
}

// Da de baja al alumno de TODO: todas las asignaturas y todas las clases,
// pero conserva sus matrículas (por si vuelve, para no reintroducir precio
// y horas de cero) y su ficha entera bajo el filtro "Bajas".
async function confirmarBajaCompleta(alumno) {
  if (!confirm(`Vas a dar de baja a ${alumno.nombre} de TODO: todas las asignaturas y todas las clases. La ficha se conserva en el filtro "Bajas" por si vuelve. ¿Continuar?`)) return;
  const { error } = await S.sb.rpc('dar_baja_alumno', { p_alumno: alumno.id });
  if (error) return avisar('Error: ' + error.message, true);
  cerrarModal();
  await Promise.all([cargarAlumnos(), cargarClases()]);
  renderAlumnos();
  avisar(`${alumno.nombre} dado de baja. Su ficha sigue en el filtro "Bajas".`);
}

// Da de baja al alumno de UNA sola asignatura: se borra esa matrícula (y sus
// clases de esa asignatura), pero sigue activo en el resto — a diferencia de
// la baja completa, aquí no tiene sentido conservar la matrícula porque no
// es "todo el alumno" lo que pausa, solo esa asignatura concreta. El
// histórico de recibos no depende de las matrículas, así que no se toca.
async function confirmarBajaAsignatura(alumno, asignaturaId, nombreAsignatura) {
  if (!confirm(`¿Dar de baja a ${alumno.nombre} de ${nombreAsignatura}? Dejará de salir en esa asignatura; su historial de recibos se conserva igual.`)) return;
  const { error } = await S.sb.rpc('dar_baja_asignatura', { p_alumno: alumno.id, p_asignatura: asignaturaId });
  if (error) { avisar('Error: ' + error.message, true); return; }
  // Si lo hace un profesor (no la admin), se avisa a la admin para que
  // revise el precio de la ficha (puede que ya no le corresponda el
  // descuento por varias asignaturas).
  if (!S.profesor?.es_admin) {
    await S.sb.from('bajas_asignatura').insert({
      alumno_id: alumno.id, asignatura_id: asignaturaId, profesor_id: S.profesor.id
    });
  }
  cerrarModal();
  await Promise.all([cargarAlumnos(), cargarClases(), cargarBajasAsignatura()]);
  renderAlumnos();
  avisar(`${alumno.nombre} dado de baja de ${nombreAsignatura}.`);
}

// Si el profesor que da de baja tiene más de una asignatura propia con este
// alumno, deja elegir cuál; si solo tiene una, va directo sin preguntar.
function modalElegirAsignaturaBaja(alumno, matriculasPropias) {
  if (matriculasPropias.length === 1) {
    const m = matriculasPropias[0];
    return confirmarBajaAsignatura(alumno, m.asignatura_id, m.asignaturas?.nombre || '');
  }
  abrirModal(`
  <h2>¿De qué asignatura? — ${e(alumno.nombre)}</h2>
  <ul class="detalle-alumnos">
    ${matriculasPropias.map(m => `<li>
      <button class="btn chico peligro" data-baja-asig="${m.asignatura_id}">Dar de baja</button>
      &nbsp;${e(m.asignaturas?.nombre || '')}
    </li>`).join('')}
  </ul>
  <div class="pie-modal"><button class="btn liso" id="m-cancelar">Cancelar</button></div>`);
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.querySelectorAll('[data-baja-asig]').forEach(b => b.onclick = () => {
    const asignaturaId = Number(b.dataset.bajaAsig);
    const m = matriculasPropias.find(x => x.asignatura_id === asignaturaId);
    confirmarBajaAsignatura(alumno, asignaturaId, m?.asignaturas?.nombre || '');
  });
}

// Punto de entrada del botón "Sistema de bajas": si el alumno solo tiene una
// asignatura en total, es una baja completa directa (no hay nada que
// "separar"). Si tiene varias, deja elegir entre dar de baja solo una de las
// tuyas o la baja completa — la baja completa solo se ofrece si todas las
// asignaturas del alumno son tuyas (o eres admin): no tiene sentido que un
// profesor pueda desapuntar de golpe una asignatura que no es la suya.
function modalSistemaBajas(alumno) {
  const esAdmin = S.profesor?.es_admin;
  const todasMats = alumno.matriculas || [];
  const misMats = misMatriculas(alumno);

  if (todasMats.length <= 1) return confirmarBajaCompleta(alumno);

  const puedeBajaCompleta = esAdmin || misMats.length === todasMats.length;
  abrirModal(`
  <h2>Sistema de bajas — ${e(alumno.nombre)}</h2>
  <p class="ayuda">Este alumno está apuntado a ${todasMats.length} asignaturas.</p>
  <div class="pie-modal columna">
    ${misMats.length ? '<button class="btn liso" id="sb-una">Dar de baja de una asignatura</button>' : ''}
    ${puedeBajaCompleta ? '<button class="btn liso peligro" id="sb-completa">Dar de baja completa (de todo)</button>' : ''}
    <button class="btn liso" id="m-cancelar">Cancelar</button>
  </div>
  ${!puedeBajaCompleta ? '<p class="ayuda">También está en asignaturas de otro profesor, así que solo puedes darle de baja de las tuyas.</p>' : ''}`);
  document.getElementById('m-cancelar').onclick = cerrarModal;
  const btnUna = document.getElementById('sb-una');
  if (btnUna) btnUna.onclick = () => modalElegirAsignaturaBaja(alumno, misMats);
  const btnCompleta = document.getElementById('sb-completa');
  if (btnCompleta) btnCompleta.onclick = () => confirmarBajaCompleta(alumno);
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

// ---------------------------------------------------------------- modificaciones de horas

// Busca un alumno y cambia las horas semanales de una asignatura suya,
// dejando constancia del cambio (avisa al administrador en Inicio).
function modalModificaciones() {
  const esAdmin = S.profesor?.es_admin;
  abrirModal(`
  <h2>Modificación horas alumnos</h2>
  <p class="ayuda">Busca al alumno y cambia las horas semanales de la asignatura que quieras.
  El cambio queda registrado y avisa al administrador.</p>
  <label>Buscar alumno<input id="md-buscar" type="search" placeholder="Nombre del alumno…"></label>
  <div id="md-resultados"></div>
  <div class="pie-modal"><button class="btn liso" id="m-cancelar">Cerrar</button></div>`);

  document.getElementById('m-cancelar').onclick = cerrarModal;
  const $buscar = document.getElementById('md-buscar');

  const pintarResultados = () => {
    const texto = $buscar.value.trim().toLowerCase();
    const candidatos = !texto ? [] : S.alumnos.filter(a => {
      if (a.estado !== 'activo' || !a.nombre.toLowerCase().includes(texto)) return false;
      return (esAdmin ? (a.matriculas || []) : misMatriculas(a)).length > 0;
    }).slice(0, 8);

    document.getElementById('md-resultados').innerHTML = candidatos.length === 0
      ? (texto ? '<p class="ayuda">Sin resultados.</p>' : '')
      : candidatos.map(a => `
      <div class="md-alumno">
        <strong>${e(a.nombre)}</strong>
        ${(esAdmin ? (a.matriculas || []) : misMatriculas(a)).map(m => `
        <div class="fila-horario">
          <span class="md-asig">${e(m.asignaturas?.nombre || '')}</span>
          <span class="ayuda">ahora: ${m.horas_semana ?? '—'} h/sem${esAdmin ? ` · ${formatoImporte(m.tarifa)}€/${m.tipo_tarifa === 'clase' ? 'clase' : 'mes'}` : ''}</span>
          <input type="number" min="0" step="0.5" placeholder="horas nuevas" data-nueva-hora="${m.id}" class="ancho-horas">
          ${esAdmin ? `<input type="number" min="0" step="0.01" placeholder="precio nuevo" data-nuevo-precio="${m.id}" class="ancho-tarifa">` : ''}
          <button class="btn chico" data-guardar-hora="${m.id}" data-alumno="${a.id}" data-antes="${m.horas_semana ?? ''}">Guardar</button>
        </div>`).join('')}
      </div>`).join('');

    document.querySelectorAll('[data-guardar-hora]').forEach(b => b.onclick = async () => {
      const input = document.querySelector(`[data-nueva-hora="${b.dataset.guardarHora}"]`);
      const inputPrecio = esAdmin ? document.querySelector(`[data-nuevo-precio="${b.dataset.guardarHora}"]`) : null;
      const cambiaHoras = input.value !== '';
      const cambiaPrecio = inputPrecio && inputPrecio.value !== '';
      if (!cambiaHoras && !cambiaPrecio) return avisar('Introduce las horas o el precio nuevos.', true);

      const datos = {};
      let nueva = null, antes = null;
      if (cambiaHoras) {
        nueva = Number(input.value);
        if (nueva < 0) return avisar('Las horas no pueden ser negativas.', true);
        antes = b.dataset.antes ? Number(b.dataset.antes) : null;
        datos.horas_semana = nueva;
      }
      if (cambiaPrecio) {
        const nuevoPrecio = Number(inputPrecio.value);
        if (nuevoPrecio <= 0) return avisar('Si cambias el precio, tiene que ser mayor que 0.', true);
        datos.tarifa = nuevoPrecio;
      }
      const { error: e1 } = await S.sb.from('matriculas').update(datos).eq('id', b.dataset.guardarHora);
      if (e1) return avisar('Error: ' + e1.message, true);
      if (cambiaHoras) {
        await S.sb.from('cambios_horario').insert({
          matricula_id: b.dataset.guardarHora, alumno_id: b.dataset.alumno,
          profesor_id: S.profesor.id, horas_antes: antes, horas_despues: nueva
        });
      }
      await Promise.all([cargarAlumnos(), cargarCambiosHorario()]);
      avisar('Actualizado.');
      pintarResultados();
    });
  };
  $buscar.oninput = () => conFocoPreservado(pintarResultados);
}

// Vista para el administrador de los cambios de horas que no ha revisado aún.
function etiquetaCambioHorario(c) {
  return `<strong>${e(c.alumnos?.nombre || '')}</strong> — ${c.horas_antes ?? '—'} → ${c.horas_despues} h/sem
    <br><small>${e(c.profesores?.nombre || '')} · ${fmtFecha(String(c.fecha).slice(0, 10))}</small>`;
}
function filaCambioHorario(c) {
  if (c.visto && c.visto_por !== S.profesor.id) {
    return filaAvisoResuelto('cambio', c.id, etiquetaCambioHorario(c), nombreProfesor(c.visto_por));
  }
  return `<li data-item="${c.id}">${etiquetaCambioHorario(c)}
    <br>
    <button class="btn chico" data-editar-cambio="${c.id}" data-alumno-cambio="${c.alumno_id}">Editar ficha</button>
    <button class="btn chico liso" data-visto-cambio="${c.id}">✓ Visto</button>
  </li>`;
}
// "Marcar todas": si de verdad estaba pendiente, la resuelve (visto=true);
// si ya la había resuelto OTRO admin y solo me faltaba a mí, la descarta.
async function resolverCambioHorario(c) {
  if (!c.visto) {
    await S.sb.from('cambios_horario').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', c.id);
  } else {
    await marcarDescartado('cambio', c.id);
  }
}
function activarBotonesCambiosHorario() {
  document.querySelectorAll('[data-visto-cambio]').forEach(b => b.onclick = async () => {
    await S.sb.from('cambios_horario').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', b.dataset.vistoCambio);
    await cargarCambiosHorario();
    cerrarModal();
    if (S.vista === 'inicio') renderInicio();
    avisar('Marcado como visto.');
  });
  document.querySelectorAll('[data-editar-cambio]').forEach(b => b.onclick = async () => {
    await S.sb.from('cambios_horario').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', b.dataset.editarCambio);
    await cargarCambiosHorario();
    cerrarModal();
    modalAlumno(S.alumnos.find(a => a.id === b.dataset.alumnoCambio));
  });
}
function modalModificacionesSinVer(lista) {
  abrirModal(`
  <h2>Modificación horas alumnos sin revisar</h2>
  <ul class="detalle-alumnos" id="av-cambios" style="columns:1">
    ${lista.map(filaCambioHorario).join('')}
  </ul>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cerrar sin marcar</button>
    <button class="btn primario" id="md-marcar-vistas">Marcar todas como vistas</button>
  </div>`);
  avisoAbierto = { tipo: 'cambios', ids: lista.map(c => c.id) };
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('md-marcar-vistas').onclick = async () => {
    await Promise.all(lista.map(resolverCambioHorario));
    await Promise.all([cargarCambiosHorario(), cargarAvisosDescartados()]);
    cerrarModal();
    if (S.vista === 'inicio') renderInicio();
    avisar('Modificaciones marcadas como vistas.');
  };
  activarBotonesCambiosHorario();
  activarMarcarVistoAviso();
}

// Alumnos que un profesor (no la admin) ha reactivado: ella puede entrar a
// corregir la ficha (nivel, precio, horas…) o simplemente marcarlo como visto.
function etiquetaReactivacion(r) {
  return `<strong>${e(r.alumnos?.nombre || '')}</strong>
    <br><small>Reactivado por ${e(r.profesores?.nombre || '')} · ${fmtFecha(String(r.fecha).slice(0, 10))}</small>`;
}
function filaReactivacion(r) {
  if (r.visto && r.visto_por !== S.profesor.id) {
    return filaAvisoResuelto('reactivacion', r.id, etiquetaReactivacion(r), nombreProfesor(r.visto_por));
  }
  return `<li data-item="${r.id}">${etiquetaReactivacion(r)}
    <br>
    <button class="btn chico" data-editar-reactivacion="${r.id}" data-alumno-reactivacion="${r.alumno_id}">Editar ficha</button>
    <button class="btn chico liso" data-visto-reactivacion="${r.id}">✓ Visto</button>
  </li>`;
}
async function resolverReactivacion(r) {
  if (!r.visto) {
    await S.sb.from('reactivaciones_alumno').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', r.id);
  } else {
    await marcarDescartado('reactivacion', r.id);
  }
}
function activarBotonesReactivaciones() {
  document.querySelectorAll('[data-visto-reactivacion]').forEach(b => b.onclick = async () => {
    await S.sb.from('reactivaciones_alumno').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', b.dataset.vistoReactivacion);
    await cargarReactivaciones();
    cerrarModal();
    if (S.vista === 'inicio') renderInicio();
    avisar('Marcado como visto.');
  });
  document.querySelectorAll('[data-editar-reactivacion]').forEach(b => b.onclick = async () => {
    await S.sb.from('reactivaciones_alumno').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', b.dataset.editarReactivacion);
    await cargarReactivaciones();
    cerrarModal();
    modalAlumno(S.alumnos.find(a => a.id === b.dataset.alumnoReactivacion));
  });
}
function modalReactivacionesSinVer(lista) {
  abrirModal(`
  <h2>Alumnos reactivados por profesores</h2>
  <ul class="detalle-alumnos" id="av-reactivaciones" style="columns:1">
    ${lista.map(filaReactivacion).join('')}
  </ul>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cerrar sin marcar</button>
    <button class="btn primario" id="rv-marcar-vistas">Marcar todas como vistas</button>
  </div>`);
  avisoAbierto = { tipo: 'reactivaciones', ids: lista.map(r => r.id) };
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('rv-marcar-vistas').onclick = async () => {
    await Promise.all(lista.map(resolverReactivacion));
    await Promise.all([cargarReactivaciones(), cargarAvisosDescartados()]);
    cerrarModal();
    if (S.vista === 'inicio') renderInicio();
    avisar('Reactivaciones marcadas como vistas.');
  };
  activarBotonesReactivaciones();
  activarMarcarVistoAviso();
}

// Alumnos que un profesor (no la admin) ha dado de baja de UNA asignatura:
// la admin puede entrar a revisar el precio (puede que ya no le corresponda
// el descuento por varias asignaturas) o simplemente marcarlo como visto.
function etiquetaBajaAsignatura(b) {
  return `<strong>${e(b.alumnos?.nombre || '')}</strong> — baja de ${e(b.asignaturas?.nombre || '')}
    <br><small>${e(b.profesores?.nombre || '')} · ${fmtFecha(String(b.fecha).slice(0, 10))}</small>`;
}
function filaBajaAsignatura(b) {
  if (b.visto && b.visto_por !== S.profesor.id) {
    return filaAvisoResuelto('baja_asignatura', b.id, etiquetaBajaAsignatura(b), nombreProfesor(b.visto_por));
  }
  return `<li data-item="${b.id}">${etiquetaBajaAsignatura(b)}
    <br>
    <button class="btn chico" data-editar-baja-asig="${b.id}" data-alumno-baja-asig="${b.alumno_id}">Editar ficha</button>
    <button class="btn chico liso" data-visto-baja-asig="${b.id}">✓ Visto</button>
  </li>`;
}
async function resolverBajaAsignatura(b) {
  if (!b.visto) {
    await S.sb.from('bajas_asignatura').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', b.id);
  } else {
    await marcarDescartado('baja_asignatura', b.id);
  }
}
function activarBotonesBajasAsignatura() {
  document.querySelectorAll('[data-visto-baja-asig]').forEach(b => b.onclick = async () => {
    await S.sb.from('bajas_asignatura').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', b.dataset.vistoBajaAsig);
    await cargarBajasAsignatura();
    cerrarModal();
    if (S.vista === 'inicio') renderInicio();
    avisar('Marcado como visto.');
  });
  document.querySelectorAll('[data-editar-baja-asig]').forEach(b => b.onclick = async () => {
    await S.sb.from('bajas_asignatura').update({ visto: true, visto_por: S.profesor.id, visto_en: new Date().toISOString() }).eq('id', b.dataset.editarBajaAsig);
    await cargarBajasAsignatura();
    cerrarModal();
    modalAlumno(S.alumnos.find(a => a.id === b.dataset.alumnoBajaAsig));
  });
}
function modalBajasAsignaturaSinVer(lista) {
  abrirModal(`
  <h2>Bajas de asignatura sin revisar</h2>
  <ul class="detalle-alumnos" id="av-bajas" style="columns:1">
    ${lista.map(filaBajaAsignatura).join('')}
  </ul>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cerrar sin marcar</button>
    <button class="btn primario" id="ba-marcar-vistas">Marcar todas como vistas</button>
  </div>`);
  avisoAbierto = { tipo: 'bajas', ids: lista.map(b => b.id) };
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('ba-marcar-vistas').onclick = async () => {
    await Promise.all(lista.map(resolverBajaAsignatura));
    await Promise.all([cargarBajasAsignatura(), cargarAvisosDescartados()]);
    cerrarModal();
    if (S.vista === 'inicio') renderInicio();
    avisar('Bajas de asignatura marcadas como vistas.');
  };
  activarBotonesBajasAsignatura();
  activarMarcarVistoAviso();
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
      const cap = c.capacidad || 6;
      const col = colorClase(c);
      return `<div class="clase-tile" data-abrir-clase="${c.id}"
        style="background:${col.fondo}; border-top-color:${col.borde}">
        <div class="tile-nombre">${e(c.nombre)}</div>
        <div class="tile-asig">${e(c.asignaturas?.nombre || '')}</div>
        <div class="tile-horario">${e(textoHorarios(c))}</div>
        <div class="tile-pie">${n}/${cap} alumnos${n >= cap ? ' · lleno' : ''}${esAdmin ? ' · ' + e(c.profesores?.nombre || '') : ''}</div>
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
  <h3 class="seccion">Alumnos (${alumnos.length}/${clase.capacidad || 6})${alumnos.length >= (clase.capacidad || 6) ? ' — grupo lleno' : ''}</h3>
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
    <label>Aforo (máx. alumnos)<select id="c-aforo">
      ${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}" ${(c.capacidad || 6) === n ? 'selected' : ''}>${n}</option>`).join('')}
    </select></label>
    <label>Notas<input id="c-notas" value="${e(c.notas || '')}"></label>
  </div>
  <p class="ayuda">Cuando el grupo llegue a su aforo, esa hora deja de salir como "hueco libre" en el horario.</p>
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
      capacidad: Number(document.getElementById('c-aforo').value),
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
      <button class="seg ${modo === 'huecos' ? 'activo' : ''}" data-modo="huecos">Huecos libres</button>
    </div>
    ${modo === 'mes' ? `
    <div class="mes-nav">
      <button class="btn chico liso" id="mes-ant">‹</button>
      <strong>${MESES[S.mesVisto.mes]} ${S.mesVisto.anio}</strong>
      <button class="btn chico liso" id="mes-sig">›</button>
    </div>` : ''}
    ${(() => {
      if (modo !== 'huecos') return '';
      const idObjetivo = esAdmin ? S.filtros.profesor : S.profesor.id;
      const tramos = idObjetivo ? S.profesorHorario.filter(h => h.profesor_id === idObjetivo) : [];
      if (idObjetivo && !tramos.length) return `
      <label class="inline">Desde <input type="time" id="hu-desde" value="${e(S.huecosDesde || '16:00')}"></label>
      <label class="inline">hasta <input type="time" id="hu-hasta" value="${e(S.huecosHasta || '21:00')}"></label>`;
      return '';
    })()}
    <span class="flex1"></span>
    ${esAdmin ? `<select id="fh-prof">
      <option value="">${modo === 'huecos' ? 'Elige un profesor…' : 'Todos los profesores'}</option>
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === S.filtros.profesor ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select>` : ''}
    ${modo !== 'huecos' ? '<button class="btn" id="btn-alternativa">+ Clase alternativa</button>' : ''}
  </div>
  ${modo === 'huecos' ? htmlHuecos(esAdmin ? S.filtros.profesor : S.profesor.id, esAdmin)
    : (sesiones.length === 0 ? `<div class="vacio">No hay clases con horario todavía.<br>
      <small>Crea grupos en la pestaña Clases y asígnales días y horas.</small></div>`
      : (modo === 'semana' ? htmlSemana(sesiones, esAdmin) : htmlMes(sesiones)))}`;

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
  const huDesde = document.getElementById('hu-desde');
  const huHasta = document.getElementById('hu-hasta');
  if (huDesde) huDesde.onchange = (ev) => { S.huecosDesde = ev.target.value; renderHorario(); };
  if (huHasta) huHasta.onchange = (ev) => { S.huecosHasta = ev.target.value; renderHorario(); };
  const btnAlt = document.getElementById('btn-alternativa');
  if (btnAlt) btnAlt.onclick = () => modalClaseAlternativa();
  document.querySelectorAll('[data-ver-clase]').forEach(el => el.onclick = () =>
    modalDetalleClase(S.clases.find(c => c.id === el.dataset.verClase), el.dataset.fecha || undefined));
  document.querySelectorAll('[data-ver-alt]').forEach(el => el.onclick = () =>
    modalDetalleAlternativa(S.excepciones.find(x => x.id === el.dataset.verAlt)));
}

// ---- Huecos libres: tramos sin clase en el horario fijo de cada día ----

function minutosDeHora(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutosAHora(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Resta los tramos ocupados (horarios de clase) al rango [desde, hasta] de un día.
function huecosLibresDia(sesionesDia, desdeMin, hastaMin) {
  const ocupados = sesionesDia
    .map(s => {
      const ini = minutosDeHora(horaCorta(s.hora));
      return [ini, ini + (s.duracion_min || 60)];
    })
    .sort((a, b) => a[0] - b[0]);
  const libres = [];
  let cursor = desdeMin;
  for (const [ini, fin] of ocupados) {
    if (ini > cursor) libres.push([cursor, Math.min(ini, hastaMin)]);
    cursor = Math.max(cursor, fin);
    if (cursor >= hastaMin) break;
  }
  if (cursor < hastaMin) libres.push([cursor, hastaMin]);
  return libres.filter(([a, b]) => b > a);
}

// Huecos libres de un profesor concreto. Usa su horario de trabajo (Ajustes)
// si lo tiene configurado; si no, el horario genérico ajustable Desde/Hasta.
// Un grupo con plazas libres (no lleno) no bloquea su hora: se muestra aparte
// como "hay sitio", no como ocupado.
function htmlHuecos(profesorId, esAdmin) {
  if (esAdmin && !profesorId) {
    return '<div class="vacio">Elige un profesor arriba para ver sus huecos libres.</div>';
  }

  const clasesDelProfesor = S.clases.filter(c => c.profesor_id === profesorId);
  const porDia = Array.from({ length: 7 }, () => []);
  for (const c of clasesDelProfesor) {
    for (const h of c.clase_horarios || []) porDia[h.dia_semana - 1].push({ ...h, clase: c });
  }

  const tramosProfesor = S.profesorHorario.filter(h => h.profesor_id === profesorId);
  const tramosPorDia = new Map();
  for (const t of tramosProfesor) {
    if (!tramosPorDia.has(t.dia_semana)) tramosPorDia.set(t.dia_semana, []);
    tramosPorDia.get(t.dia_semana).push(t);
  }
  const configurado = tramosProfesor.length > 0;

  let diasBloques; // [{ dia: 0-6, rangos: [[desdeMin, hastaMin], ...] }]
  if (configurado) {
    diasBloques = [...tramosPorDia.keys()].sort((a, b) => a - b).map(diaSemana => ({
      dia: diaSemana - 1,
      rangos: tramosPorDia.get(diaSemana)
        .map(t => [minutosDeHora(horaCorta(t.hora_inicio)), minutosDeHora(horaCorta(t.hora_fin))])
        .sort((a, b) => a[0] - b[0])
    }));
  } else {
    const desde = minutosDeHora(S.huecosDesde || '16:00');
    const hasta = minutosDeHora(S.huecosHasta || '21:00');
    if (hasta <= desde) return '<div class="vacio">La hora "hasta" debe ser posterior a "desde".</div>';
    const diasConClase = new Set();
    porDia.forEach((lista, i) => { if (lista.length) diasConClase.add(i); });
    const dias = [0, 1, 2, 3, 4, ...(diasConClase.has(5) ? [5] : []), ...(diasConClase.has(6) ? [6] : [])];
    diasBloques = dias.map(d => ({ dia: d, rangos: [[desde, hasta]] }));
  }

  const avisoConfig = configurado ? '' : `<p class="ayuda" style="margin-bottom:14px">
    ⚠ Este profesor no ha configurado su horario de trabajo (Ajustes → Mi horario de trabajo);
    se está usando un horario genérico de ${e(S.huecosDesde || '16:00')} a ${e(S.huecosHasta || '21:00')}.</p>`;

  return avisoConfig + `<div class="horario-grid" style="grid-template-columns: repeat(${diasBloques.length}, 1fr)">
    ${diasBloques.map(({ dia, rangos }) => {
      const entradasDia = porDia[dia];
      const bloques = rangos.map(([desdeMin, hastaMin]) => {
        const llenas = entradasDia.filter(s => (s.clase.clase_alumnos || []).length >= (s.clase.capacidad || 6));
        const conSitio = entradasDia.filter(s => {
          const dentro = (s.clase.clase_alumnos || []).length < (s.clase.capacidad || 6);
          const ini = minutosDeHora(horaCorta(s.hora));
          return dentro && ini >= desdeMin && ini < hastaMin;
        });
        const libres = huecosLibresDia(llenas, desdeMin, hastaMin);
        const cartasLibres = libres.map(([a, b]) => `<div class="hueco-card">${minutosAHora(a)}–${minutosAHora(b)}</div>`).join('');
        const cartasGrupo = conSitio.map(s => {
          const n = (s.clase.clase_alumnos || []).length;
          const cap = s.clase.capacidad || 6;
          const restantes = cap - n;
          return `<div class="hueco-grupo-card" data-ver-clase="${s.clase.id}">
            ${horaCorta(s.hora)}–${horaFin(s.hora, s.duracion_min)} · ${e(s.clase.nombre)}
            <small>quedan ${restantes} plaza${restantes === 1 ? '' : 's'}</small></div>`;
        }).join('');
        return cartasLibres + cartasGrupo;
      }).join('');
      return `<div class="dia-col">
        <div class="dia-titulo">${DIAS[dia]}</div>
        ${bloques || '<div class="dia-libre">Sin huecos</div>'}
      </div>`;
    }).join('')}
  </div>
  <p class="ayuda" style="margin-top:14px">En verde, tiempo totalmente libre. En azul, grupos que aún tienen
  plazas (no bloquean la hora hasta llegar a su aforo). No descuenta anulaciones puntuales ni sesiones alternativas.</p>`;
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
  const nMesTotal = todasMats.filter(m => m.tipo_tarifa === 'mes' && m.tarifa != null).length;

  abrirModal(`
  <h2>Recibo — ${e(alumno.nombre)}</h2>
  <p class="ayuda">Marca las asignaturas a cobrar y los meses. El concepto y el importe se calculan
  solos con los descuentos que le correspondan, y puedes ajustarlos.
  Si este mes ha hecho horas de más, apúntalas en "Extra".</p>
  <div class="detalle-horarios">
    ${todasMats.map(m => `<label class="mes"><input type="checkbox" data-mat="${m.id}" ${idsMias.has(m.id) ? 'checked' : ''}>
      ${e(m.asignaturas?.nombre || '')} · ${formatoImporte(m.tarifa)}€/${m.tipo_tarifa === 'clase' ? 'clase' : 'mes'}</label>`).join('')}
  </div>
  <p class="ayuda" id="r-descuentos"></p>
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
  <label class="check-inline" style="margin-top:10px">
    <input type="checkbox" id="r-matricula"> Añadir matrícula (aparte, va a Ingresos &gt; Matrícula)
  </label>
  <input id="r-importe-matricula" type="number" min="0" step="0.01" placeholder="Importe de la matrícula (€)" style="display:none; margin-top:6px">
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
  const $matriculaChk = document.getElementById('r-matricula');
  const $matriculaImporte = document.getElementById('r-importe-matricula');

  // Descuentos del alumno (hermanos, varias asignaturas, especial), consultados
  // una vez al abrir el recibo — misma fuente que usa la generación automática.
  let descuentos = { descuento_multi: 0, descuento_hermano: 0, descuento_extra: 0 };
  S.sb.rpc('calcular_descuentos_alumno', { p_alumno_id: alumno.id }).then(({ data }) => {
    const $descuentos = document.getElementById('r-descuentos');
    if (!$descuentos) return; // el modal ya se cerró antes de que respondiera
    const d = data?.[0];
    if (d) {
      descuentos = d;
      const partes = [];
      if (d.descuento_multi > 0) partes.push(`−${formatoImporte(d.descuento_multi)}€/mes por varias asignaturas`);
      if (d.descuento_hermano > 0) partes.push(`−${formatoImporte(d.descuento_hermano)}€/mes por hermano/a`);
      if (d.descuento_extra > 0) partes.push(`−${formatoImporte(d.descuento_extra)}€/mes descuento especial`);
      $descuentos.textContent = partes.length ? 'Descuentos: ' + partes.join(' · ') : '';
    }
    recalcular();
  });

  const recalcular = () => {
    const meses = mesesMarcados(cont);
    const extra = Number($extra.value) || 0;
    const desc = $extraDesc.value.trim();
    const conMatricula = $matriculaChk.checked;
    const importeMatricula = conMatricula ? (Number($matriculaImporte.value) || 0) : 0;

    let concepto = conceptoDesdeMeses(meses) + (extra && desc ? ' + ' + desc : '');
    if (conMatricula) concepto += ' + Matrícula';
    $concepto.value = concepto;

    const marcadas = [...cont.querySelectorAll('[data-mat]:checked')]
      .map(ch => todasMats.find(m => m.id === ch.dataset.mat)).filter(Boolean);
    const marcadasMes = marcadas.filter(m => m.tipo_tarifa === 'mes');
    const marcadasClase = marcadas.filter(m => m.tipo_tarifa === 'clase');

    const baseMes = marcadasMes.reduce((s, m) => s + Number(m.tarifa), 0) * meses.length;
    const baseClase = marcadasClase.reduce((s, m) => s + Number(m.tarifa), 0);
    // Los tres descuentos son un importe FIJO al mes (5€ cada uno, no por
    // asignatura): si el alumno tiene 2+ asignaturas de pago mensual son
    // -5€ en total, no -5€ por cada una.
    const descMulti = nMesTotal >= 2 ? 5 * meses.length : 0;
    const descHermano = (descuentos.descuento_hermano > 0 && marcadasMes.length) ? descuentos.descuento_hermano * meses.length : 0;
    const descExtra = (descuentos.descuento_extra > 0 && marcadasMes.length) ? descuentos.descuento_extra * meses.length : 0;

    const total = Math.max(0, baseMes - descMulti - descHermano - descExtra) + baseClase + extra + importeMatricula;
    $importe.value = total || '';
    $letras.textContent = importeALetras($importe.value || 0);
  };
  cont.querySelectorAll('[data-mes]').forEach(c => c.onchange = recalcular);
  cont.querySelectorAll('[data-mat]').forEach(c => c.onchange = recalcular);
  $extra.oninput = recalcular;
  $extraDesc.oninput = recalcular;
  $importe.oninput = () => { $letras.textContent = importeALetras($importe.value || 0); };
  $matriculaChk.onchange = () => {
    $matriculaImporte.style.display = $matriculaChk.checked ? '' : 'none';
    recalcular();
  };
  $matriculaImporte.oninput = recalcular;
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
      const recibos = await crearRecibos(alumno, {
        concepto, importe,
        recibiDe: document.getElementById('r-recibide').value.trim() || alumno.nombre,
        fechaEmision: document.getElementById('r-fecha').value.trim() || hoyDDMMAAAA(),
        periodos: periodosMarcados(cont, 'r'),
        importeMatricula: $matriculaChk.checked ? (Number($matriculaImporte.value) || 0) : 0
      });
      cerrarModal();
      await cargarRecibos();
      modalReciboListo(recibos);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Generar recibo PDF';
      document.getElementById('m-msg').textContent = 'Error: ' + err.message;
    }
  };
}

// Crea el recibo: fila en BD + PDF en disco. Devuelve la fila con datos del alumno.
// `progenitor` ('madre'|'padre'|null) solo se usa con alumnos de padres
// separados — ver crearRecibos(), que es quien decide si hace 1 o 2.
async function crearRecibo(alumno, { concepto, importe, recibiDe, fechaEmision, periodos, importeMatricula }, progenitor = null) {
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
    periodos: periodos && periodos.length ? periodos : null,
    incluye_matricula: Boolean(importeMatricula),
    importe_matricula: importeMatricula || 0,
    progenitor
  }).select('*').single();
  if (error) throw new Error(error.message);

  const referencia = 'R-' + String(fila.referencia).padStart(5, '0');
  const bytes = await generarReciboPdf({
    fechaEmision, recibiDe,
    cantidadLetras: letras,
    concepto,
    desglose: desgloseDeRecibo(concepto, importe, importeMatricula) || undefined,
    totalCifra: formatoImporte(importe),
    referencia,
    logoPngBase64: S.logoBase64
  });
  const filename = nombreArchivoRecibo(alumno.nombre, concepto);
  const pdfPath = await window.api.savePdf(Array.from(bytes), filename);
  await S.sb.from('recibos').update({ pdf_path: pdfPath }).eq('id', fila.id);
  return { ...fila, pdf_path: pdfPath, alumnos: alumno };
}

// Decide si al alumno le corresponde 1 recibo normal o 2 (uno por
// progenitor, con su % de la mensualidad y de la matrícula) cuando tiene
// padres separados. El importe del padre es el RESTO del de la madre (no
// se redondean los dos por separado) para que la suma cuadre siempre con
// el total exacto, sin descuadres de un céntimo.
async function crearRecibos(alumno, opts) {
  if (!alumno.padres_separados) return [await crearRecibo(alumno, opts)];
  const pctMadre = Number(alumno.madre_porcentaje) || 50;
  const pctPadre = 100 - pctMadre;
  const round2 = (n) => Math.round(n * 100) / 100;
  const importeMadre = round2(opts.importe * pctMadre / 100);
  const importePadre = round2(opts.importe - importeMadre);
  const importeMatriculaMadre = opts.importeMatricula ? round2(opts.importeMatricula * pctMadre / 100) : 0;
  const importeMatriculaPadre = opts.importeMatricula ? round2(opts.importeMatricula - importeMatriculaMadre) : 0;
  const madre = await crearRecibo(alumno, {
    ...opts, importe: importeMadre, importeMatricula: importeMatriculaMadre,
    recibiDe: alumno.madre_nombre || opts.recibiDe,
    concepto: `${opts.concepto} (Madre · ${pctMadre}%)`
  }, 'madre');
  const padre = await crearRecibo(alumno, {
    ...opts, importe: importePadre, importeMatricula: importeMatriculaPadre,
    recibiDe: alumno.padre_nombre || opts.recibiDe,
    concepto: `${opts.concepto} (Padre · ${pctPadre}%)`
  }, 'padre');
  return [madre, padre];
}

// Si el recibo lleva matrícula aparte, se desglosa en el PDF en dos líneas
// (mes y matrícula, cada una con su precio) en vez de una sola de "Concepto:".
// Sin matrícula se deja tal cual, como toda la vida.
function desgloseDeRecibo(concepto, importe, importeMatricula) {
  if (!importeMatricula) return null;
  const base = String(concepto || '').replace(/ \+ Matrícula$/, '');
  const importeBase = Number(importe) - Number(importeMatricula);
  return [
    `${base} — ${formatoImporte(importeBase)}€`,
    `Matrícula — ${formatoImporte(importeMatricula)}€`
  ];
}

// Teléfono/nombre a usar para un recibo concreto: si es de un progenitor
// (padres separados), el suyo; si no, la cadena de siempre.
function telefonoDeRecibo(recibo) {
  const a = recibo.alumnos || {};
  if (recibo.progenitor === 'madre') return a.madre_telefono;
  if (recibo.progenitor === 'padre') return a.padre_telefono;
  return a.telefono || a.tutor_telefono;
}
function destinatarioDeRecibo(recibo) {
  const a = recibo.alumnos || {};
  if (recibo.progenitor === 'madre') return a.madre_nombre || a.tutor_nombre || a.nombre || '';
  if (recibo.progenitor === 'padre') return a.padre_nombre || a.tutor_nombre || a.nombre || '';
  return a.facturacion_nombre || a.tutor_nombre || a.nombre || '';
}

// El concepto interno de un recibo de padres separados lleva "(Madre · 33%)"
// / "(Padre · 67%)" para poder distinguirlos en la app — pero eso es un
// detalle interno que no debe salir en el mensaje de WhatsApp que lee la
// familia, así que se quita solo de cara al envío.
function conceptoSinProgenitor(concepto) {
  return String(concepto || '').replace(/\s*\((?:Madre|Padre)\s*·\s*\d+%\)\s*$/, '');
}

function modalReciboListo(recibos) {
  const lista = Array.isArray(recibos) ? recibos : [recibos];
  abrirModal(`
  <h2>Recibo${lista.length > 1 ? 's' : ''} generado${lista.length > 1 ? 's' : ''} ✓</h2>
  ${lista.map((recibo, i) => {
    const tel = telefonoDeRecibo(recibo);
    return `
    <p>${recibo.progenitor ? `<strong>${recibo.progenitor === 'madre' ? 'Madre' : 'Padre'}:</strong> ` : ''}${e(recibo.alumnos?.nombre || '')} — ${e(recibo.concepto)} — <strong>${formatoImporte(recibo.importe)}€</strong></p>
    <p class="ayuda">PDF guardado como <code>${e(recibo.pdf_path)}</code></p>
    <div class="pie-modal columna">
      <button class="btn" data-rl-abrir="${i}">Ver PDF</button>
      <button class="btn" data-rl-carpeta="${i}">Mostrar en carpeta</button>
      <button class="btn primario" data-rl-wa="${i}" ${tel ? '' : 'disabled title="No hay teléfono registrado"'}>Enviar por WhatsApp</button>
    </div>`;
  }).join('<hr>')}
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cerrar</button>
  </div>
  <p class="ayuda">Al pulsar “Enviar por WhatsApp” se abre el chat con el mensaje escrito y la carpeta
  del PDF: arrastra el archivo al chat y envíalo.</p>`);
  document.getElementById('m-cancelar').onclick = () => { cerrarModal(); if (S.vista === 'recibos') renderRecibos(); };
  lista.forEach((recibo, i) => {
    document.querySelector(`[data-rl-abrir="${i}"]`).onclick = () => window.api.openPdf(recibo.pdf_path);
    document.querySelector(`[data-rl-carpeta="${i}"]`).onclick = () => window.api.revealPdf(recibo.pdf_path);
    const wa = document.querySelector(`[data-rl-wa="${i}"]`);
    if (telefonoDeRecibo(recibo)) wa.onclick = () => enviarWhatsApp(recibo);
  });
}

async function enviarWhatsApp(recibo) {
  const tel = telefonoDeRecibo(recibo);
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

// ---- Envío automático por la API oficial de WhatsApp ----

// Convierte los bytes del PDF a texto para poder mandarlo al servidor.
// Se hace por trozos porque un PDF entero de golpe desborda la pila.
function bytesABase64(bytes) {
  let binario = '';
  const trozo = 0x8000;
  for (let i = 0; i < bytes.length; i += trozo) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + trozo));
  }
  return btoa(binario);
}

// Envía un recibo (o el justificante de pago) con el PDF ya adjunto.
// Devuelve { ok, simulado, error } — nunca lanza, para poder usarlo en tandas.
async function enviarPorWhatsAppApi(recibo, tipo = 'recibo') {
  // Si tiene hermanos con un recibo pendiente de este mismo envío, se manda
  // todo junto en un solo mensaje/PDF en vez de uno por hermano.
  const esPago = tipo === 'pago';
  const hermanos = recibosHermanosDe(recibo).filter(h => esPago ? !h.fecha_envio_whatsapp_pago : !h.fecha_envio_whatsapp);
  if (hermanos.length) return enviarPorWhatsAppApiConjunto([recibo, ...hermanos], tipo);

  const alumno = recibo.alumnos || {};
  const tel = telefonoDeRecibo(recibo);
  if (!telefonoWa(tel)) return { ok: false, error: 'sin teléfono válido' };
  const destinatario = destinatarioDeRecibo(recibo);

  try {
    const letras = recibo.importe_letras || importeALetras(recibo.importe);
    const bytes = await generarReciboPdf({
      fechaEmision: fmtFecha(recibo.fecha_emision),
      recibiDe: destinatario,
      cantidadLetras: letras,
      concepto: recibo.concepto,
      desglose: desgloseDeRecibo(recibo.concepto, recibo.importe, recibo.importe_matricula) || undefined,
      totalCifra: formatoImporte(recibo.importe),
      referencia: 'R-' + String(recibo.referencia).padStart(5, '0'),
      logoPngBase64: S.logoBase64,
      pagado: esPago,
      fechaPago: esPago ? fmtFecha((recibo.fecha_pago || new Date().toISOString()).slice(0, 10)) : null
    });

    const { data, error } = await S.sb.functions.invoke('enviar-whatsapp', {
      body: {
        tipo,
        telefono: tel,
        nombre: destinatario.split(' ')[0] || destinatario,
        concepto: conceptoSinProgenitor(recibo.concepto),
        importe: formatoImporte(recibo.importe),
        pdfBase64: bytesABase64(bytes),
        nombreArchivo: nombreArchivoRecibo(alumno.nombre || 'alumno', recibo.concepto, esPago)
      }
    });
    if (error) return { ok: false, error: 'el servidor rechazó el envío' };
    if (!data?.ok) return { ok: false, error: data?.error || 'error desconocido' };

    // Con un envío real (no simulado) guardamos el id del mensaje: es lo que
    // luego usa el webhook para saber a qué recibo corresponde cada aviso de
    // "entregado"/"leído"/"fallido" que llegue de Meta.
    const actualizacion = {};
    if (esPago) actualizacion.fecha_envio_whatsapp_pago = new Date().toISOString();
    else actualizacion.fecha_envio_whatsapp = new Date().toISOString();
    if (!data.simulado && data.mensajeId) {
      actualizacion.whatsapp_message_id = data.mensajeId;
      actualizacion.estado_whatsapp = 'enviado';
    }
    if (Object.keys(actualizacion).length) {
      const { error: errorUpdate } = await S.sb.from('recibos').update(actualizacion).eq('id', recibo.id);
      if (errorUpdate) return { ok: false, error: 'enviado, pero no se pudo guardar el estado: ' + errorUpdate.message };
    }
    return { ok: true, simulado: Boolean(data.simulado), idsIncluidos: [recibo.id] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Recibo conjunto de hermanos: un solo PDF con el desglose de cada uno y un
// solo envío por WhatsApp al teléfono de la familia. Al terminar, marca
// TODOS los recibos incluidos como enviados (no solo el que lo disparó).
// La plantilla de WhatsApp solo admite 2 parámetros de texto fijos (nombre,
// concepto) — el desglose completo con los importes va en el PDF adjunto;
// el "concepto" del mensaje solo lleva los nombres de los hermanos incluidos.
async function enviarPorWhatsAppApiConjunto(recibos, tipo = 'recibo') {
  const esPago = tipo === 'pago';
  const primero = recibos[0];
  const tel = telefonoDeRecibo(primero);
  if (!telefonoWa(tel)) return { ok: false, error: 'sin teléfono válido' };
  const destinatario = destinatarioDeRecibo(primero);
  const total = recibos.reduce((s, r) => s + Number(r.importe), 0);
  // Solo nombres + concepto de cada hermano, para que se sepa quiénes van
  // incluidos — sin el importe de cada uno, que solo se ve dentro del PDF.
  const conceptoCombinado = recibos
    .map(r => `${(r.alumnos?.nombre || '').split(' ')[0]}: ${conceptoSinProgenitor(r.concepto)}`)
    .join(' + ');

  try {
    const desglose = recibos.map(r => `${r.alumnos?.nombre || ''} — ${r.concepto} — ${formatoImporte(r.importe)}€`);
    const bytes = await generarReciboPdf({
      fechaEmision: fmtFecha(primero.fecha_emision),
      recibiDe: destinatario,
      cantidadLetras: importeALetras(total),
      desglose,
      totalCifra: formatoImporte(total),
      referencia: recibos.map(r => 'R-' + String(r.referencia).padStart(5, '0')).join(' / '),
      logoPngBase64: S.logoBase64,
      pagado: esPago,
      fechaPago: esPago ? fmtFecha((primero.fecha_pago || new Date().toISOString()).slice(0, 10)) : null
    });

    const { data, error } = await S.sb.functions.invoke('enviar-whatsapp', {
      body: {
        tipo,
        telefono: tel,
        nombre: destinatario.split(' ')[0] || destinatario,
        concepto: conceptoCombinado,
        importe: formatoImporte(total),
        pdfBase64: bytesABase64(bytes),
        nombreArchivo: nombreArchivoRecibo(recibos.map(r => r.alumnos?.nombre).join('_'), 'hermanos', esPago)
      }
    });
    if (error) return { ok: false, error: 'el servidor rechazó el envío' };
    if (!data?.ok) return { ok: false, error: data?.error || 'error desconocido' };

    // fecha_envio_whatsapp(_pago) se pone en TODOS los recibos incluidos —
    // pero whatsapp_message_id tiene un índice ÚNICO en la base de datos (lo
    // usa el webhook para saber a qué recibo corresponde un "leído" que
    // llegue de Meta), así que el mismo id de mensaje no se puede repetir en
    // varias filas: solo se guarda en la primera, el resto se queda sin él
    // (comparten el mismo envío, así que su estado de entrega también vale).
    const fechaCampo = esPago ? 'fecha_envio_whatsapp_pago' : 'fecha_envio_whatsapp';
    const actualizacionPrimero = { [fechaCampo]: new Date().toISOString() };
    if (!data.simulado && data.mensajeId) {
      actualizacionPrimero.whatsapp_message_id = data.mensajeId;
      actualizacionPrimero.estado_whatsapp = 'enviado';
    }
    const { error: errorPrimero } = await S.sb.from('recibos').update(actualizacionPrimero).eq('id', primero.id);
    if (errorPrimero) return { ok: false, error: 'enviado, pero no se pudo guardar el estado: ' + errorPrimero.message };

    const resto = recibos.slice(1);
    if (resto.length) {
      const { error: errorResto } = await S.sb.from('recibos')
        .update({ [fechaCampo]: actualizacionPrimero[fechaCampo] })
        .in('id', resto.map(r => r.id));
      if (errorResto) return { ok: false, error: 'enviado, pero no se pudo guardar el estado de todos: ' + errorResto.message };
    }
    return { ok: true, simulado: Boolean(data.simulado), idsIncluidos: recibos.map(r => r.id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Envío masivo por tandas, con progreso y resumen final. tipo='recibo' manda
// el recibo normal; tipo='pago' manda el justificante de pago (mismo PDF,
// sellado como PAGADO).
function modalEnvioMasivo(lista, tipo = 'recibo') {
  const esPago = tipo === 'pago';
  const conTelefono = lista.filter(r => telefonoWa(telefonoDeRecibo(r)));
  const sinTelefono = lista.length - conTelefono.length;
  const TANDA = 10;

  abrirModal(`
  <h2>Enviar ${esPago ? 'justificantes de pago' : 'recibos'} por WhatsApp</h2>
  <p class="ayuda">Se enviarán <strong>${conTelefono.length}</strong> ${esPago ? 'justificantes' : 'recibos'} con el PDF ya adjunto,
  en tandas de ${TANDA} para poder seguirlo con calma.
  ${sinTelefono ? `<br>⚠ ${sinTelefono} ${esPago ? 'justificante' : 'recibo'}${sinTelefono === 1 ? '' : 's'} sin teléfono válido se omitirá${sinTelefono === 1 ? '' : 'n'}.` : ''}</p>
  <div id="em-progreso"></div>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="em-enviar" ${conTelefono.length ? '' : 'disabled'}>Enviar ${conTelefono.length}</button>
  </div>`);

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('em-enviar').onclick = async () => {
    const btn = document.getElementById('em-enviar');
    const cancelar = document.getElementById('m-cancelar');
    const prog = document.getElementById('em-progreso');
    btn.disabled = true;
    cancelar.disabled = true;
    const fallos = [];
    let enviados = 0, simulado = false;
    // Si dos hermanos están seleccionados a la vez, el primero ya manda el
    // combinado de los dos — el segundo se salta para no repetir el envío.
    const procesados = new Set();

    for (let i = 0; i < conTelefono.length; i++) {
      const r = conTelefono[i];
      if (procesados.has(r.id)) continue;
      prog.innerHTML = `<p class="letras">Enviando ${i + 1} de ${conTelefono.length}…
        <strong>${e(r.alumnos?.nombre || '')}</strong></p>`;
      const res = await enviarPorWhatsAppApi(r, tipo);
      if (res.ok) {
        const ids = res.idsIncluidos || [r.id];
        enviados += ids.length;
        ids.forEach(id => procesados.add(id));
        simulado = simulado || res.simulado;
      } else fallos.push(`${r.alumnos?.nombre || 'Alumno'} — ${res.error}`);
      // Respiro entre tandas para no saturar el envío.
      if ((i + 1) % TANDA === 0 && i + 1 < conTelefono.length) {
        prog.innerHTML = `<p class="ayuda">Pausa entre tandas… (${i + 1} de ${conTelefono.length})</p>`;
        await new Promise(res2 => setTimeout(res2, 1500));
      }
    }

    await cargarRecibos();
    prog.innerHTML = `
      <p class="letras"><strong>${enviados}</strong> enviado${enviados === 1 ? '' : 's'}${fallos.length ? ` · ${fallos.length} con problema` : ''}</p>
      ${simulado ? '<p class="ayuda">⚠ WhatsApp aún no está configurado: ha sido una simulación, no se ha enviado nada real.</p>' : ''}
      ${fallos.length ? `<ul class="detalle-alumnos">${fallos.map(f => `<li>${e(f)}</li>`).join('')}</ul>` : ''}`;
    cancelar.disabled = false;
    cancelar.textContent = 'Cerrar';
    cancelar.onclick = () => { cerrarModal(); renderRecibos(); };
    btn.remove();
  };
}

// Mismo criterio que usa el servidor para el descuento de hermanos, pero en
// local (evita una llamada por alumno dentro de un bucle de generación).
function tieneHermano(alumno) {
  if (!alumno.apellidos || !alumno.apellidos.trim()) return false;
  const norm = (s) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  const miApellido = norm(alumno.apellidos);
  return S.alumnos.some(a2 => a2.id !== alumno.id && a2.estado === 'activo' && a2.apellidos && norm(a2.apellidos) === miApellido);
}

// De un grupo de hermanos, solo UNO se lleva el descuento de 5€ (no cada
// uno por separado — se envían en un recibo conjunto, así que restarlo a
// cada uno lo contaría 2 o 3 veces). El "designado" es el de id más bajo
// del grupo, incluyéndose a sí mismo — mismo criterio que usa el servidor
// en calcular_descuentos_alumno(), para que ambos coincidan siempre.
function esHermanoDesignado(alumno) {
  if (!tieneHermano(alumno)) return false; // sin hermano de verdad, no hay descuento que designar
  const norm = (s) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  const miApellido = norm(alumno.apellidos);
  const idsFamilia = S.alumnos
    .filter(a2 => a2.estado === 'activo' && a2.apellidos && norm(a2.apellidos) === miApellido)
    .map(a2 => a2.id);
  return idsFamilia.every(id => id >= alumno.id);
}

// Recibos de hermanos de `r` que están en el MISMO paso de la cadena
// (pendientes con pendientes, pagados con pagados — no tiene sentido
// juntar un pendiente con uno ya cobrado) y del mismo mes de emisión. No se
// guarda ningún enlace en la base de datos: se calcula al vuelo cada vez,
// igual que tieneHermano(), así que funciona con 2 hermanos o con 3 (ya hay
// una familia real de 3 en la base de datos) y da igual quién ni cuándo
// generó cada recibo por separado.
function recibosHermanosDe(r) {
  const alumno = S.alumnos.find(a => a.id === r.alumno_id);
  if (!alumno || !tieneHermano(alumno)) return [];
  const norm = (s) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  const miApellido = norm(alumno.apellidos);
  const idsHermanos = new Set(S.alumnos
    .filter(a2 => a2.id !== alumno.id && a2.estado === 'activo' && a2.apellidos && norm(a2.apellidos) === miApellido)
    .map(a2 => a2.id));
  const mesR = claveMes(r.fecha_emision);
  return S.recibos.filter(r2 => r2.id !== r.id && idsHermanos.has(r2.alumno_id)
    && claveMes(r2.fecha_emision) === mesR && r2.estado === r.estado);
}

function modalReciboBulk() {
  const candidatos = alumnosFiltrados().filter(a => a.estado === 'activo' && misMatriculas(a).some(m => m.tarifa != null));
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
        const misMats = misMatriculas(a);
        const misMesMats = misMats.filter(m => m.tipo_tarifa === 'mes' && m.tarifa != null);
        const misClaseMats = misMats.filter(m => m.tipo_tarifa === 'clase' && m.tarifa != null);
        const nMesTotalAlumno = (a.matriculas || []).filter(m => m.tipo_tarifa === 'mes' && m.tarifa != null).length;
        const baseMes = misMesMats.reduce((s, m) => s + Number(m.tarifa), 0) * meses.length;
        const baseClase = misClaseMats.reduce((s, m) => s + Number(m.tarifa), 0);
        const descMulti = nMesTotalAlumno >= 2 ? 5 * meses.length : 0;
        const descHermano = (misMesMats.length && esHermanoDesignado(a)) ? 5 * meses.length : 0;
        const descExtra = (misMesMats.length && a.descuento_extra > 0) ? a.descuento_extra * meses.length : 0;
        const importe = Math.max(0, baseMes - descMulti - descHermano - descExtra) + baseClase;
        if (importe <= 0) { mal++; continue; }
        const generados = await crearRecibos(a, {
          concepto, importe,
          recibiDe: a.facturacion_nombre || a.tutor_nombre || a.nombre,
          fechaEmision: hoyDDMMAAAA(),
          periodos: periodosMarcados(cont, 'b')
        });
        ok += generados.length;
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
    recibiDe: destinatarioDeRecibo(r),
    cantidadLetras: letras,
    concepto: r.concepto,
    desglose: desgloseDeRecibo(r.concepto, r.importe, r.importe_matricula) || undefined,
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
  const t = (f.textoRecibo || '').toLowerCase().trim();
  return S.recibos.filter(r => {
    if (t) {
      const refFormateada = `r-${String(r.referencia).padStart(5, '0')}`;
      const coincide = (r.alumnos?.nombre || '').toLowerCase().includes(t)
        || (r.concepto || '').toLowerCase().includes(t)
        || refFormateada.includes(t)
        || String(r.referencia).includes(t);
      if (!coincide) return false;
    }
    return !f.profesor || r.profesor_id === f.profesor;
  });
}

function claveMes(fechaIso) {
  return String(fechaIso || '').slice(0, 7); // "2026-07"
}

function tituloMes(clave) {
  const [anio, mes] = clave.split('-').map(Number);
  return `${MESES[(mes || 1) - 1]} ${anio || ''}`;
}

// Un solo estado por fila que cuenta la cadena completa (en vez de dos chips
// sueltos de "estado" + "envío" que no dejaban claro en qué paso iba cada
// recibo): sin enviar el recibo no tiene sentido hablar de "cobro" (el
// alumno/tutor ni sabe que tiene que pagar), y una vez cobrado lo que queda
// por seguir es el justificante de PAGO, no el recibo original.
function estadoRecibo(r, pagados) {
  if (!pagados) {
    return r.fecha_envio_whatsapp
      ? { clase: 'envio-no', texto: 'Pendiente por cobrar' }
      : { clase: 'pendiente', texto: 'Pendiente de envío' };
  }
  return r.fecha_envio_whatsapp_pago
    ? { clase: 'pagado', texto: 'Cobrado y enviado' }
    : { clase: 'envio-no', texto: 'Cobrado y por enviar' };
}

// Modal pequeño de "¿efectivo o banco?", reutilizado tanto al marcar un
// recibo cobrado como al corregir la cuenta de uno ya cobrado.
function modalElegirCuentaCobro(titulo, mensaje, onElegir) {
  abrirModal(`
  <h2>${e(titulo)}</h2>
  <p class="ayuda">${mensaje}</p>
  <div class="pie-modal columna">
    <button class="btn primario" id="ec-efectivo">💶 Efectivo</button>
    <button class="btn primario" id="ec-banco">🏦 Banco</button>
    <button class="btn liso" id="m-cancelar">Cancelar</button>
  </div>`);
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('ec-efectivo').onclick = () => onElegir('efectivo');
  document.getElementById('ec-banco').onclick = () => onElegir('banco');
}

// Anotación de "han pagado parte, no todo" — puramente visual/informativa:
// no toca estado ni Ingresos y gastos, solo deja constancia de cuánto han
// dado ya para que el personal lo vea de un vistazo. El recibo sigue en
// Pendiente de cobrar hasta que se marque "✓ Cobrado" de verdad con el
// resto (ahí sí se contabiliza el total, por la cuenta que se elija).
function modalPagoIncompleto(r) {
  abrirModal(`
  <h2>Pago incompleto — ${e(r.alumnos?.nombre || '')}</h2>
  <p class="ayuda">Solo es una nota para que se vea a simple vista cuánto han pagado ya de este recibo
  (${formatoImporte(r.importe)}€ en total). No cambia el estado ni mueve nada en Ingresos y gastos —
  eso pasa cuando se marque "✓ Cobrado" con el resto.</p>
  <label>¿Cuánto han pagado? (€)<input id="pi-importe" type="number" min="0.01" step="0.01" value="${r.importe_parcial ?? ''}"></label>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="pi-guardar">Guardar</button>
  </div>
  <p id="m-msg" class="error"></p>`);
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('pi-guardar').onclick = async () => {
    const importe = Number(document.getElementById('pi-importe').value);
    const msg = document.getElementById('m-msg');
    if (!importe || importe <= 0) { msg.textContent = 'Pon un importe mayor que 0.'; return; }
    if (importe >= Number(r.importe)) { msg.textContent = `Tiene que ser menos que el total del recibo (${formatoImporte(r.importe)}€) — si ya han pagado todo, usa "✓ Cobrado".`; return; }
    const { error } = await S.sb.from('recibos').update({ importe_parcial: importe }).eq('id', r.id);
    if (error) { msg.textContent = 'Error: ' + error.message; return; }
    await cargarRecibos();
    cerrarModal();
    renderRecibos();
    avisar('Anotado.');
  };
}

function filasRecibos(lista, esAdmin, pagados, seleccionables) {
  return `<table>
    <thead><tr>
      ${seleccionables ? '<th></th>' : ''}
      <th>Alumno</th><th>Concepto</th><th>Total</th>
      ${esAdmin ? '<th>Profesor</th>' : ''}<th>Estado</th><th></th>
    </tr></thead>
    <tbody>
    ${lista.map(r => {
      const estado = estadoRecibo(r, pagados);
      const hermanos = recibosHermanosDe(r);
      return `<tr>
      ${seleccionables ? `<td><input type="checkbox" data-check="${r.id}" ${S.recibosSeleccionados.has(r.id) ? 'checked' : ''}></td>` : ''}
      <td><strong>${e(r.alumnos?.nombre || '')}</strong><br>
        <small>R-${String(r.referencia).padStart(5, '0')} · ${e((r.fecha_emision || '').split('-').reverse().join('/'))}</small></td>
      <td>${e(r.concepto)}</td>
      <td><strong>${formatoImporte(r.importe)}€</strong></td>
      ${esAdmin ? `<td>${e(r.profesores?.nombre || '')}</td>` : ''}
      <td><span class="chip ${estado.clase}">${estado.texto}</span>
        ${pagados && r.cuenta ? `<span class="chip activo">${r.cuenta === 'banco' ? 'Banco' : 'Efectivo'}</span>` : ''}
        ${!pagados && r.importe_parcial ? `<span class="chip pago-parcial">${formatoImporte(r.importe_parcial)}€ de ${formatoImporte(r.importe)}€ cobrados</span>` : ''}
        ${r.progenitor ? `<span class="chip envio-si" title="Recibo repartido entre los dos progenitores">${r.progenitor === 'madre' ? 'Madre' : 'Padre'}</span>` : ''}
        ${hermanos.length ? `<span class="chip activo" title="Junto con: ${e(hermanos.map(h => h.alumnos?.nombre || '').join(', '))}">👪 Recibo hermanos</span>` : ''}
        ${r.estado_whatsapp === 'fallido' ? '<span class="chip wa-fallido" title="WhatsApp no pudo entregarlo: revisa el teléfono">Fallido</span>'
          : r.estado_whatsapp === 'leido' ? '<span class="chip wa-leido">Leído</span>'
          : r.estado_whatsapp === 'entregado' ? '<span class="chip wa-por-leer">Por leer</span>'
          : ''}</td>
      <td class="acciones">
        ${pagados
          ? (esAdmin ? `<button class="btn chico liso" data-despagar="${r.id}">↩ Pendiente</button>
             <button class="btn chico liso" data-editar-cuenta="${r.id}" title="Corregir efectivo/banco">✎</button>` : '')
          : `<button class="btn chico pagar" data-pagar="${r.id}">✓ Cobrado</button>
             <button class="btn chico liso" data-pago-incompleto="${r.id}" title="Anotar que han pagado solo una parte">Pago incompleto</button>
             ${esAdmin ? `<button class="btn chico liso" data-wa="${r.id}">WhatsApp</button>` : ''}
             <button class="btn chico liso" data-editar-recibo="${r.id}" title="Editar recibo">✏️</button>`}
        <button class="btn chico liso" data-pdf="${r.id}">PDF</button>
        <button class="btn chico liso peligro" data-borrar-recibo="${r.id}" title="Eliminar recibo">✕</button>
      </td>
    </tr>`;}).join('')}
    </tbody>
  </table>`;
}

// Barra ‹ mes › compartida por las pestañas de Recibos y la vista por alumno
// (mismo patrón que ya usa Finanzas). Devuelve el HTML y dice qué meses hay.
function mesesConRecibos() {
  const mesActual = claveMes(new Date().toISOString());
  const mesesConDatos = S.recibos.map(r => claveMes(r.fecha_emision)).sort();
  const primerMes = mesesConDatos.length ? mesesConDatos[0] : mesActual;
  const ultimoMes = mesesConDatos.length && mesesConDatos[mesesConDatos.length - 1] > mesActual
    ? mesesConDatos[mesesConDatos.length - 1] : mesActual;
  return mesesEntre(primerMes, ultimoMes).reverse();
}

function barraMesRecibos() {
  const meses = mesesConRecibos();
  const mesActual = claveMes(new Date().toISOString());
  if (!S.mesRecibos || !meses.includes(S.mesRecibos)) S.mesRecibos = meses.includes(mesActual) ? mesActual : (meses[0] || mesActual);
  const esElMasReciente = S.mesRecibos === meses[0];
  const esElMasAntiguo = S.mesRecibos === meses[meses.length - 1];
  return `
  <div class="mes-nav">
    <button class="btn chico liso" id="rc-mes-ant" ${esElMasAntiguo ? 'disabled' : ''}>‹</button>
    <select id="rc-mes">
      ${meses.map(m => `<option value="${m}" ${m === S.mesRecibos ? 'selected' : ''}>${tituloMes(m)}</option>`).join('')}
    </select>
    <button class="btn chico liso" id="rc-mes-sig" ${esElMasReciente ? 'disabled' : ''}>›</button>
  </div>`;
}

function cambiarMesRecibos(nuevo) {
  if (nuevo === S.mesRecibos) return;
  S.mesRecibos = nuevo;
  S.recibosSeleccionados.clear();
  if (S.vistaRosterRecibos) renderRecibosPorAlumno(); else renderRecibos();
}

function renderRecibos() {
  if (S.vistaRosterRecibos) return renderRecibosPorAlumno();

  const esAdmin = S.profesor?.es_admin;
  const sub = (['enviar', 'pagados-enviar'].includes(S.vistaRecibos) && !esAdmin) ? 'pendientes' : (S.vistaRecibos || 'pendientes');
  const barraMes = barraMesRecibos(); // fija S.mesRecibos por defecto antes de filtrar
  const lista = recibosFiltrados();
  const delMes = lista.filter(r => claveMes(r.fecha_emision) === S.mesRecibos);
  const noPagados = delMes.filter(r => r.estado !== 'pagado');
  const pagados = delMes.filter(r => r.estado === 'pagado');
  // Cadena de estados: sin enviar el recibo no tiene sentido "pendiente de
  // cobro" (el alumno/tutor ni sabe que hay que pagar), así que un recibo sin
  // enviar sale solo en "Pendientes de envío" y desaparece de ahí en cuanto
  // se manda — nunca están en las dos pestañas a la vez.
  const porEnviar = noPagados.filter(r => !r.fecha_envio_whatsapp);
  const pendientesCobro = noPagados.filter(r => r.fecha_envio_whatsapp);
  const pagadosPorEnviar = pagados.filter(r => !r.fecha_envio_whatsapp_pago);
  // La pestaña activa (si es una de las dos "por enviar") y su tipo de envío,
  // para que el bloque de casillas/selección de abajo sirva para las dos.
  const listaEnviable = sub === 'pagados-enviar' ? pagadosPorEnviar : porEnviar;
  const tipoEnviable = sub === 'pagados-enviar' ? 'pago' : 'recibo';

  let cuerpo = '';
  if (sub === 'enviar' || sub === 'pagados-enviar') {
    const total = listaEnviable.reduce((s, r) => s + Number(r.importe), 0);
    const nSeleccionados = listaEnviable.filter(r => S.recibosSeleccionados.has(r.id)).length;
    const todosMarcados = listaEnviable.length > 0 && nSeleccionados === listaEnviable.length;
    const mensajeVacio = sub === 'pagados-enviar'
      ? 'No hay justificantes de pago por enviar este mes. 🎉'
      : 'No hay recibos por enviar este mes. 🎉';
    const etiquetaLista = sub === 'pagados-enviar' ? 'cobrado' : 'por enviar';
    cuerpo = listaEnviable.length === 0
      ? `<div class="vacio">${mensajeVacio}</div>`
      : `<h3 class="mes-seccion">${tituloMes(S.mesRecibos)}
          <small>${listaEnviable.length} ${etiquetaLista} · ${formatoImporte(total)}€</small>
          <button class="btn chico" id="rc-marcar-todos">${todosMarcados ? 'Quitar selección' : 'Seleccionar todos'}</button>
          <button class="btn primario chico" id="rc-enviar-seleccionados" ${nSeleccionados ? '' : 'disabled'}>📤 Enviar seleccionados (${nSeleccionados})</button></h3>
        ${filasRecibos(listaEnviable, esAdmin, sub === 'pagados-enviar', true)}`;
  } else if (sub === 'pagados') {
    const total = pagados.reduce((s, r) => s + Number(r.importe), 0);
    cuerpo = pagados.length === 0
      ? `<div class="vacio">Todavía no hay recibos cobrados este mes.</div>`
      : `<h3 class="mes-seccion">${tituloMes(S.mesRecibos)}
          <small>${pagados.length} cobrado${pagados.length === 1 ? '' : 's'}${esAdmin ? ` · ${formatoImporte(total)}€` : ''}</small>
          <button class="btn chico" id="rc-descargar-mes">⬇ Descargar todos los PDF</button></h3>
        ${filasRecibos(pagados, esAdmin, true)}`;
  } else {
    const total = pendientesCobro.reduce((s, r) => s + Number(r.importe), 0);
    cuerpo = pendientesCobro.length === 0
      ? `<div class="vacio">No hay recibos pendientes de cobro este mes. 🎉</div>`
      : `<h3 class="mes-seccion">${tituloMes(S.mesRecibos)}
          <small>${pendientesCobro.length} pendiente${pendientesCobro.length === 1 ? '' : 's'}${esAdmin ? ` · ${formatoImporte(total)}€` : ''}</small>
          <button class="btn chico" id="rc-descargar-mes">⬇ Descargar todos los PDF</button></h3>
        ${filasRecibos(pendientesCobro, esAdmin, false)}`;
  }

  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <div class="segmentos">
      ${esAdmin ? `<button class="seg ${sub === 'enviar' ? 'activo' : ''}" data-sub="enviar">Pendientes de envío${porEnviar.length ? ` (${porEnviar.length})` : ''}</button>` : ''}
      <button class="seg ${sub === 'pendientes' ? 'activo' : ''}" data-sub="pendientes">Pendientes de cobrar${pendientesCobro.length ? ` (${pendientesCobro.length})` : ''}</button>
      <button class="seg ${sub === 'pagados' ? 'activo' : ''}" data-sub="pagados">Cobrados</button>
      ${esAdmin ? `<button class="seg ${sub === 'pagados-enviar' ? 'activo' : ''}" data-sub="pagados-enviar">Justificantes por enviar${pagadosPorEnviar.length ? ` (${pagadosPorEnviar.length})` : ''}</button>` : ''}
    </div>
    ${barraMes}
    <input id="fr-texto" type="search" placeholder="Buscar por alumno, concepto o referencia (R-00001)…" value="${e(S.filtros.textoRecibo)}">
    ${esAdmin ? `<select id="fr-prof">
      <option value="">Todos los profesores</option>
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === S.filtros.profesor ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select>` : ''}
    <span class="flex1"></span>
    ${esAdmin ? '<button class="btn liso" id="rc-por-alumno">Ver por alumno</button>' : ''}
    <button class="btn" id="fr-csv">Exportar CSV</button>
  </div>
  ${cuerpo}`;

  document.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => {
    S.vistaRecibos = b.dataset.sub;
    S.recibosSeleccionados.clear();
    renderRecibos();
  });
  const rcMesAnt = document.getElementById('rc-mes-ant');
  const rcMesSig = document.getElementById('rc-mes-sig');
  const rcMes = document.getElementById('rc-mes');
  if (rcMesAnt) rcMesAnt.onclick = () => { const m = mesesConRecibos(); cambiarMesRecibos(m[m.indexOf(S.mesRecibos) + 1]); };
  if (rcMesSig) rcMesSig.onclick = () => { const m = mesesConRecibos(); cambiarMesRecibos(m[m.indexOf(S.mesRecibos) - 1]); };
  if (rcMes) rcMes.onchange = (ev) => cambiarMesRecibos(ev.target.value);
  document.getElementById('fr-texto').oninput = (ev) => { S.filtros.textoRecibo = ev.target.value; conFocoPreservado(renderRecibos); };
  const fp = document.getElementById('fr-prof');
  if (fp) fp.onchange = (ev) => { S.filtros.profesor = ev.target.value; renderRecibos(); };
  document.getElementById('fr-csv').onclick = exportarRecibosCsv;
  const rcPorAlumno = document.getElementById('rc-por-alumno');
  if (rcPorAlumno) rcPorAlumno.onclick = () => { S.vistaRosterRecibos = true; renderRecibosPorAlumno(); };
  document.querySelectorAll('[data-check]').forEach(cb => cb.onchange = () => {
    if (cb.checked) S.recibosSeleccionados.add(cb.dataset.check); else S.recibosSeleccionados.delete(cb.dataset.check);
    renderRecibos();
  });
  const rcDescargarMes = document.getElementById('rc-descargar-mes');
  if (rcDescargarMes) rcDescargarMes.onclick = () => {
    descargarPdfsMes(S.mesRecibos, sub === 'pagados' ? pagados : pendientesCobro, rcDescargarMes);
  };
  const rcMarcarTodos = document.getElementById('rc-marcar-todos');
  if (rcMarcarTodos) rcMarcarTodos.onclick = () => {
    const todosMarcados = listaEnviable.length > 0 && listaEnviable.every(r => S.recibosSeleccionados.has(r.id));
    listaEnviable.forEach(r => todosMarcados ? S.recibosSeleccionados.delete(r.id) : S.recibosSeleccionados.add(r.id));
    renderRecibos();
  };
  const rcEnviarSel = document.getElementById('rc-enviar-seleccionados');
  if (rcEnviarSel) rcEnviarSel.onclick = () => {
    const seleccion = listaEnviable.filter(r => S.recibosSeleccionados.has(r.id));
    if (!seleccion.length) return;
    S.recibosSeleccionados.clear();
    modalEnvioMasivo(seleccion, tipoEnviable);
  };

  document.querySelectorAll('[data-pagar]').forEach(b => b.onclick = () => {
    const r = S.recibos.find(x => x.id === b.dataset.pagar);
    if (!r) return;
    // Hermanos con recibo del mismo mes aún sin cobrar: se cobran a la vez,
    // como una sola gestión familiar (se mandaron juntos, se cobran juntos).
    // Limitación conocida: si alguno de esos hermanos tiene padres separados,
    // esto también une sus dos recibos (madre/padre) al mismo lote — para
    // corregir la cuenta de uno solo después, está el botón "✎" de la fila.
    const hermanos = recibosHermanosDe(r).filter(h => h.estado !== 'pagado');
    const nombres = [r, ...hermanos].map(x => x.alumnos?.nombre || 'este alumno').join(' y ');
    const ids = [r.id, ...hermanos.map(h => h.id)];
    modalElegirCuentaCobro('Marcar como cobrado',
      `¿Cómo se ha cobrado el recibo de ${e(nombres)}${hermanos.length ? ' (recibo hermanos)' : ''} (${formatoImporte(r.importe)}€, ${e(r.concepto)})?`,
      async (cuenta) => {
        const { error } = await S.sb.from('recibos')
          .update({ estado: 'pagado', fecha_pago: new Date().toISOString(), cuenta, importe_parcial: null })
          .in('id', ids);
        cerrarModal();
        if (error) return avisar('Error al marcar como cobrado: ' + error.message, true);
        await cargarRecibos();
        renderRecibos();
        // El envío del justificante ya no es automático: solo el admin lo manda,
        // desde la pestaña "Pagados por enviar" (así cualquier profesor puede
        // marcar el pago sin depender de tener acceso a WhatsApp).
        avisar('Marcado como cobrado.');
      });
  });
  document.querySelectorAll('[data-pago-incompleto]').forEach(b => b.onclick = () => {
    const r = S.recibos.find(x => x.id === b.dataset.pagoIncompleto);
    if (!r) return;
    modalPagoIncompleto(r);
  });
  document.querySelectorAll('[data-editar-cuenta]').forEach(b => b.onclick = () => {
    const r = S.recibos.find(x => x.id === b.dataset.editarCuenta);
    if (!r) return;
    modalElegirCuentaCobro('Corregir cuenta de cobro',
      `¿En qué cuenta se cobró de verdad el recibo de ${e(r.alumnos?.nombre || '')} (${formatoImporte(r.importe)}€, ${e(r.concepto)})? Esto solo corrige en qué cuenta se contabiliza — no cambia el estado ni la fecha de cobro.`,
      async (cuenta) => {
        const { error: errorRecibo } = await S.sb.from('recibos').update({ cuenta }).eq('id', r.id);
        if (errorRecibo) { cerrarModal(); return avisar('Error: ' + errorRecibo.message, true); }
        const { error: errorFinanzas } = await S.sb.from('finanzas_movimientos').update({ cuenta })
          .eq('recibo_id', r.id).eq('origen', 'automatico');
        cerrarModal();
        if (errorFinanzas) return avisar('Se corrigió el recibo, pero no Ingresos y gastos: ' + errorFinanzas.message, true);
        await Promise.all([cargarRecibos(), cargarFinanzas()]);
        renderRecibos();
        avisar('Cuenta corregida.');
      });
  });
  document.querySelectorAll('[data-despagar]').forEach(b => b.onclick = async () => {
    const r = S.recibos.find(x => x.id === b.dataset.despagar);
    if (!r) return;
    const hermanos = recibosHermanosDe(r).filter(h => h.estado === 'pagado');
    const nombres = [r, ...hermanos].map(x => x.alumnos?.nombre || 'este alumno').join(' y ');
    if (!confirm(`¿Estás seguro de que quieres volver a dejar PENDIENTE el recibo de ${nombres} (${formatoImporte(r.importe)}€, ${r.concepto})?`)) return;
    const ids = [r.id, ...hermanos.map(h => h.id)];
    const { error } = await S.sb.from('recibos').update({ estado: 'pendiente', fecha_pago: null, fecha_envio_whatsapp_pago: null, cuenta: null })
      .in('id', ids);
    if (error) return avisar('Error: ' + error.message, true);
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

// Vista "por alumno": para el mes seleccionado, quién ha pagado y quién no.
// Con "Todos los profesores" el admin ve la academia entera; eligiendo uno
// concreto se reduce a los alumnos matriculados en sus asignaturas — así
// cubre tanto la vista global como la de "qué falta por asignatura" sin
// necesitar dos funciones distintas.
function renderRecibosPorAlumno() {
  const esAdmin = S.profesor?.es_admin;
  if (!esAdmin) { S.vistaRosterRecibos = false; return renderRecibos(); }

  const barraMes = barraMesRecibos();
  const t = (S.filtros.textoRecibo || '').toLowerCase();
  const profId = S.filtros.profesor;
  const alumnos = S.alumnos
    .filter(a => a.estado === 'activo')
    .filter(a => !profId || matriculasDeProfesor(a, profId).length > 0)
    .filter(a => !t || (a.nombre || '').toLowerCase().includes(t))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const filas = alumnos.map(a => {
    const recibo = S.recibos.find(r => r.alumno_id === a.id && claveMes(r.fecha_emision) === S.mesRecibos);
    const chip = !recibo ? '<span class="chip baja">sin recibo</span>'
      : recibo.estado === 'pagado' ? '<span class="chip pagado">cobrado</span>'
      : '<span class="chip pendiente">pendiente</span>';
    const chipHermanos = recibo && recibosHermanosDe(recibo).length ? ' <span class="chip activo" title="Recibo hermanos">👪</span>' : '';
    const acciones = !recibo
      ? `<button class="btn chico liso" data-generar-recibo="${a.id}">Generar recibo</button>`
      : `<button class="btn chico liso" data-pdf-roster="${recibo.id}">PDF</button>`;
    return `<tr>
      <td><strong>${e(a.nombre)}</strong></td>
      <td>${recibo ? formatoImporte(recibo.importe) + '€' : '—'}</td>
      <td>${chip}${chipHermanos}</td>
      <td class="acciones">${acciones}</td>
    </tr>`;
  }).join('');

  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <button class="btn liso" id="rc-volver-lista">‹ Volver a la lista</button>
    ${barraMes}
    <input id="fr-texto" type="search" placeholder="Buscar alumno…" value="${e(S.filtros.textoRecibo)}">
    <select id="fr-prof">
      <option value="">Todos los profesores</option>
      ${profesoresActivos().map(p => `<option value="${p.id}" ${p.id === profId ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
    </select>
    <span class="flex1"></span>
  </div>
  <h3 class="mes-seccion">${tituloMes(S.mesRecibos)} <small>${alumnos.length} alumno${alumnos.length === 1 ? '' : 's'}</small></h3>
  ${alumnos.length === 0
    ? `<div class="vacio">No hay alumnos que coincidan.</div>`
    : `<table><thead><tr><th>Alumno</th><th>Importe</th><th>Estado</th><th></th></tr></thead><tbody>${filas}</tbody></table>`}`;

  document.getElementById('rc-volver-lista').onclick = () => { S.vistaRosterRecibos = false; renderRecibos(); };
  const rcMesAnt = document.getElementById('rc-mes-ant');
  const rcMesSig = document.getElementById('rc-mes-sig');
  const rcMes = document.getElementById('rc-mes');
  if (rcMesAnt) rcMesAnt.onclick = () => { const m = mesesConRecibos(); cambiarMesRecibos(m[m.indexOf(S.mesRecibos) + 1]); };
  if (rcMesSig) rcMesSig.onclick = () => { const m = mesesConRecibos(); cambiarMesRecibos(m[m.indexOf(S.mesRecibos) - 1]); };
  if (rcMes) rcMes.onchange = (ev) => cambiarMesRecibos(ev.target.value);
  document.getElementById('fr-texto').oninput = (ev) => { S.filtros.textoRecibo = ev.target.value; conFocoPreservado(renderRecibosPorAlumno); };
  document.getElementById('fr-prof').onchange = (ev) => { S.filtros.profesor = ev.target.value; renderRecibosPorAlumno(); };
  document.querySelectorAll('[data-generar-recibo]').forEach(b => b.onclick = () =>
    modalRecibo(S.alumnos.find(a => a.id === b.dataset.generarRecibo)));
  document.querySelectorAll('[data-pdf-roster]').forEach(b => b.onclick = async () => {
    const r = S.recibos.find(x => x.id === b.dataset.pdfRoster);
    const abierto = await window.api.openPdf(r.pdf_path);
    if (!abierto) { const ruta = await regenerarPdf(r); window.api.openPdf(ruta); }
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
        recibiDe: destinatarioDeRecibo(r),
        cantidadLetras: letras,
        concepto: r.concepto,
        desglose: desgloseDeRecibo(r.concepto, r.importe, r.importe_matricula) || undefined,
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
  // Si el recibo ya traía matrícula de fábrica, se separa del resto del
  // importe/concepto para no duplicarla al recalcular (y se le quita el
  // sufijo " + Matrícula" que ya llevara, que se vuelve a añadir solo si
  // sigue marcada la casilla).
  const matriculaOriginal = Number(r.importe_matricula) || 0;
  const importeBase = Number(r.importe) - matriculaOriginal;
  const conceptoOriginal = r.incluye_matricula
    ? r.concepto.replace(/ \+ Matrícula$/, '')
    : r.concepto;
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
    <label>Importe total (€)<input id="er-importe" type="number" min="0" step="0.01" value="${Number(r.importe)}"></label>
  </div>
  <label class="check-inline" style="margin-top:10px">
    <input type="checkbox" id="er-matricula" ${r.incluye_matricula ? 'checked' : ''}> Añadir matrícula (aparte, va a Ingresos &gt; Matrícula)
  </label>
  <input id="er-importe-matricula" type="number" min="0" step="0.01" placeholder="Importe de la matrícula (€)"
    value="${matriculaOriginal || ''}" style="${r.incluye_matricula ? '' : 'display:none'}; margin-top:6px">
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
  const $matriculaChk = document.getElementById('er-matricula');
  const $matriculaImporte = document.getElementById('er-importe-matricula');

  const recalcular = () => {
    const extra = Number($extra.value) || 0;
    const desc = $desc.value.trim();
    const conMatricula = $matriculaChk.checked;
    const importeMatricula = conMatricula ? (Number($matriculaImporte.value) || 0) : 0;
    $importe.value = (importeBase + extra + importeMatricula) || '';
    $concepto.value = conceptoOriginal + (extra && desc ? ' + ' + desc : '') + (conMatricula ? ' + Matrícula' : '');
    $letras.textContent = importeALetras($importe.value || 0);
  };
  $extra.oninput = recalcular;
  $desc.oninput = recalcular;
  $importe.oninput = () => { $letras.textContent = importeALetras($importe.value || 0); };
  $matriculaChk.onchange = () => {
    $matriculaImporte.style.display = $matriculaChk.checked ? '' : 'none';
    recalcular();
  };
  $matriculaImporte.oninput = recalcular;
  $letras.textContent = importeALetras(Number(r.importe));

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('er-guardar').onclick = async () => {
    const concepto = $concepto.value.trim();
    const importe = Number($importe.value);
    if (!concepto || !importe) {
      document.getElementById('m-msg').textContent = 'Concepto e importe son obligatorios.';
      return;
    }
    const conMatricula = $matriculaChk.checked;
    const importeMatricula = conMatricula ? (Number($matriculaImporte.value) || 0) : 0;
    const btn = document.getElementById('er-guardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    const { error } = await S.sb.from('recibos').update({
      concepto,
      importe,
      importe_letras: importeALetras(importe),
      incluye_matricula: conMatricula,
      importe_matricula: importeMatricula,
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

// Para elegir "por profesor" en un filtro o asignar quién da una clase: solo
// profesores que de verdad dan clase (algunos admins llevan la gestión pero
// no tienen asignaturas propias). La pestaña Profesores, que gestiona a todo
// el personal, no usa esta lista — usa S.profesores directamente.
function profesoresActivos() {
  return S.profesores.filter(p => p.estado !== 'baja' && p.da_clases !== false);
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
      <td>${asigs.length ? asigs.map(a => {
          const c = colorArea(a.nombre);
          return `<span class="chip-asig" style="background:${c.fondo}; border-left:3px solid ${c.borde}">${e(a.nombre)}</span>`;
        }).join(' ')
        : (p.es_admin ? '<small>Todas (administrador)</small>' : '<small>Sin asignaturas (ve todas)</small>')}</td>
      <td class="acciones">
        ${p.estado === 'baja'
          ? `<button class="btn chico" data-reactivar-prof="${p.id}">Reactivar</button>`
          : (p.id !== S.profesor.id
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
  <h3 class="seccion">Permisos</h3>
  <p class="ayuda">${prof.es_admin
    ? 'Es <strong>administrador</strong>: ve y gestiona todo (alumnos, recibos, finanzas y profesores).'
    : 'Profesor normal: solo ve sus propias asignaturas y alumnos.'}</p>
  <button class="btn liso" id="p-admin">${prof.es_admin ? 'Quitar administrador' : 'Hacer administrador'}</button>
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
  document.getElementById('p-admin').onclick = async () => {
    const nuevo = !prof.es_admin;
    const msg = nuevo
      ? `¿Hacer administrador a ${prof.nombre}? Podrá ver y gestionar todo: alumnos, recibos, finanzas y profesores. Si tiene la app abierta, se le pedirá reiniciarla.`
      : `¿Quitar el admin a ${prof.nombre}? Dejará de ver finanzas y la gestión de profesores, y solo verá sus propias asignaturas. Si tiene la app abierta, se le pedirá reiniciarla.`;
    if (!confirm(msg)) return;
    const { error } = await S.sb.rpc('cambiar_admin_profesor', { p_profesor: prof.id, p_es_admin: nuevo });
    if (error) {
      document.getElementById('m-msg').textContent = 'Error: ' + error.message;
      return;
    }
    cerrarModal();
    await cargarTodo();
    renderProfesores();
    avisar(`${prof.nombre} ${nuevo ? 'ya es administrador' : 'ya no es administrador'}.`);
  };
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

// Agrupa todas las matrículas de la academia por asignatura + tipo de tarifa,
// para poder cambiar el precio de todos los alumnos matriculados de una vez
// en lugar de editarlos uno a uno.
function gruposDeTarifa() {
  const mapa = new Map();
  for (const a of S.alumnos) {
    for (const m of a.matriculas || []) {
      const clave = m.asignatura_id + '|' + m.tipo_tarifa;
      if (!mapa.has(clave)) {
        mapa.set(clave, {
          asignatura_id: m.asignatura_id,
          asignatura: m.asignaturas?.nombre || S.asignaturas.find(x => x.id === m.asignatura_id)?.nombre || '',
          tipo_tarifa: m.tipo_tarifa,
          tarifas: []
        });
      }
      mapa.get(clave).tarifas.push(Number(m.tarifa));
    }
  }
  return [...mapa.values()].sort((a, b) =>
    a.asignatura.localeCompare(b.asignatura) || a.tipo_tarifa.localeCompare(b.tipo_tarifa));
}

function renderGruposTarifa() {
  const grupos = gruposDeTarifa();
  if (!grupos.length) return '<p class="ayuda">Todavía no hay alumnos matriculados.</p>';
  return `<div class="tabla-wrap"><table>
    <thead><tr><th>Asignatura</th><th>Tarifa</th><th>Alumnos</th><th>Precio actual</th><th></th></tr></thead>
    <tbody>
    ${grupos.map(g => {
      const min = Math.min(...g.tarifas), max = Math.max(...g.tarifas);
      const precio = min === max ? `${formatoImporte(min)}€` : `${formatoImporte(min)}–${formatoImporte(max)}€`;
      return `<tr>
        <td>${e(g.asignatura)}</td>
        <td>${g.tipo_tarifa === 'clase' ? '€/clase' : '€/mes'}</td>
        <td>${g.tarifas.length}</td>
        <td>${precio}</td>
        <td class="acciones"><button class="btn chico" data-cambiar-tarifa="${g.asignatura_id}|${g.tipo_tarifa}">Cambiar precio</button></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

function modalCambiarTarifaAsignatura(asignaturaId, tipoTarifa) {
  const g = gruposDeTarifa().find(x => x.asignatura_id === asignaturaId && x.tipo_tarifa === tipoTarifa);
  if (!g) return;
  const n = g.tarifas.length;
  const min = Math.min(...g.tarifas), max = Math.max(...g.tarifas);
  const precioActual = min === max ? `${formatoImporte(min)}€` : `${formatoImporte(min)}–${formatoImporte(max)}€`;

  abrirModal(`
  <h2>Cambiar precio — ${e(g.asignatura)}</h2>
  <p class="ayuda">Afecta a los <strong>${n}</strong> alumno${n === 1 ? '' : 's'} matriculados en esta
  asignatura con tarifa ${g.tipo_tarifa === 'clase' ? 'por clase' : 'mensual'}.
  Precio actual: ${precioActual}.</p>
  <label>Nuevo precio (€)<input id="ct-precio" type="number" min="0" step="0.01"></label>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="ct-guardar">Aplicar a los ${n} alumnos</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('ct-guardar').onclick = async () => {
    const nuevo = Number(document.getElementById('ct-precio').value);
    if (!nuevo || nuevo <= 0) {
      document.getElementById('m-msg').textContent = 'Introduce un precio válido.';
      return;
    }
    if (!confirm(`¿Cambiar el precio de "${g.asignatura}" (${g.tipo_tarifa === 'clase' ? '€/clase' : '€/mes'}) a ${formatoImporte(nuevo)}€ para los ${n} alumnos matriculados? Los recibos ya generados no cambian, solo los que se generen a partir de ahora.`)) return;
    const btn = document.getElementById('ct-guardar');
    btn.disabled = true; btn.textContent = 'Aplicando…';
    const { error } = await S.sb.from('matriculas')
      .update({ tarifa: nuevo })
      .eq('asignatura_id', asignaturaId)
      .eq('tipo_tarifa', tipoTarifa);
    if (error) {
      btn.disabled = false; btn.textContent = `Aplicar a los ${n} alumnos`;
      document.getElementById('m-msg').textContent = 'Error: ' + error.message;
      return;
    }
    cerrarModal();
    await cargarAlumnos();
    renderAjustes();
    avisar(`Precio actualizado para ${n} alumno${n === 1 ? '' : 's'}.`);
  };
}

// ---------------------------------------------------------------- ingresos y gastos (solo admin)

function claveMesFecha(fechaIso) {
  return String(fechaIso || '').slice(0, 7);
}

// Curso académico "2025-2026": empieza en septiembre de 2025, termina en julio de 2026.
// Agosto se considera parte del curso que termina (mes de descanso, fuera de la rejilla anual).
function cursoDeClaveMes(claveMes) {
  const [anio, mes] = claveMes.split('-').map(Number);
  const inicio = mes >= 9 ? anio : anio - 1;
  return `${inicio}-${inicio + 1}`;
}

function cursoActual() {
  const hoy = new Date();
  return cursoDeClaveMes(`${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`);
}

// Las 12 claves 'YYYY-MM' del curso, en orden: septiembre → agosto. Incluye
// agosto (no solo hasta julio) porque cursoDeClaveMes() también lo cuenta
// como parte del curso que termina — si no, el dinero de agosto (recibos de
// julio que se cobran en agosto, gastos de agosto…) desaparecería del cierre
// de año, del Excel exportado y de las tarjetas de totales.
function mesesDelCurso(curso) {
  const inicio = Number(curso.split('-')[0]);
  const claves = [];
  for (let m = 9; m <= 12; m++) claves.push(`${inicio}-${String(m).padStart(2, '0')}`);
  for (let m = 1; m <= 8; m++) claves.push(`${inicio + 1}-${String(m).padStart(2, '0')}`);
  return claves;
}

function nombreCortoMes(claveMes) {
  return MESES[Number(claveMes.split('-')[1]) - 1].slice(0, 3);
}

function totalCategoriaMes(tipo, categoria, claveMes, cuenta = null) {
  return S.finanzas
    .filter(m => m.tipo === tipo && m.categoria === categoria && claveMesFecha(m.fecha) === claveMes
      && (!cuenta || m.cuenta === cuenta))
    .reduce((s, m) => s + Number(m.importe), 0);
}

function totalTipoEnMeses(tipo, clavesMes, cuenta = null) {
  const set = new Set(clavesMes);
  return S.finanzas
    .filter(m => m.tipo === tipo && set.has(claveMesFecha(m.fecha)) && (!cuenta || m.cuenta === cuenta))
    .reduce((s, m) => s + Number(m.importe), 0);
}

// Saldo acumulado de una cuenta (Efectivo/Banco): el saldo de partida que
// fijó el admin más todo lo que se le haya sumado/restado desde siempre —
// no está acotado a un mes ni a un curso, es "cuánto hay ahora mismo".
function saldoCuenta(cuenta) {
  const inicial = Number(S.cuentasSaldoInicial.find(c => c.cuenta === cuenta)?.importe) || 0;
  return S.finanzas
    .filter(m => m.cuenta === cuenta)
    .reduce((s, m) => s + (m.tipo === 'ingreso' ? Number(m.importe) : -Number(m.importe)), inicial);
}

// Todas las categorías (ya no hay "fijas" protegidas en el código: el admin
// puede borrar o crear cualquiera) + cualquier categoría suelta que ya tenga
// movimientos (por ejemplo, datos antiguos) para no esconder dinero que no
// esté en la tabla. Con un filtro de cuenta (Efectivo/Banco), solo entran
// las categorías marcadas para esa cuenta o para "las dos" (cuenta null);
// las sueltas se muestran siempre, para no esconder dinero. En "Todo"
// (cuentaFiltro null) salen todas, sea cual sea su cuenta.
function categoriasConExtras(tipo, cuentaFiltro = null) {
  const propias = S.finanzasCategorias.filter(c => c.tipo === tipo);
  const cuentaDe = new Map(propias.map(c => [c.categoria, c.cuenta || null]));
  const usadas = [...new Set(S.finanzas.filter(m => m.tipo === tipo).map(m => m.categoria))];
  const todas = [...propias.map(c => c.categoria), ...usadas].filter((c, i, arr) => arr.indexOf(c) === i);
  if (!cuentaFiltro) return todas;
  return todas.filter(c => {
    const cta = cuentaDe.has(c) ? cuentaDe.get(c) : null;
    return !cta || cta === cuentaFiltro;
  });
}

function fechaPorDefectoParaMes(claveMes) {
  const hoy = new Date();
  return claveMes === claveMesFecha(hoy.toISOString()) ? hoy.toISOString().slice(0, 10) : `${claveMes}-01`;
}

// Exporta la rejilla categoría × mes del curso que se esté viendo (para guardar
// el cierre del año, por ejemplo antes de "Empezar año nuevo").
function escCsv(v) {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportarFinanzasAnualCsv(tipo) {
  const categorias = categoriasConExtras(tipo);
  const meses = mesesDelCurso(S.cursoFinanzas);
  const cabecera = ['Categoría', ...meses.map(mc => `${nombreCortoMes(mc)} ${mc.split('-')[0]}`), 'Total'];
  const filas = categorias.map(cat => {
    const valores = meses.map(mc => totalCategoriaMes(tipo, cat, mc));
    const total = valores.reduce((s, x) => s + x, 0);
    return [cat, ...valores.map(formatoImporte), formatoImporte(total)];
  });
  const totalPorMes = meses.map(mc => categorias.reduce((s, c) => s + totalCategoriaMes(tipo, c, mc), 0));
  filas.push(['Total', ...totalPorMes.map(formatoImporte), formatoImporte(totalPorMes.reduce((s, x) => s + x, 0))]);

  const csv = [cabecera, ...filas].map(fila => fila.map(escCsv).join(';')).join('\r\n');
  const nombreArchivo = `${tipo === 'gasto' ? 'gastos' : 'ingresos'}_curso_${S.cursoFinanzas}.csv`;
  const ruta = await window.api.saveCsv(csv, nombreArchivo);
  if (ruta) avisar('Excel guardado en ' + ruta);
}

// Todas las claves 'YYYY-MM' entre dos meses, ambos incluidos (para que no falten
// meses "vacíos" en medio y el mes actual siempre sea el límite de avance).
function mesesEntre(desde, hasta) {
  const claves = [];
  let [a, m] = desde.split('-').map(Number);
  const [aFin, mFin] = hasta.split('-').map(Number);
  while (a < aFin || (a === aFin && m <= mFin)) {
    claves.push(`${a}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; a++; }
  }
  return claves;
}

function renderFinanzas() {
  if (!S.profesor?.es_admin) return renderAjustes();
  const tipo = S.vistaFinanzas === 'gastos' ? 'gasto' : 'ingreso';
  const modo = S.modoFinanzas || 'mes';
  const cuenta = S.cuentaFinanzas || 'todo';
  // null = sin filtrar (vista "Todo", igual que siempre); si no, acota
  // categorías/totales a una sola cuenta.
  const filtroCuenta = cuenta === 'todo' ? null : cuenta;
  const categorias = categoriasConExtras(tipo, filtroCuenta);

  let cuerpoTabla, barraNav, periodoMeses;

  if (modo === 'anual') {
    const cursoAct = cursoActual();
    const cursosConDatos = S.finanzas.map(m => cursoDeClaveMes(claveMesFecha(m.fecha)));
    const iniciosConDatos = cursosConDatos.map(c => Number(c.split('-')[0]));
    const inicioActual = Number(cursoAct.split('-')[0]);
    const primerInicio = iniciosConDatos.length ? Math.min(inicioActual, ...iniciosConDatos) : inicioActual;
    // El curso siguiente al actual siempre está disponible (aunque aún no tenga
    // datos), para poder adelantar la vista con "Empezar año nuevo"; y si hay
    // movimientos con fecha en un curso todavía más adelantado (p. ej. una
    // fecha mal escrita), ese también se incluye para no perderlo de vista.
    const inicioMax = Math.max(inicioActual + 1, ...iniciosConDatos);
    const cursosDisponibles = [];
    for (let i = inicioMax; i >= primerInicio; i--) cursosDisponibles.push(`${i}-${i + 1}`);
    if (!S.cursoFinanzas || !cursosDisponibles.includes(S.cursoFinanzas)) S.cursoFinanzas = cursoAct;
    const meses = mesesDelCurso(S.cursoFinanzas);
    const esElMasReciente = S.cursoFinanzas === cursosDisponibles[0];
    const esElMasAntiguo = S.cursoFinanzas === cursosDisponibles[cursosDisponibles.length - 1];
    const cursoSiguiente = `${inicioActual + 1}-${inicioActual + 2}`;
    periodoMeses = meses;

    const totalPorMes = meses.map(mc => categorias.reduce((s, c) => s + totalCategoriaMes(tipo, c, mc, filtroCuenta), 0));
    const totalGeneral = totalPorMes.reduce((s, x) => s + x, 0);

    barraNav = `
    <div class="mes-nav">
      <button class="btn chico liso" id="fin-curso-ant" ${esElMasAntiguo ? 'disabled' : ''}>‹</button>
      <select id="fin-curso">
        ${cursosDisponibles.map(c => `<option value="${c}" ${c === S.cursoFinanzas ? 'selected' : ''}>Curso ${c}</option>`).join('')}
      </select>
      <button class="btn chico liso" id="fin-curso-sig" ${esElMasReciente ? 'disabled' : ''}>›</button>
    </div>
    <button class="btn liso" id="fin-exportar-anual">⬇ Exportar a Excel</button>
    ${S.cursoFinanzas === cursoAct ? `<button class="btn" id="fin-nuevo-anio">Empezar año nuevo (${cursoSiguiente}) →</button>` : ''}`;

    cuerpoTabla = `
    <div class="tabla-wrap"><table class="tabla-finanzas">
      <thead><tr><th>Categoría</th>${meses.map(mc => `<th>${nombreCortoMes(mc)}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>
        ${categorias.map(cat => {
          const valores = meses.map(mc => totalCategoriaMes(tipo, cat, mc, filtroCuenta));
          const totalFila = valores.reduce((s, x) => s + x, 0);
          return `<tr>
            <td>${e(cat)}</td>
            ${valores.map((v, i) => `<td class="celda-fin ${v ? '' : 'vacia'}" data-cat="${e(cat)}" data-mes="${meses[i]}">${v ? formatoImporte(v) + '€' : '—'}</td>`).join('')}
            <td><strong>${formatoImporte(totalFila)}€</strong></td>
          </tr>`;
        }).join('')}
        <tr class="fila-total"><td>Total</td>${totalPorMes.map(v => `<td>${formatoImporte(v)}€</td>`).join('')}<td>${formatoImporte(totalGeneral)}€</td></tr>
      </tbody>
    </table></div>`;
  } else {
    const mesActual = claveMesFecha(new Date().toISOString());
    const mesesConDatos = S.finanzas.map(m => claveMesFecha(m.fecha)).sort();
    const primerMes = mesesConDatos.length ? mesesConDatos[0] : mesActual;
    // El límite de avance normal es el mes actual, pero si hay algún movimiento
    // metido con fecha futura (p. ej. el alquiler de agosto apuntado en julio),
    // ese mes también tiene que poder verse, tocarse y borrarse.
    const ultimoMesConDatos = mesesConDatos.length ? mesesConDatos[mesesConDatos.length - 1] : mesActual;
    const mesHasta = ultimoMesConDatos > mesActual ? ultimoMesConDatos : mesActual;
    const meses = mesesEntre(primerMes, mesHasta).reverse();
    if (!S.mesFinanzas || !meses.includes(S.mesFinanzas)) S.mesFinanzas = mesActual;
    periodoMeses = [S.mesFinanzas];

    const totalGeneral = categorias.reduce((s, c) => s + totalCategoriaMes(tipo, c, S.mesFinanzas, filtroCuenta), 0);
    const esElMasReciente = S.mesFinanzas === meses[0];
    const esElMasAntiguo = S.mesFinanzas === meses[meses.length - 1];

    barraNav = `
    <div class="mes-nav">
      <button class="btn chico liso" id="fin-mes-ant" ${esElMasAntiguo ? 'disabled' : ''}>‹</button>
      <select id="fin-mes">
        ${meses.map(m => `<option value="${m}" ${m === S.mesFinanzas ? 'selected' : ''}>${tituloMes(m)}</option>`).join('')}
      </select>
      <button class="btn chico liso" id="fin-mes-sig" ${esElMasReciente ? 'disabled' : ''}>›</button>
    </div>`;

    cuerpoTabla = `
    <div class="tabla-wrap"><table class="tabla-finanzas">
      <thead><tr><th>Categoría</th><th>Total del mes</th></tr></thead>
      <tbody>
        ${categorias.map(cat => {
          const v = totalCategoriaMes(tipo, cat, S.mesFinanzas, filtroCuenta);
          return `<tr class="celda-fin" data-cat="${e(cat)}" data-mes="${S.mesFinanzas}">
            <td>${e(cat)}</td>
            <td>${v ? `<strong>${formatoImporte(v)}€</strong>` : '<span class="ayuda">— (toca para añadir)</span>'}</td>
          </tr>`;
        }).join('')}
        <tr class="fila-total"><td>Total</td><td>${formatoImporte(totalGeneral)}€</td></tr>
      </tbody>
    </table></div>`;
  }

  const totalIngresosPeriodo = totalTipoEnMeses('ingreso', periodoMeses, filtroCuenta);
  const totalGastosPeriodo = totalTipoEnMeses('gasto', periodoMeses, filtroCuenta);
  const etiquetaPeriodo = modo === 'anual' ? `Curso ${S.cursoFinanzas}` : tituloMes(S.mesFinanzas);

  // Solo con una cuenta concreta elegida (no en "Todo") tiene sentido un
  // saldo acumulado — es "cuánto hay ahora", no depende del mes/curso que
  // se esté mirando.
  const sinClasificar = filtroCuenta ? S.finanzas.filter(m => m.cuenta == null) : [];
  const totalSinClasificar = sinClasificar.reduce((s, m) => s + Number(m.importe), 0);
  const saldoInicialCuenta = filtroCuenta ? S.cuentasSaldoInicial.find(c => c.cuenta === filtroCuenta) : null;

  document.getElementById('contenido').innerHTML = `
  <div class="barra">
    <div class="segmentos">
      <button class="seg ${tipo === 'ingreso' ? 'activo' : ''}" data-tipo-fin="ingresos">Ingresos</button>
      <button class="seg ${tipo === 'gasto' ? 'activo' : ''}" data-tipo-fin="gastos">Gastos</button>
    </div>
    <div class="segmentos">
      <button class="seg ${modo === 'mes' ? 'activo' : ''}" data-modo-fin="mes">Mes</button>
      <button class="seg ${modo === 'anual' ? 'activo' : ''}" data-modo-fin="anual">Año completo</button>
    </div>
    <div class="segmentos">
      <button class="seg ${cuenta === 'todo' ? 'activo' : ''}" data-cuenta-fin="todo">Todo</button>
      <button class="seg ${cuenta === 'efectivo' ? 'activo' : ''}" data-cuenta-fin="efectivo">Efectivo</button>
      <button class="seg ${cuenta === 'banco' ? 'activo' : ''}" data-cuenta-fin="banco">Banco</button>
    </div>
    <button class="btn liso" id="fin-anadir-categoria">+ Añadir columna</button>
    <span class="flex1"></span>
    ${barraNav}
  </div>
  <div class="portada-cards" style="margin-bottom:22px">
    <div class="portada-card estatica">
      <div class="pc-num" style="color:var(--verde)">${formatoImporte(totalIngresosPeriodo)}€</div>
      <div class="pc-titulo">ingresos</div>
      <div class="pc-detalle">${etiquetaPeriodo}</div>
    </div>
    <div class="portada-card estatica">
      <div class="pc-num" style="color:var(--rojo)">${formatoImporte(totalGastosPeriodo)}€</div>
      <div class="pc-titulo">gastos</div>
      <div class="pc-detalle">${etiquetaPeriodo}</div>
    </div>
    <div class="portada-card estatica">
      <div class="pc-num">${formatoImporte(totalIngresosPeriodo - totalGastosPeriodo)}€</div>
      <div class="pc-titulo">balance</div>
      <div class="pc-detalle">${etiquetaPeriodo}</div>
    </div>
    ${filtroCuenta ? `
    <div class="portada-card estatica">
      <div class="pc-num">${formatoImporte(saldoCuenta(filtroCuenta))}€</div>
      <div class="pc-titulo">saldo actual</div>
      <div class="pc-detalle">
        <button class="btn chico liso" id="fin-saldo-inicial" style="margin:0">${saldoInicialCuenta ? 'Editar' : 'Fijar'} saldo inicial</button>
      </div>
    </div>` : ''}
  </div>
  ${filtroCuenta && sinClasificar.length ? `<p class="ayuda">⚠ ${sinClasificar.length} movimiento${sinClasificar.length === 1 ? '' : 's'} sin clasificar (${formatoImporte(totalSinClasificar)}€) de antes de esta función, no incluido${sinClasificar.length === 1 ? '' : 's'} en este saldo.</p>` : ''}
  <p class="ayuda">Toca cualquier categoría para ver sus movimientos de ese mes y añadir uno nuevo.</p>
  ${cuerpoTabla}`;

  document.querySelectorAll('[data-tipo-fin]').forEach(b => b.onclick = () => { S.vistaFinanzas = b.dataset.tipoFin; renderFinanzas(); });
  document.querySelectorAll('[data-modo-fin]').forEach(b => b.onclick = () => { S.modoFinanzas = b.dataset.modoFin; renderFinanzas(); });
  document.querySelectorAll('[data-cuenta-fin]').forEach(b => b.onclick = () => { S.cuentaFinanzas = b.dataset.cuentaFin; renderFinanzas(); });
  document.getElementById('fin-anadir-categoria').onclick = () => modalAnadirCategoriaFinanzas(tipo, cuenta);
  document.querySelectorAll('.celda-fin[data-cat]').forEach(el => el.onclick = () =>
    modalCategoriaMovimientos(tipo, el.dataset.cat, el.dataset.mes));
  const $fijarSaldo = document.getElementById('fin-saldo-inicial');
  if ($fijarSaldo) $fijarSaldo.onclick = () => modalFijarSaldoInicial(filtroCuenta);

  if (modo === 'anual') {
    document.getElementById('fin-curso').onchange = (ev) => { S.cursoFinanzas = ev.target.value; renderFinanzas(); };
    document.getElementById('fin-curso-ant').onclick = () => {
      const inicio = Number(S.cursoFinanzas.split('-')[0]);
      S.cursoFinanzas = `${inicio - 1}-${inicio}`;
      renderFinanzas();
    };
    document.getElementById('fin-curso-sig').onclick = () => {
      const inicio = Number(S.cursoFinanzas.split('-')[0]);
      S.cursoFinanzas = `${inicio + 1}-${inicio + 2}`;
      renderFinanzas();
    };
    document.getElementById('fin-exportar-anual').onclick = () => exportarFinanzasAnualCsv(tipo);
    const $nuevoAnio = document.getElementById('fin-nuevo-anio');
    if ($nuevoAnio) $nuevoAnio.onclick = () => {
      const inicio = Number(S.cursoFinanzas.split('-')[0]);
      S.cursoFinanzas = `${inicio + 1}-${inicio + 2}`;
      renderFinanzas();
    };
  } else {
    document.getElementById('fin-mes').onchange = (ev) => { S.mesFinanzas = ev.target.value; renderFinanzas(); };
    document.getElementById('fin-mes-ant').onclick = () => {
      const [a, m] = S.mesFinanzas.split('-').map(Number);
      const d = new Date(a, m - 2, 1);
      S.mesFinanzas = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      renderFinanzas();
    };
    document.getElementById('fin-mes-sig').onclick = () => {
      const [a, m] = S.mesFinanzas.split('-').map(Number);
      const d = new Date(a, m, 1);
      S.mesFinanzas = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      renderFinanzas();
    };
  }
}

// Nueva columna (categoría) para Ingresos o Gastos, a mano — se guarda en
// finanzas_categorias. `cuentaActual` es la pestaña (todo/efectivo/banco)
// desde la que se abrió el botón, solo para preseleccionar el radio de
// cuenta (si estás mirando Efectivo, lo lógico es que la nueva columna sea
// de Efectivo, pero se puede cambiar).
function modalAnadirCategoriaFinanzas(tipo, cuentaActual = 'todo') {
  abrirModal(`
  <h2>Añadir columna — ${tipo === 'gasto' ? 'Gastos' : 'Ingresos'}</h2>
  <p class="ayuda">Se añade como una categoría más, igual que las que ya hay, y aparecerá también en la vista de
  curso completo.</p>
  <label>Nombre de la categoría<input id="fc-nombre" placeholder="ej. Formación"></label>
  <label>¿Dónde se usa?</label>
  <label class="check-inline">
    <input type="radio" name="fc-cat-cuenta" id="fc-cat-todo" ${cuentaActual !== 'efectivo' && cuentaActual !== 'banco' ? 'checked' : ''}> Las dos (Efectivo y Banco)
  </label>
  <label class="check-inline">
    <input type="radio" name="fc-cat-cuenta" id="fc-cat-efectivo" ${cuentaActual === 'efectivo' ? 'checked' : ''}> Solo Efectivo
  </label>
  <label class="check-inline">
    <input type="radio" name="fc-cat-cuenta" id="fc-cat-banco" ${cuentaActual === 'banco' ? 'checked' : ''}> Solo Banco
  </label>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="fc-guardar">Añadir</button>
  </div>
  <p id="m-msg" class="error"></p>`);
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('fc-guardar').onclick = async () => {
    const msg = document.getElementById('m-msg');
    const nombre = document.getElementById('fc-nombre').value.trim();
    if (!nombre) { msg.textContent = 'Escribe un nombre.'; return; }
    const yaExiste = categoriasConExtras(tipo).some(c => c.toLowerCase() === nombre.toLowerCase());
    if (yaExiste) { msg.textContent = 'Ya hay una categoría con ese nombre.'; return; }
    const cuentaCat = document.getElementById('fc-cat-efectivo').checked ? 'efectivo'
      : document.getElementById('fc-cat-banco').checked ? 'banco' : null;
    const { error } = await S.sb.from('finanzas_categorias').insert({ tipo, categoria: nombre, cuenta: cuentaCat });
    if (error) { msg.textContent = 'Error: ' + error.message; return; }
    await cargarFinanzasCategorias();
    cerrarModal();
    renderFinanzas();
    avisar('Columna añadida.');
  };
}

// Saldo de partida de Efectivo o Banco — se guarda en su propia tabla
// (cuentas_saldo_inicial, como mucho 2 filas) en vez de como un movimiento
// más, para que nunca aparezca colado como categoría en las tablas ni en
// el Excel anual, y no se pueda borrar sin querer con el botón de borrar
// movimiento de siempre.
function modalFijarSaldoInicial(cuenta) {
  const actual = S.cuentasSaldoInicial.find(c => c.cuenta === cuenta);
  const yaHabia = Boolean(actual);
  const movs = S.finanzas.filter(m => m.cuenta === cuenta);
  const totalMovs = movs.reduce((s, m) => s + (m.tipo === 'ingreso' ? Number(m.importe) : -Number(m.importe)), 0);
  const nombreCuenta = cuenta === 'banco' ? 'Banco' : 'Efectivo';

  abrirModal(`
  <h2>${yaHabia ? 'Editar' : 'Fijar'} saldo inicial — ${nombreCuenta}</h2>
  ${yaHabia ? `<p class="ayuda">⚠ Ya hay ${movs.length} movimiento${movs.length === 1 ? '' : 's'} registrado${movs.length === 1 ? '' : 's'}
    en ${nombreCuenta} desde que se fijó este saldo (${formatoImporte(totalMovs)}€ en total).
    Cambiarlo ahora recalcula el saldo actual, pero no toca esos movimientos.</p>` : ''}
  <div class="grid2">
    <label>Fecha<input id="si-fecha" type="date" value="${e(actual?.fecha || new Date().toISOString().slice(0, 10))}"></label>
    <label>Importe (€)<input id="si-importe" type="number" step="0.01" value="${actual?.importe ?? ''}"></label>
  </div>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cancelar</button>
    <button class="btn primario" id="si-guardar">Guardar</button>
  </div>
  <p id="m-msg" class="error"></p>`);
  document.getElementById('m-cancelar').onclick = cerrarModal;
  document.getElementById('si-guardar').onclick = async () => {
    const importe = Number(document.getElementById('si-importe').value);
    const fecha = document.getElementById('si-fecha').value;
    if (Number.isNaN(importe)) return avisar('Pon un importe válido.', true);
    if (!fecha) return avisar('Elige una fecha.', true);
    const { error } = await S.sb.from('cuentas_saldo_inicial').upsert({
      cuenta, importe, fecha, actualizado_por: S.profesor.id, actualizado_en: new Date().toISOString()
    });
    if (error) return avisar('Error: ' + error.message, true);
    await cargarCuentasSaldoInicial();
    cerrarModal();
    renderFinanzas();
    avisar('Saldo inicial guardado.');
  };
}

// Movimientos de una categoría en un mes concreto: verlos, borrarlos, y añadir uno nuevo.
function modalCategoriaMovimientos(tipo, categoria, claveMes) {
  const lista = S.finanzas
    .filter(m => m.tipo === tipo && m.categoria === categoria && claveMesFecha(m.fecha) === claveMes)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  const total = lista.reduce((s, m) => s + Number(m.importe), 0);

  abrirModal(`
  <h2>${e(categoria)} — ${tituloMes(claveMes)}</h2>
  <p class="ayuda">Total del mes: <strong>${formatoImporte(total)}€</strong>
    <button class="btn chico liso peligro" id="fc-borrar-categoria" style="margin-left:10px">🗑 Eliminar esta categoría</button></p>
  ${lista.length === 0 ? '<p class="ayuda">Sin movimientos todavía.</p>' : `
  <div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Importe</th><th>Cuenta</th><th>Descripción</th><th></th></tr></thead>
    <tbody>
    ${lista.map(m => `<tr>
      <td>${e(fmtFecha(m.fecha))}</td>
      <td><strong>${formatoImporte(m.importe)}€</strong></td>
      <td>${m.cuenta ? `<span class="chip activo">${m.cuenta === 'banco' ? 'Banco' : 'Efectivo'}</span>` : '<small class="ayuda">sin clasificar</small>'}</td>
      <td><small>${e(m.descripcion || '')}</small></td>
      <td class="acciones">${m.origen === 'automatico'
        ? '<small class="ayuda" title="Viene de un recibo cobrado; para quitarlo, deshaz el cobro en Recibos">ligado a un recibo</small>'
        : `<button class="btn chico liso peligro" data-borrar-fin="${m.id}">✕</button>`}</td>
    </tr>`).join('')}
    </tbody>
  </table></div>`}
  <h3 class="seccion">Añadir a ${e(categoria)}</h3>
  <div class="grid2">
    <label>Fecha<input id="fc-fecha" type="date" value="${e(fechaPorDefectoParaMes(claveMes))}"></label>
    <label>Importe (€)<input id="fc-importe" type="number" min="0" step="0.01"></label>
    <label>Descripción<input id="fc-descripcion"></label>
  </div>
  <label class="check-inline">
    <input type="radio" name="fc-cuenta" id="fc-cuenta-efectivo" checked> Efectivo
  </label>
  <label class="check-inline">
    <input type="radio" name="fc-cuenta" id="fc-cuenta-banco"> Banco
  </label>
  <div class="pie-modal">
    <button class="btn liso" id="m-cancelar">Cerrar</button>
    <button class="btn primario" id="fc-guardar">Añadir</button>
  </div>
  <p id="m-msg" class="error"></p>`);

  document.getElementById('m-cancelar').onclick = () => { cerrarModal(); renderFinanzas(); };
  document.querySelectorAll('[data-borrar-fin]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Eliminar este movimiento?')) return;
    await S.sb.from('finanzas_movimientos').delete().eq('id', b.dataset.borrarFin);
    await cargarFinanzas();
    modalCategoriaMovimientos(tipo, categoria, claveMes);
  });
  const btnBorrarCategoria = document.getElementById('fc-borrar-categoria');
  if (btnBorrarCategoria) btnBorrarCategoria.onclick = async () => {
    const todos = S.finanzas.filter(m => m.tipo === tipo && m.categoria === categoria);
    const totalTodos = todos.reduce((s, m) => s + Number(m.importe), 0);
    const aviso = todos.length
      ? `¿Seguro que quieres eliminar la columna "${categoria}"? Se borrarán también sus ${todos.length} movimiento${todos.length === 1 ? '' : 's'} de TODOS los meses (${formatoImporte(totalTodos)}€ en total). Esta acción no se puede deshacer.`
      : `¿Eliminar la columna "${categoria}"? No tiene ningún movimiento todavía.`;
    if (!confirm(aviso)) return;
    if (todos.length) {
      const { error } = await S.sb.from('finanzas_movimientos').delete().eq('tipo', tipo).eq('categoria', categoria);
      if (error) return avisar('Error: ' + error.message, true);
    }
    const { error } = await S.sb.from('finanzas_categorias').delete().eq('tipo', tipo).eq('categoria', categoria);
    if (error) return avisar('Error: ' + error.message, true);
    cerrarModal();
    await Promise.all([cargarFinanzas(), cargarFinanzasCategorias()]);
    renderFinanzas();
    avisar('Columna eliminada.');
  };
  document.getElementById('fc-guardar').onclick = async () => {
    const importe = Number(document.getElementById('fc-importe').value);
    const fecha = document.getElementById('fc-fecha').value;
    if (!importe || importe <= 0) return avisar('El importe tiene que ser mayor que 0.', true);
    if (!fecha) return avisar('Elige una fecha.', true);
    const cuentaElegida = document.getElementById('fc-cuenta-banco').checked ? 'banco' : 'efectivo';
    const { error } = await S.sb.from('finanzas_movimientos').insert({
      tipo, categoria, importe, fecha,
      descripcion: document.getElementById('fc-descripcion').value.trim() || null,
      origen: 'manual',
      creado_por: S.profesor.id,
      cuenta: cuentaElegida
    });
    if (error) return avisar('Error: ' + error.message, true);
    await cargarFinanzas();
    avisar('Movimiento añadido.');
    modalCategoriaMovimientos(tipo, categoria, claveMes);
  };
}

// ---------------------------------------------------------------- reestructuración de fin de curso (solo admin)

const PALABRA_REESTRUCTURAR = 'REESTRUCTURAR';

function renderReestructuracion() {
  if (!S.profesor?.es_admin) return renderAjustes();
  const nAlumnos = S.alumnos.filter(a => a.estado === 'activo').length;
  const nClases = S.clases.length;

  document.getElementById('contenido').innerHTML = `
  <div class="tarjeta">
    <h2>Reestructuración de fin de curso</h2>
    <p class="ayuda">Úsalo solo cuando termine el curso (normalmente después de julio). Esta acción:</p>
    <ul class="detalle-alumnos" style="columns:1">
      <li>Da de baja a <strong>los ${nAlumnos} alumnos activos</strong> de toda la academia (de todos los profesores).
      Cada profesor pasará a ver 0 alumnos hasta que se les vaya reactivando.</li>
      <li>Borra <strong>las ${nClases} clases</strong> existentes (con sus horarios, inscripciones y excepciones).
      Cada profesor tendrá que crear sus clases nuevas para el curso que empieza.</li>
    </ul>
    <p class="ayuda">Los recibos, ingresos/gastos y fichas de alumnos (nombre, precio, notas…) <strong>no se borran</strong>:
    cuando confirmes que un alumno sigue, lo buscas en el filtro "Bajas" de Alumnos, corriges lo que haga falta
    (nivel, precio, horas…) y lo reactivas — todo en un paso, desde su ficha.</p>
    <p class="ayuda">⚠ Esto no se puede deshacer. Escribe <strong>${PALABRA_REESTRUCTURAR}</strong> para poder confirmar.</p>
    <label>Palabra de confirmación<input id="re-confirmar" placeholder="${PALABRA_REESTRUCTURAR}"></label>
    <p><button class="btn liso peligro" id="re-ejecutar" disabled style="margin-top:10px">Dar de baja a todos y borrar todas las clases</button></p>
    <p id="re-msg" class="error"></p>
  </div>`;

  const $input = document.getElementById('re-confirmar');
  const $btn = document.getElementById('re-ejecutar');
  $input.oninput = () => { $btn.disabled = $input.value.trim() !== PALABRA_REESTRUCTURAR; };
  $btn.onclick = async () => {
    if (!confirm(`Última confirmación: se dará de baja a ${nAlumnos} alumnos y se borrarán ${nClases} clases de TODA la academia. ¿Seguro?`)) return;
    $btn.disabled = true;
    $btn.textContent = 'Reestructurando…';
    const { data, error } = await S.sb.rpc('reestructurar_academia');
    if (error) {
      document.getElementById('re-msg').textContent = 'Error: ' + error.message;
      $btn.disabled = false;
      $btn.textContent = 'Dar de baja a todos y borrar todas las clases';
      return;
    }
    await Promise.all([cargarAlumnos(), cargarClases()]);
    renderReestructuracion();
    avisar(`Reestructuración hecha: ${data.alumnos_dados_de_baja} alumnos dados de baja, ${data.clases_borradas} clases borradas.`);
  };
}

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

    <h3>Envío por WhatsApp</h3>
    <p class="ayuda" id="aj-wa-estado">Comprobando…</p>
    <button class="btn chico" id="aj-wa-probar">Comprobar de nuevo</button>

    <h3>${S.profesor?.es_admin ? 'Horario de trabajo' : 'Mi horario de trabajo'}</h3>
    <p class="ayuda">Indica qué días y horas ${S.profesor?.es_admin ? 'trabaja cada profesor' : 'trabajas'}.
    Con esto, "Huecos libres" en la pestaña Horario calculará los huecos dentro del horario real,
    en vez de un horario genérico. Si no se configura nada, se usará un horario por defecto (16:00–21:00).</p>
    ${S.profesor?.es_admin ? `<label>Profesor
      <select id="aj-horario-profesor">
        ${S.profesores.filter(p => p.estado !== 'baja').map(p =>
          `<option value="${p.id}" ${p.id === S.profesor.id ? 'selected' : ''}>${e(p.nombre)}</option>`).join('')}
      </select></label>` : ''}
    <div id="aj-horario-trabajo"></div>
    <button class="btn chico" id="aj-add-horario">+ Añadir tramo</button>
    <button class="btn primario chico" id="aj-guardar-horario" style="margin-left:8px">Guardar horario</button>

    ${S.profesor?.es_admin ? `
    <h3>Tarifas por asignatura (solo administrador)</h3>
    <p class="ayuda">Cambia el precio de todos los alumnos matriculados en una asignatura de una vez,
    en lugar de editarlos uno a uno.</p>
    ${renderGruposTarifa()}

    <h3>Conexión (solo administrador)</h3>
    <p class="ayuda">Proyecto: <code>${e(S.cfg.supabaseUrl || '')}</code></p>
    <button class="btn liso" id="aj-reconf">Cambiar datos de conexión…</button>` : ''}
  </div>`;
  document.getElementById('aj-carpeta').onclick = async () => {
    const nuevo = await window.api.chooseRecibosDir();
    if (nuevo) { avisar('Carpeta cambiada.'); renderAjustes(); }
  };

  // Estado del envío por WhatsApp: pregunta al servidor sin enviar nada real.
  const comprobarWhatsApp = async () => {
    const el = document.getElementById('aj-wa-estado');
    if (!el) return;
    el.textContent = 'Comprobando…';
    const { data, error } = await S.sb.functions.invoke('enviar-whatsapp', {
      body: { comprobar: true }
    });
    if (error) el.innerHTML = '⚠ No se pudo comprobar el estado del envío.';
    else if (data?.simulado) {
      el.innerHTML = '🟡 <strong>En simulación.</strong> Todo está preparado, pero aún faltan las credenciales de Meta: los envíos no salen de verdad.';
    } else {
      el.innerHTML = '🟢 <strong>Activo.</strong> Los recibos se envían por WhatsApp con el PDF adjunto.';
    }
  };
  comprobarWhatsApp();
  document.getElementById('aj-wa-probar').onclick = comprobarWhatsApp;

  // Tramos de horario de trabajo en edición local (día + hora inicio + hora fin).
  // El admin puede elegir de quién los edita; un profesor normal solo ve los suyos.
  let profesorHorarioId = S.profesor.id;
  const tramosDe = (profesorId) => S.profesorHorario
    .filter(h => h.profesor_id === profesorId)
    .map(h => ({ dia_semana: h.dia_semana, hora_inicio: horaCorta(h.hora_inicio), hora_fin: horaCorta(h.hora_fin) }));
  let tramos = tramosDe(profesorHorarioId);

  const pintarTramos = () => {
    document.getElementById('aj-horario-trabajo').innerHTML = tramos.map((t, i) => `
      <div class="fila-horario">
        <select data-t-dia="${i}">
          ${DIAS.map((d, j) => `<option value="${j + 1}" ${t.dia_semana === j + 1 ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <input type="time" data-t-ini="${i}" value="${e(t.hora_inicio)}">
        <span class="ayuda">a</span>
        <input type="time" data-t-fin="${i}" value="${e(t.hora_fin)}">
        <button class="btn chico liso" data-t-quitar="${i}" title="Quitar este tramo">✕</button>
      </div>`).join('') || '<p class="ayuda">Sin horario configurado — se usará el horario por defecto.</p>';
    const cont = document.getElementById('aj-horario-trabajo');
    cont.querySelectorAll('[data-t-dia]').forEach(s => s.onchange = () => { tramos[+s.dataset.tDia].dia_semana = Number(s.value); });
    cont.querySelectorAll('[data-t-ini]').forEach(s => s.onchange = () => { tramos[+s.dataset.tIni].hora_inicio = s.value; });
    cont.querySelectorAll('[data-t-fin]').forEach(s => s.onchange = () => { tramos[+s.dataset.tFin].hora_fin = s.value; });
    cont.querySelectorAll('[data-t-quitar]').forEach(b => b.onclick = () => { tramos.splice(+b.dataset.tQuitar, 1); pintarTramos(); });
  };
  pintarTramos();
  const selectorProf = document.getElementById('aj-horario-profesor');
  if (selectorProf) selectorProf.onchange = () => {
    profesorHorarioId = selectorProf.value;
    tramos = tramosDe(profesorHorarioId);
    pintarTramos();
  };
  document.getElementById('aj-add-horario').onclick = () => {
    tramos.push({ dia_semana: 1, hora_inicio: '16:00', hora_fin: '21:00' });
    pintarTramos();
  };
  document.getElementById('aj-guardar-horario').onclick = async () => {
    if (tramos.some(t => t.hora_fin <= t.hora_inicio)) {
      avisar('En cada tramo, la hora de fin debe ser posterior a la de inicio.', true);
      return;
    }
    await S.sb.from('profesor_horario').delete().eq('profesor_id', profesorHorarioId);
    if (tramos.length) {
      const { error } = await S.sb.from('profesor_horario')
        .insert(tramos.map(t => ({ profesor_id: profesorHorarioId, ...t })));
      if (error) return avisar('Error al guardar: ' + error.message, true);
    }
    await cargarHorarioTrabajo();
    renderAjustes();
    avisar('Horario de trabajo guardado.');
  };

  const reconf = document.getElementById('aj-reconf');
  if (reconf) reconf.onclick = () => renderSetup();
  document.querySelectorAll('[data-cambiar-tarifa]').forEach(b => b.onclick = () => {
    const [asigId, tipo] = b.dataset.cambiarTarifa.split('|');
    modalCambiarTarifaAsignatura(Number(asigId), tipo);
  });
}

// Los buscadores en vivo reconstruyen toda la pantalla en cada letra (innerHTML),
// lo que sustituye el <input> por uno nuevo y le hace perder el foco: sin esto,
// solo se puede escribir una letra cada vez. Guarda qué campo y qué posición del
// cursor tenía el foco, ejecuta el re-render, y lo restaura después.
function conFocoPreservado(fn) {
  const activo = document.activeElement;
  const id = activo && activo.id;
  const inicio = activo && 'selectionStart' in activo ? activo.selectionStart : null;
  const fin = activo && 'selectionEnd' in activo ? activo.selectionEnd : null;
  fn();
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.focus();
  if (inicio != null && 'setSelectionRange' in el) {
    try { el.setSelectionRange(inicio, fin); } catch { /* tipo de input sin selección de texto */ }
  }
}

// ---------------------------------------------------------------- modal y toast

// `avisoAbierto` (ver más abajo) recuerda qué aviso de Inicio está mostrado
// ahora mismo, para poder refrescarlo en vivo. Se limpia aquí, en el único
// sitio por el que pasan TODOS los modales de la app sin excepción: así,
// abra lo que abra un botón de un aviso ("Completar" → modalAlumno, "Editar
// ficha" → modalAlumno, "Generar recibo" → modalRecibo...), el aviso queda
// invalidado automáticamente sin tener que acordarse de limpiarlo a mano en
// cada sitio — y un modal de edición normal nunca puede confundirse con uno
// de aviso ni ser sustituido por un refresco en tiempo real de otro admin.
function abrirModal(html) {
  avisoAbierto = null;
  document.getElementById('modal-raiz').innerHTML =
    `<div class="velo"><div class="modal">${html}</div></div>`;
  document.querySelector('.velo').onclick = (ev) => { if (ev.target.classList.contains('velo')) cerrarModal(); };
}

function cerrarModal() {
  document.getElementById('modal-raiz').innerHTML = '';
  if (S.actualizacionPendiente) mostrarPantallaActualizacion(S.actualizacionPendiente);
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
