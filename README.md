# The Cookery — site + checkout + pagamento

Estrutura do projeto:

```
/
├── index.html                     → landing page do produto
├── checkout.html                  → página de checkout (Stripe Elements)
├── images/                        → fotos do produto (5 por litragem)
├── api/
│   ├── create-payment-intent.js   → função serverless que cria o pagamento no Stripe
│   └── webhook.js                 → recebe a confirmação do Stripe quando um pagamento é concluído
├── package.json
├── .env.example
└── .gitignore
```

## Como funciona o fluxo

1. Cliente escolhe a litragem e clica **Add to basket** na `index.html`.
2. Clica no ícone do carrinho → abre o painel lateral → **Proceed to Payment**.
3. Isso leva para `checkout.html?cart=...` passando o tamanho e a quantidade de cada item (não o preço — o preço nunca vem do navegador).
4. `checkout.html` chama `POST /api/create-payment-intent`.
5. `api/create-payment-intent.js` recalcula o valor total **no servidor**, usando a tabela de preços (`SIZE_PRICES`), e cria o PaymentIntent no Stripe.
6. O Stripe Elements (cartão, Apple Pay, Google Pay) processa o pagamento.
7. Assim que o pagamento é concluído, o Stripe chama `api/webhook.js` automaticamente pra confirmar — é isso que garante que o pedido só é considerado pago quando o Stripe realmente confirmou, mesmo que o cliente feche a aba antes de ver a tela de sucesso.

## Passo a passo para subir

### 1. GitHub

```bash
git init
git add .
git commit -m "The Cookery — site inicial"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/thecookery.git
git push -u origin main
```

### 2. Vercel

1. Entre em [vercel.com](https://vercel.com) → **Add New Project** → importe o repositório do GitHub.
2. Em **Environment Variables**, adicione:
   - `STRIPE_SECRET_KEY` → sua chave secreta do Stripe (começa com `sk_live_` ou `sk_test_`)
   - `STRIPE_WEBHOOK_SECRET` → veja o passo 4 abaixo (só depois do primeiro deploy)
3. Deploy.

### 3. Chave publicável do Stripe (no front-end)

Já está aplicada em `checkout.html` — é a mesma chave publicável usada no GreatfindsUK, já que os dois sites compartilham a mesma conta Stripe (por decisão sua). Ela é segura de deixar visível no código — é diferente da chave secreta (`sk_`), que só fica na variável de ambiente da Vercel.

### 4. Configurar o webhook (depois do primeiro deploy)

O webhook só pode ser criado depois que o site já tem uma URL pública na Vercel:

1. Faça o primeiro deploy (passo 2 acima) — anote a URL, tipo `https://thecookery.vercel.app`.
2. No painel do Stripe → **Developers → Webhooks → Add endpoint**.
3. URL do endpoint: `https://SEU-DOMINIO.vercel.app/api/webhook`
4. Em "Select events to listen to", marque:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
5. Depois de criar, o Stripe mostra um **Signing secret** (começa com `whsec_`). Copie ele.
6. Volte na Vercel → Environment Variables → adicione `STRIPE_WEBHOOK_SECRET` com esse valor.
7. Faça um novo deploy (ou "Redeploy") pra variável entrar em vigor.

## Antes de publicar de verdade — checklist

- [ ] Configurar `STRIPE_SECRET_KEY` nas variáveis de ambiente da Vercel
- [ ] Configurar o webhook no Stripe e adicionar `STRIPE_WEBHOOK_SECRET` na Vercel (passo 4 acima)
- [ ] Conferir se os preços em `SIZE_PRICES` estão iguais nos 3 lugares: `index.html`, `checkout.html` e `api/create-payment-intent.js`
- [ ] Trocar os depoimentos placeholder na seção "From the kitchen" por avaliações reais de clientes
- [ ] Confirmar a temperatura máxima do forno (linha "Oven-safe" na tabela de especificações) com o fornecedor
- [ ] Testar uma compra completa em modo teste do Stripe antes de ativar o modo live
- [ ] Configurar um domínio próprio na Vercel (em vez do `.vercel.app`)
- [ ] Como as duas lojas dividem a mesma conta Stripe, os pedidos de GreatfindsUK e The Cookery vão aparecer juntos no mesmo dashboard/extrato — vale conferir se isso funciona bem pra sua contabilidade

## Testando localmente

Este projeto usa uma função serverless (`api/`), então para testar o fluxo de pagamento completo (não só o visual) é preciso rodar com a Vercel CLI:

```bash
npm install -g vercel
vercel dev
```

Isso sobe o site e a API juntos em `localhost:3000`, simulando o ambiente da Vercel.
