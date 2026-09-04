export const config = { runtime: 'edge' };

const CHECKOUT_BASE = 'https://strivapay.com/c/sharkblack';
const VALID_INDEXES = [0, 1, 2, 3];

// Datacenter ASNs that bots commonly come from. Real customers rarely use these.
const SUSPICIOUS_ASNS = new Set([
  '14618', '16509', '8075', '15169', '13335', '14061', '63949',
  '32934', '36351', '20473', '174', '8068', '396982', '24940',
  '46606', '53667', '212238', '210644'
]);

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

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return { skipped: true };
  if (!token) return { success: false, reason: 'missing-token' };
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' })
    });
    const data = await res.json();
    return { success: !!data.success, codes: data['error-codes'] || [] };
  } catch { return { success: false, reason: 'turnstile-error' }; }
}

function parseIndexes(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map(s => parseInt(s.trim(), 10));
  if (!parts.length) return null;
  if (parts.some(n => !VALID_INDEXES.includes(n))) return null;
  return Array.from(new Set(parts)).sort((a, b) => a - b);
}

function classifyUserAgent(ua) {
  if (!ua) return { bot: true, reason: 'no-ua' };
  const u = ua.toLowerCase();
  const botSignals = [
    'bot', 'crawler', 'spider', 'curl', 'wget', 'python', 'headless',
    'phantomjs', 'selenium', 'puppeteer', 'playwright', 'scrapy',
    'http-client', 'go-http', 'java/', 'ruby', 'lighthouse'
  ];
  for (const s of botSignals) if (u.includes(s)) return { bot: true, reason: `ua:${s}` };
  return { bot: false };
}

function dayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function logEvent(verdict, meta) {
  const day = dayKey();
  const ts = Date.now();
  const entry = JSON.stringify({ ts, verdict, ...meta });
  await kv([
    ['INCR', `stats:${day}:total`],
    ['INCR', `stats:${day}:${verdict}`],
    ['LPUSH', `events:${day}`, entry],
    ['LTRIM', `events:${day}`, '0', '199'],
    ['EXPIRE', `events:${day}`, '2592000'],
    ['EXPIRE', `stats:${day}:total`, '2592000'],
    ['EXPIRE', `stats:${day}:${verdict}`, '2592000'],
    ['SADD', 'stats:days', day]
  ]);
}

export default async function handler(req) {
  const url = new URL(req.url);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || req.headers.get('x-real-ip')
          || 'unknown';
  const ua = req.headers.get('user-agent') || '';
  const referer = req.headers.get('referer') || '';
  const country = req.headers.get('x-vercel-ip-country') || '';
  const asn = req.headers.get('x-vercel-ip-asn') || '';

  const v = url.searchParams.get('v');
  const token = url.searchParams.get('t') || '';
  const ttclid = url.searchParams.get('ttclid') || '';
  const honeypot = url.searchParams.get('email_alt') || '';

  const indexes = parseIndexes(v);
  const meta = {
    ip: ip.replace(/\.\d+$/, '.x'), // anonymise last octet
    ua: ua.slice(0, 180),
    country, asn,
    referer: referer.slice(0, 180),
    indexes: indexes || [],
    hasTtclid: !!ttclid
  };

  // 1. Honeypot — only bots fill this hidden field
  if (honeypot) {
    await logEvent('blocked_honeypot', meta);
    return new Response('Forbidden', { status: 403 });
  }

  // 2. Invalid indexes
  if (!indexes) {
    await logEvent('blocked_invalid', meta);
    return new Response('Bad request', { status: 400 });
  }

  // 3. Bot user-agent
  const uaCheck = classifyUserAgent(ua);
  if (uaCheck.bot) {
    await logEvent('blocked_ua', { ...meta, reason: uaCheck.reason });
    return new Response('Forbidden', { status: 403 });
  }

  // 4. Geo: campaign runs in the UK; BR allowed for owner testing.
  // STRICT: empty country is also blocked (was previously allowed — caused leaks)
  const ALLOWED_COUNTRIES = new Set(['GB', 'BR']);
  if (!ALLOWED_COUNTRIES.has(country)) {
    await logEvent('blocked_geo', { ...meta, reason: `geo:${country || 'unknown'}` });
    return new Response('Forbidden', { status: 403 });
  }

  // 5. Datacenter ASN
  if (asn && SUSPICIOUS_ASNS.has(asn)) {
    await logEvent('blocked_asn', { ...meta, reason: `asn:${asn}` });
    return new Response('Forbidden', { status: 403 });
  }

  // 6. Cloudflare Turnstile (the strongest check)
  // Soft-fail: empty token (widget glitch) DOES NOT block — only an invalid token blocks.
  // Real visitors who survived honeypot+UA+geo+ASN are extremely unlikely to be bots,
  // and we cannot afford to block a single GB customer because Turnstile widget hiccuped.
  const ts = await verifyTurnstile(token, ip);
  if (ts.skipped) {
    // Secret not configured yet — log warning, allow request
    await logEvent('allowed_unverified', { ...meta, reason: 'turnstile-not-configured' });
  } else if (!ts.success) {
    if (ts.reason === 'missing-token' || ts.reason === 'turnstile-error') {
      // Widget failed to issue a token (network glitch, CF outage, slow device).
      // Other layers already cleared this visitor — let them through.
      await logEvent('allowed_no_token', { ...meta, reason: ts.reason });
    } else {
      // Token was present but Cloudflare rejected it. Likely a bot replaying a fake token.
      await logEvent('blocked_turnstile', { ...meta, codes: ts.codes, reason: ts.reason });
      return new Response('Forbidden', { status: 403 });
    }
  } else {
    await logEvent('allowed', meta);
  }

  // Generate HMAC-signed checkout token (lp ↔ strivapay shared secret).
  // Strivapay validates this token: rejects requests without it / with expired or invalid signature.
  const checkoutToken = await signCheckoutToken({ v: indexes, c: country, exp: Math.floor(Date.now() / 1000) + 900 });
  const params = new URLSearchParams({ v: indexes.join(',') });
  if (checkoutToken) params.set('t', checkoutToken);
  const target = `${CHECKOUT_BASE}?${params.toString()}`;
  return Response.redirect(target, 302);
}

// HMAC-SHA256 signed payload (base64url), used by Strivapay to validate the visitor passed our filter.
async function signCheckoutToken(payload) {
  const secret = process.env.STRIVAPAY_SHARED_SECRET;
  if (!secret) return ''; // backwards compat: if secret not set yet, omit token
  try {
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = b64urlEncode(new TextEncoder().encode(payloadStr));
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
    const sigB64 = b64urlEncode(new Uint8Array(sigBuf));
    return `${payloadB64}.${sigB64}`;
  } catch { return ''; }
}

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
