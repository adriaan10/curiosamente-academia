// Envío de recibos por WhatsApp (API oficial de Meta).
//
// Esta función vive en el servidor de Supabase, NO en la app, porque guarda
// el token de acceso de WhatsApp: el código de la app es público y ahí no
// puede haber ninguna credencial.
//
// Mientras no se configuren las credenciales de Meta, funciona en "modo
// simulación": responde como si hubiera enviado, para poder probar todo el
// circuito (tandas, estados, avisos) sin gastar ni un mensaje real.
//
// Credenciales (Supabase → Edge Functions → Secrets):
//   WHATSAPP_TOKEN             token permanente de la app de Meta
//   WHATSAPP_PHONE_ID          ID del número emisor (Phone Number ID)
//   WHATSAPP_TEMPLATE_RECIBO   nombre de la plantilla de envío de recibo
//   WHATSAPP_TEMPLATE_PAGO     nombre de la plantilla de confirmación de pago
//   WHATSAPP_IDIOMA            código de idioma de las plantillas (por defecto es)

const API = 'https://graph.facebook.com/v21.0';

type Peticion = {
  tipo: 'recibo' | 'pago';
  telefono: string;
  nombre: string;
  concepto: string;
  importe: string;
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

// Comprueba que quien llama es un profesor con sesión iniciada y en activo.
// Sin esto bastaría la clave pública de la app (que es visible en el código)
// para provocar envíos reales, que cuestan dinero.
async function profesorQueLlama(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return null;

  // La clave pública también es un "token" válido para la pasarela, pero no
  // corresponde a ningún usuario: esta llamada solo devuelve datos si hay
  // detrás una sesión real de profesor.
  const r = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anon }
  });
  if (!r.ok) return null;
  const usuario = await r.json();
  if (!usuario?.id) return null;

  // Un profesor dado de baja no puede enviar nada.
  const p = await fetch(
    `${url}/rest/v1/profesores?id=eq.${usuario.id}&select=estado`,
    { headers: { Authorization: `Bearer ${token}`, apikey: anon } }
  );
  if (!p.ok) return null;
  const filas = await p.json();
  if (!Array.isArray(filas) || !filas.length || filas[0].estado === 'baja') return null;

  return { id: usuario.id };
}

// Deja el teléfono en formato internacional sin símbolos (34XXXXXXXXX).
function normalizarTelefono(tel: string): string | null {
  let t = String(tel || '').replace(/[^\d+]/g, '');
  if (t.startsWith('+')) t = t.slice(1);
  if (t.length === 9 && /^[679]/.test(t)) t = '34' + t;
  return t.length >= 10 ? t : null;
}

// Sube el PDF a Meta y devuelve su identificador de archivo.
async function subirPdf(token: string, phoneId: string, pdfBase64: string, nombreArchivo: string) {
  const binario = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([binario], { type: 'application/pdf' }), nombreArchivo);

  const r = await fetch(`${API}/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const datos = await r.json();
  if (!r.ok) throw new Error(datos?.error?.message || 'No se pudo subir el PDF a WhatsApp');
  return datos.id as string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cabeceras });

  const quien = await profesorQueLlama(req);
  if (!quien) {
    return respuesta({ ok: false, error: 'Necesitas iniciar sesión como profesor activo' }, 401);
  }

  let p: Peticion;
  try {
    p = await req.json();
  } catch {
    return respuesta({ ok: false, error: 'Petición mal formada' }, 400);
  }

  const telefono = normalizarTelefono(p.telefono);
  if (!telefono) {
    return respuesta({ ok: false, error: 'El teléfono no es válido para WhatsApp' }, 400);
  }

  const token = Deno.env.get('WHATSAPP_TOKEN');
  const phoneId = Deno.env.get('WHATSAPP_PHONE_ID');

  // Modo simulación: sin credenciales no se envía nada, pero el circuito
  // completo de la app se puede probar igual.
  if (!token || !phoneId) {
    return respuesta({
      ok: true,
      simulado: true,
      aviso: 'WhatsApp aún no está configurado: no se ha enviado ningún mensaje real.'
    });
  }

  const idioma = Deno.env.get('WHATSAPP_IDIOMA') || 'es';
  const plantilla = p.tipo === 'pago'
    ? (Deno.env.get('WHATSAPP_TEMPLATE_PAGO') || 'pago_confirmado')
    : (Deno.env.get('WHATSAPP_TEMPLATE_RECIBO') || 'envio_recibo');

  try {
    const componentes: unknown[] = [];

    if (p.pdfBase64) {
      const mediaId = await subirPdf(token, phoneId, p.pdfBase64, p.nombreArchivo || 'recibo.pdf');
      componentes.push({
        type: 'header',
        parameters: [{ type: 'document', document: { id: mediaId, filename: p.nombreArchivo || 'recibo.pdf' } }]
      });
    }

    // El orden de los datos debe coincidir con el de la plantilla aprobada:
    //   recibo → {{1}} nombre, {{2}} concepto, {{3}} importe
    //   pago   → {{1}} nombre, {{2}} importe, {{3}} concepto
    const textos = p.tipo === 'pago'
      ? [p.nombre, p.importe, p.concepto]
      : [p.nombre, p.concepto, p.importe];
    componentes.push({
      type: 'body',
      parameters: textos.map((t) => ({ type: 'text', text: String(t ?? '') }))
    });

    const r = await fetch(`${API}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'template',
        template: { name: plantilla, language: { code: idioma }, components: componentes }
      })
    });
    const datos = await r.json();
    if (!r.ok) {
      return respuesta({ ok: false, error: datos?.error?.message || 'WhatsApp rechazó el envío' }, 400);
    }
    return respuesta({ ok: true, mensajeId: datos?.messages?.[0]?.id ?? null });
  } catch (err) {
    return respuesta({ ok: false, error: (err as Error).message }, 500);
  }
});
