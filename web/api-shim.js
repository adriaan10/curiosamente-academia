// window.api para la versión WEB (navegador) de Curiosamente.
//
// El mismo bundle.js de siempre (src/app.js, compilado con esbuild
// --platform=browser) llama a window.api.* sin comprobar si existe —
// en Electron lo define preload.js vía IPC; aquí lo definimos igual,
// pero con equivalentes de navegador, ANTES de cargar bundle.js. No hace
// falta tocar ni una línea de src/app.js: mismo código, mismos datos
// (Supabase en vivo), dos maneras de abrirlo.
//
// Diferencias con Electron, todas a propósito:
//  - PDFs y CSV: se descargan con la descarga normal del navegador, sin
//    carpeta fija. No hay "ruta" que guardar, así que recibos.pdf_path se
//    deja en null — el botón "PDF" siempre regenera uno nuevo con los
//    datos de ahora mismo (mismo contenido; nunca reabre una copia vieja).
//  - Sin auto-actualizador de escritorio: cada carga de la página ya sirve
//    el último bundle publicado (ver el "?v=" en index.html).
//  - Sin "recordar contraseña": la sesión ya la mantiene Supabase sola en
//    este navegador; no hace falta guardar la contraseña aparte.
(() => {
  // Mismos datos de conexión que lleva el instalador de escritorio — la
  // clave es la "publicable" (pensada para ir en apps cliente); la
  // seguridad real la hace el RLS del servidor, no el secreto de esta clave.
  const CONFIG = {
    supabaseUrl: 'https://rwwszlyktvpszcdgwyyu.supabase.co',
    supabaseKey: 'sb_publishable_1rEGTYk5JAM3JKTKaF7bxQ__DR2tngn'
  };

  function descargar(bytes, filename, tipo) {
    const blob = new Blob([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], { type: tipo });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  let logoCache;
  async function getLogo() {
    if (logoCache !== undefined) return logoCache;
    try {
      const res = await fetch('logo.png');
      const buf = await res.arrayBuffer();
      let binario = '';
      new Uint8Array(buf).forEach(b => { binario += String.fromCharCode(b); });
      logoCache = btoa(binario);
    } catch {
      logoCache = null;
    }
    return logoCache;
  }

  window.api = {
    // Marca "esto es la web, no Electron" — src/app.js lo usa SOLO para
    // decidir quién puede entrar a la web (profesores.acceso_web); no existe
    // en el escritorio (preload.js no lo define), así que nunca le afecta.
    esWeb: true,

    getConfig: async () => ({ ...CONFIG }),
    setConfig: async (partial) => ({ ...CONFIG, ...partial }), // no persiste: no hace falta en la web

    savePdf: async (bytes, filename) => { descargar(bytes, filename, 'application/pdf'); return null; },
    savePdfLote: async (bytes, filename) => { descargar(bytes, filename, 'application/pdf'); return null; },
    // false = "no hay copia guardada en este equipo" -> la app ya sabe
    // regenerar uno nuevo a partir de los datos y lo descarga.
    openPdf: async () => false,
    revealPdf: async () => {},
    pdfExists: async () => false,
    getRecibosDir: async () => 'tu carpeta de descargas',
    chooseRecibosDir: async () => {
      window.alert('En el navegador, los PDF se descargan siempre a tu carpeta de descargas de siempre — no hay una carpeta que elegir.');
      return null;
    },
    saveCsv: async (content, suggestedName) => {
      descargar(new TextEncoder().encode(content), suggestedName, 'text/csv');
      return 'tu carpeta de descargas';
    },
    saveBackup: async () => {}, // la copia local es cosa del escritorio; en la web los datos ya viven en Supabase

    getLogo,

    getActualizacionPendiente: async () => null,
    onActualizacionLista: () => {},
    instalarActualizacion: () => location.reload(),
    comprobarActualizacionesAhora: () => {}, // cada carga ya sirve el último bundle publicado
    restartApp: () => location.reload(),

    guardarCredenciales: async () => {},
    cargarCredenciales: async () => null,
    borrarCredenciales: async () => {}
  };
})();
