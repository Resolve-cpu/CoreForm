export const config = { runtime: 'edge' };

// Valida a assinatura do Stripe manualmente (sem precisar do SDK stripe),
// comparando o HMAC-SHA256 do corpo bruto com o header Stripe-Signature.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

async function kv(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return new Response('Webhook secret not configured', { status: 500 });
  }

  const sigHeader = req.headers.get('stripe-signature');
  const rawBody = await req.text();

  const valid = await verifyStripeSignature(rawBody, sigHeader, secret);
  if (!valid) {
    return new Response('Invalid signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Só nos importa a confirmação de pagamento por enquanto.
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const order = {
      id: pi.id,
      amount: pi.amount / 100,
      currency: pi.currency,
      items: pi.metadata?.items || null,
      store: pi.metadata?.store || 'CoreForm',
      created: pi.created,
    };

    // Guarda o pedido confirmado no KV (mesmo banco usado pelo go.js) por 90 dias.
    const day = new Date().toISOString().slice(0, 10);
    await kv([
      ['LPUSH', `orders:${day}`, JSON.stringify(order)],
      ['EXPIRE', `orders:${day}`, '7776000'],
      ['SADD', 'orders:days', day]
    ]);

    // TODO: aqui é onde entraria o envio para planilha/e-mail, quando definirmos qual serviço usar.
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
