// Vercel Serverless Function
// Endpoint: POST /api/create-payment-intent
//
// Recebe { items: [{ size, qty }, ...] } do checkout.html e cria um
// PaymentIntent no Stripe. O valor cobrado é SEMPRE calculado aqui,
// no servidor, usando a tabela de preços abaixo — nunca confiamos em
// um preço vindo do navegador do cliente (isso evita que alguém
// manipule o preço antes de pagar).
//
// PROMOÇÃO ATIVA: 1ª unidade preço cheio, 2ª unidade com 20% de desconto
// (repete a cada par: 3ª cheia, 4ª com desconto...). Essa regra também
// existe em index.html e checkout.html (função calcLineTotal) — se mudar
// aqui, mude nos três lugares.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Mantenha esta tabela sempre igual à SIZE_PRICES do index.html e do checkout.html.
const SIZE_PRICES = {
  '3 L': 39.00,
  '4.3 L': 49.00,
  '5 L': 69.00,
  '6.6 L': 90.00,
};

const MAX_QTY_PER_ITEM = 9;

// Promoção: 1ª unidade preço cheio, a 2ª tem 20% off — repete a cada par.
// Trabalha em pence pra evitar erro de arredondamento com ponto flutuante.
function calcLineTotalPence(unitPricePence, qty) {
  const pairs = Math.floor(qty / 2);
  const remainder = qty % 2;
  return Math.round(pairs * unitPricePence * 1.8) + (remainder * unitPricePence);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Basket is empty.' });
    }

    let amountInPence = 0;

    for (const item of items) {
      const price = SIZE_PRICES[item?.size];
      const qty = Number(item?.qty);

      if (!price) {
        return res.status(400).json({ error: `Invalid size: ${item?.size}` });
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
        return res.status(400).json({ error: 'Invalid quantity.' });
      }

      amountInPence += calcLineTotalPence(Math.round(price * 100), qty);
    }

    if (amountInPence < 30) {
      // Stripe exige um valor mínimo (cerca de £0.30 para GBP)
      return res.status(400).json({ error: 'Order total is too low to process.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInPence,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: {
        items: JSON.stringify(items),
      },
    });

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    return res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
}
