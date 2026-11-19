// Mensajes sueltos por WhatsApp (pestaña "Mensajes" de la app): felicitaciones,
// avisos de error en un justificante o un recibo... Va aparte de
// `enviar-whatsapp` (la de los recibos) a propósito: así lo que ya funciona no
// se toca.
//
// Qué plantilla se usa, con qué nombre en Meta y si está ACTIVA sale de la
// tabla `mensajes_plantillas`. Mientras una plantilla no esté marcada como
// activa (porque aún no está creada y aprobada en Meta), esta función NO
// envía nada. Tampoco hay modo simulación: o se envía de verdad o se dice por
// qué no.
//
// Credenciales: las mismas que `enviar-whatsapp` (WHATSAPP_TOKEN y
// WHATSAPP_PHONE_ID, en Supabase → Edge Functions → Secrets).

const API = 'https://graph.facebook.com/v21.0';

type Peticion = {
  tipo?: string;
  telefono?: string;
  variables?: string[];
  pdfBase64?: string;
  nombreArchivo?: string;
};

const cabeceras = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function respuesta(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: cabeceras });
}

// Solo el ADMINISTRADOR activo con sesión iniciada. Devuelve su token para
// poder leer la tabla de plantillas con sus propios permisos.
async function adminQueLlama(req: Request): Promise<{ id: string; token: string; url: string; anon: string } | null> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return null;

  const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: anon } });
  if (!r.ok) return null;
  const usuario = await r.json();
  if (!usuario?.id) return null;

  const p = await fetch(`${url}/rest/v1/profesores?id=eq.${usuario.id}&select=estado,es_admin`,
    { headers: { Authorization: `Bearer ${token}`, apikey: anon } });
  if (!p.ok) return null;
  const filas = await p.json();
  if (!Array.isArray(filas) || !filas.length) return null;
  if (filas[0].estado === 'baja' || !filas[0].es_admin) return null;
  return { id: usuario.id, token, url, anon };
}

function normalizarTelefono(tel: string): string | null {
  let t = String(tel || '').replace(/[^\d+]/g, '');
  if (t.startsWith('+')) t = t.slice(1);
  if (t.length === 9 && /^[679]/.test(t)) t = '34' + t;
  return t.length >= 10 && t.length <= 15 ? t : null;
}

// Meta no admite saltos de línea, tabuladores ni más de 4 espacios seguidos en
// un dato de plantilla, ni uno vacío.
function limpiarVariable(v: unknown): string {
  const t = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  return t || '-';
}

async function subirPdf(token: string, phoneId: string, pdfBase64: string, nombreArchivo: string) {
  const binario = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([binario], { type: 'application/pdf' }), nombreArchivo);
  const r = await fetch(`${API}/${phoneId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const datos = await r.json();
  if (!r.ok) throw new Error(datos?.error?.message || 'No se pudo subir el PDF a WhatsApp');
  return datos.id as string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cabeceras });

  const quien = await adminQueLlama(req);
  if (!quien) return respuesta({ ok: false, error: 'Solo el administrador puede enviar mensajes por WhatsApp' }, 401);

  let p: Peticion;
  try {
    p = await req.json();
  } catch {
    return respuesta({ ok: false, error: 'Petición mal formada' }, 400);
  }
  if (!p.tipo) return respuesta({ ok: false, error: 'Falta el tipo de mensaje' }, 400);

  // La plantilla: nombre en Meta, idioma, si lleva PDF, cuántos datos y si está activa.
  const rp = await fetch(
    `${quien.url}/rest/v1/mensajes_plantillas?tipo=eq.${encodeURIComponent(p.tipo)}&select=nombre_meta,idioma,activa,lleva_pdf,variables`,
    { headers: { Authorization: `Bearer ${quien.token}`, apikey: quien.anon } }
  );
  if (!rp.ok) return respuesta({ ok: false, error: 'No se pudo leer la plantilla' }, 500);
  const plantillas = await rp.json();
  if (!Array.isArray(plantillas) || !plantillas.length) return respuesta({ ok: false, error: 'Ese tipo de mensaje no existe' }, 404);
  const plantilla = plantillas[0];

  // Interruptor de seguridad: sin plantilla aprobada en Meta y activada, nada sale.
  if (!plantilla.activa) {
    return respuesta({ ok: false, inactiva: true, error: 'Esta plantilla todavía no está activa (falta crearla y aprobarla en Meta).' }, 409);
  }

  const telefono = normalizarTelefono(p.telefono || '');
  if (!telefono) return respuesta({ ok: false, error: 'El teléfono no es válido para WhatsApp' }, 400);

  const esperadas = Array.isArray(plantilla.variables) ? plantilla.variables.length : 0;
  const variables = Array.isArray(p.variables) ? p.variables : [];
  if (variables.length !== esperadas) {
    return respuesta({ ok: false, error: `Esta plantilla lleva ${esperadas} dato(s) y se han mandado ${variables.length}` }, 400);
  }
  if (plantilla.lleva_pdf && !p.pdfBase64) {
    return respuesta({ ok: false, error: 'Esta plantilla necesita un PDF adjunto' }, 400);
  }

  const token = Deno.env.get('WHATSAPP_TOKEN');
  const phoneId = Deno.env.get('WHATSAPP_PHONE_ID');
  if (!token || !phoneId) return respuesta({ ok: false, error: 'WhatsApp no está configurado en el servidor' }, 503);

  try {
    const componentes: unknown[] = [];
    if (plantilla.lleva_pdf) {
      const nombreArchivo = p.nombreArchivo || 'documento.pdf';
      const mediaId = await subirPdf(token, phoneId, p.pdfBase64 as string, nombreArchivo);
      componentes.push({ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: nombreArchivo } }] });
    }
    if (esperadas > 0) {
      componentes.push({ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: limpiarVariable(v) })) });
    }

    const r = await fetch(`${API}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'template',
        template: { name: plantilla.nombre_meta, language: { code: plantilla.idioma || 'es' }, components: componentes }
      })
    });
    const datos = await r.json();
    if (!r.ok) return respuesta({ ok: false, error: datos?.error?.message || 'WhatsApp rechazó el envío' }, 400);
    return respuesta({ ok: true, mensajeId: datos?.messages?.[0]?.id ?? null });
  } catch (err) {
    return respuesta({ ok: false, error: (err as Error).message }, 500);
  }
});
