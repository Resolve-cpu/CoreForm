// Vercel Serverless Function
// Endpoint: POST /api/webhook
//
// O Stripe chama esta URL automaticamente sempre que algo acontece com um
// pagamento (confirmado, falhou, etc). É a forma confiável de saber que um
// pagamento realmente foi concluído — o navegador do cliente pode fechar a
// aba, cair a internet, etc, mas o Stripe sempre avisa este endpoint.
//
// CONFIGURAÇÃO NECESSÁRIA (depois do deploy):
// 1. No painel do Stripe → Developers → Webhooks → Add endpoint
// 2. URL do endpoint: https://SEU-DOMINIO.vercel.app/api/webhook
// 3. Eventos a escutar: payment_intent.succeeded, payment_intent.payment_failed
// 4. Copie o "Signing secret" (começa com whsec_) e adicione como variável de
//    ambiente STRIPE_WEBHOOK_SECRET no projeto da Vercel.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// A verificação de assinatura do Stripe precisa do corpo "cru" (raw) da
// requisição, então desligamos o parser automático de JSON da Vercel aqui.
export const config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method not allowed');
  }

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const items = paymentIntent.metadata?.items
        ? JSON.parse(paymentIntent.metadata.items)
        : [];

      console.log('✅ Pagamento confirmado:', {
        id: paymentIntent.id,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency,
        items,
      });

      // 👉 Aqui é onde você adicionaria, se quiser:
      //   - salvar o pedido num banco de dados
      //   - enviar um email de confirmação pro cliente
      //   - notificar você mesmo (Slack, email, etc)
      // Por enquanto isso só fica registrado no log da Vercel.

      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      console.warn('⚠️ Pagamento falhou:', paymentIntent.id, paymentIntent.last_payment_error?.message);
      break;
    }

    default:
      // Outros eventos que o Stripe possa enviar — ignoramos por enquanto.
      break;
  }

  // Sempre responder 200 rápido para o Stripe, senão ele fica reenviando o evento.
  res.status(200).json({ received: true });
}
