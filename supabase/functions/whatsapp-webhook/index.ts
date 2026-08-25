// Recibe los avisos de estado de WhatsApp (entregado, leído, fallido) y los
// guarda en la fila de recibos correspondiente, para que en la pestaña
// Recibos se vea sin tener que preguntar a nadie si de verdad llegó.
//
// Meta llama a esta función directamente (no hay sesión de ningún profesor
// detrás), así que la autenticación es propia: en vez del JWT de Supabase,
// comprueba la firma de cada aviso con la clave secreta de la App. Por eso
// esta función se despliega con verify_jwt=false.
//
// Credenciales (Supabase → Edge Functions → Secrets):
//   WHATSAPP_APP_SECRET     clave secreta de la app de Meta (firma los webhooks)
//   WHATSAPP_VERIFY_TOKEN   palabra que se pone también en Meta al dar de alta el webhook

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Para poder correlacionar avisos que lleguen desordenados: un "delivered"
// tras un "read" no debe hacer retroceder el estado ya mostrado.
const ORDEN: Record<string, number> = { enviado: 0, entregado: 1, leido: 2, fallido: 3 };

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compara en tiempo constante para no filtrar la firma esperada por temporización.
function igualesSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function firmaValida(cuerpoCrudo: string, cabecera: string | null, secreto: string): Promise<boolean> {
  if (!cabecera?.startsWith('sha256=')) return false;
  const clave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const firma = await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(cuerpoCrudo));
  return igualesSeguro(hex(firma), cabecera.slice('sha256='.length));
}

async function actualizarEstado(wamid: string, estado: string) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/recibos?whatsapp_message_id=eq.${encodeURIComponent(wamid)}&select=id,estado_whatsapp`,
    { headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY } }
  );
  const filas = await r.json();
  if (!Array.isArray(filas) || !filas.length) return; // recibo no encontrado (mensaje de prueba, u otra época)

  const actual = filas[0].estado_whatsapp as string | null;
  if (actual && ORDEN[actual] >= ORDEN[estado]) return;

  await fetch(`${SUPABASE_URL}/rest/v1/recibos?whatsapp_message_id=eq.${encodeURIComponent(wamid)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify({ estado_whatsapp: estado })
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verificación inicial que hace Meta al dar de alta el webhook (una sola vez).
  if (req.method === 'GET') {
    const modo = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const desafio = url.searchParams.get('hub.challenge') ?? '';
    if (modo === 'subscribe' && token === Deno.env.get('WHATSAPP_VERIFY_TOKEN')) {
      return new Response(desafio, { status: 200 });
    }
    return new Response('Token de verificación incorrecto', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  const cuerpoCrudo = await req.text();
  const secreto = Deno.env.get('WHATSAPP_APP_SECRET');
  if (secreto) {
    const ok = await firmaValida(cuerpoCrudo, req.headers.get('x-hub-signature-256'), secreto);
    if (!ok) return new Response('Firma no válida', { status: 401 });
  }

  try {
    const payload = JSON.parse(cuerpoCrudo);
    for (const entry of payload.entry ?? []) {
      for (const cambio of entry.changes ?? []) {
        for (const st of cambio.value?.statuses ?? []) {
          if (st.status === 'failed') await actualizarEstado(st.id, 'fallido');
          else if (st.status === 'read') await actualizarEstado(st.id, 'leido');
          else if (st.status === 'delivered') await actualizarEstado(st.id, 'entregado');
          // "sent" no se guarda aparte: ya se marca al enviar desde la propia app.
        }
      }
    }
  } catch {
    // Un aviso que no se entienda no debe hacer que Meta lo reintente sin parar.
  }

  // Meta espera un 200 rápido; si no lo recibe, reintenta el mismo aviso.
  return new Response('EVENT_RECEIVED', { status: 200 });
});
