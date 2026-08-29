// ── Client Stripe minimal (API REST, sans dépendance npm) ────────────────
// Préfixe "_" : Vercel ne traite pas ce fichier comme une route.
//
// Pourquoi pas le SDK `stripe` officiel : ce projet parle déjà à Supabase et
// à Brevo par `fetch` sur leur API REST, sans SDK. Stripe expose la même
// chose (form-urlencoded en entrée, JSON en sortie) et les trois appels dont
// on a besoin tiennent en quelques lignes. Rester sans dépendance garde le
// cold start court sur les fonctions Vercel et évite d'embarquer ~2 Mo pour
// trois endpoints.
//
// La vérification de signature des webhooks est réimplémentée ici (HMAC
// SHA256, algorithme public et stable documenté par Stripe) plutôt que
// déléguée au SDK — c'est le seul morceau non trivial, il est testé.

import crypto from 'crypto';

const STRIPE_API = 'https://api.stripe.com/v1';

export function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Sérialise en form-urlencoded avec la convention Stripe pour les objets
// imbriqués (a[b]=c) — nécessaire pour metadata[...] et line_items[0][...].
function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') encodeForm(item, `${key}[${i}]`, out);
        else out.push(`${key}[${i}]=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === 'object') {
      encodeForm(v, key, out);
    } else {
      out.push(`${key}=${encodeURIComponent(v)}`);
    }
  }
  return out;
}

export async function stripeRequest(path, { method = 'POST', body } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquante côté serveur');
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? encodeForm(body).join('&') : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(`Stripe ${method} ${path} → ${msg}`);
  }
  return data;
}

// ── Paliers ↔ prix Stripe ────────────────────────────────────────────────
// Les identifiants de prix vivent en variables d'environnement, jamais dans
// le code : ils diffèrent entre le mode test et le mode live, et un
// changement de tarif crée un nouveau price id chez Stripe. Un palier dont
// la variable n'est pas renseignée n'est simplement pas proposé à l'achat —
// pas d'erreur, pas de prix inventé.
export const PLAN_PRICE_ENV = {
  essentiel: 'STRIPE_PRICE_ESSENTIEL',
  pro: 'STRIPE_PRICE_PRO',
  reseau: 'STRIPE_PRICE_RESEAU',
};

export function priceIdForPlan(plan) {
  const envName = PLAN_PRICE_ENV[plan];
  if (!envName) return null;
  const value = process.env[envName];
  return value && value.trim() ? value.trim() : null;
}

export function purchasablePlans() {
  return Object.keys(PLAN_PRICE_ENV).filter(p => !!priceIdForPlan(p));
}

// Retrouve le palier correspondant à un price id reçu d'un webhook — c'est
// ce qui permet de refléter en base un changement de palier fait depuis le
// portail de facturation Stripe, sans repasser par l'app.
export function planForPriceId(priceId) {
  if (!priceId) return null;
  for (const plan of Object.keys(PLAN_PRICE_ENV)) {
    if (priceIdForPlan(plan) === priceId) return plan;
  }
  return null;
}

// ── Vérification de signature d'un webhook ───────────────────────────────
// L'en-tête vaut `t=<timestamp>,v1=<signature>[,v1=<autre>]`. La signature
// porte sur `<timestamp>.<corps brut>` — d'où l'obligation de lire le corps
// AVANT tout parsing JSON (voir readRawBody + la config bodyParser dans
// stripe-webhook.js) : re-sérialiser l'objet parsé donnerait un octet
// différent et invaliderait toute signature.
//
// Plusieurs `v1` peuvent coexister pendant une rotation de secret : on
// accepte si l'un correspond. La tolérance temporelle (5 min par défaut,
// valeur recommandée par Stripe) ferme la porte au rejeu d'une requête
// interceptée.
export function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSec = 300, nowMs = Date.now()) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const parts = String(signatureHeader).split(',').map(s => s.trim());
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || !signatures.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

// Lit le corps brut d'une requête Vercel dont le parsing automatique a été
// désactivé. Renvoie une chaîne — c'est ce que la signature couvre.
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Origine publique du déploiement, pour construire les URLs de retour de
// Checkout. VERCEL_URL est fournie automatiquement par Vercel (sans schéma)
// et couvre aussi bien la prod que les previews ; STAGELY_PUBLIC_URL permet
// de forcer le domaine définitif une fois qu'il existera.
export function publicOrigin(req) {
  const forced = process.env.STAGELY_PUBLIC_URL;
  if (forced) return forced.replace(/\/+$/, '');
  const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || process.env.VERCEL_URL;
  if (!host) return '';
  return host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host}`;
}
