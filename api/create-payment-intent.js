export const config = { runtime: 'edge' };

// Preço único do CoreForm Pilates Board (todas as cores) — mesma tabela do checkout.html.
// O valor final é SEMPRE recalculado aqui, nunca confiamos no total vindo do cliente.
const PRICE_GBP = 39.00;
const VALID_COLORS = new Set(['Pink', 'Purple']);

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return new Response(JSON.stringify({ error: 'Stripe is not configured on the server yet.' }), { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const validItems = items.filter(
    it => VALID_COLORS.has(it.color) && Number.isInteger(it.qty) && it.qty > 0 && it.qty <= 9
  );

  if (!validItems.length) {
    return new Response(JSON.stringify({ error: 'Empty or invalid cart' }), { status: 400 });
  }

  const totalQty = validItems.reduce((sum, it) => sum + it.qty, 0);
  const amount = Math.round(PRICE_GBP * totalQty * 100); // valor em pence

  try {
    const params = new URLSearchParams({
      amount: String(amount),
      currency: 'gbp',
      'automatic_payment_methods[enabled]': 'true',
      'metadata[store]': 'CoreForm',
      'metadata[items]': JSON.stringify(validItems),
    });

    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'Stripe error' }), { status: 500 });
    }

    return new Response(JSON.stringify({ clientSecret: data.client_secret }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Could not start payment' }), { status: 500 });
  }
}
