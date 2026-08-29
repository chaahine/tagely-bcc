// ════════════════════════════════════════════════════════════════════════
// Tests — facturation Stripe
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/billing-stripe.test.mjs
//
// Couvre les quatre routes du chantier facturation et le client REST Stripe
// maison (api/_stripe.js — pas de SDK, cf. l'en-tête de ce fichier). Comme
// partout dans ce dépôt : le VRAI code est exécuté, `fetch` est mocké, aucun
// appel réseau ni aucune clé réelle.
//
// Deux points concentrent le risque et sont couverts en priorité :
//  1. la vérification de signature des webhooks — c'est la seule chose qui
//     empêche n'importe qui d'activer gratuitement son club en POSTant sur
//     un endpoint public ;
//  2. le chemin "club suspendu" de billing-checkout — la seule porte de
//     sortie d'un club dont l'essai a expiré, et donc un endroit où une
//     erreur d'authentification se paierait cher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_PRICE_PRO = 'price_pro_123';
process.env.STRIPE_PRICE_RESEAU = 'price_reseau_456';

const { issueAdminToken, sha256Hex } = await import('../api/_lib.js');
const {
  verifyStripeSignature, priceIdForPlan, planForPriceId, purchasablePlans,
} = await import('../api/_stripe.js');
const checkoutHandler = (await import('../api/billing-checkout.js')).default;
const portalHandler = (await import('../api/billing-portal.js')).default;
const configHandler = (await import('../api/billing-config.js')).default;
const webhookHandler = (await import('../api/stripe-webhook.js')).default;
const { __test: webhookInternals } = await import('../api/stripe-webhook.js');

const ADMIN_ID = 'admin-1';
const CLUB_ID = 'club-aaa';
const PASSWORD = 'motdepasse';

function freshState() {
  return {
    admins: [{ id: ADMIN_ID, email: 'admin@test.fr', password_hash: sha256Hex(PASSWORD) }],
    admin_club_links: [{ admin_id: ADMIN_ID, club_id: CLUB_ID }],
    clubs: [{
      id: CLUB_ID, name: 'Club A', status: 'trial', plan: 'essentiel',
      admin_email: 'admin@test.fr', stripe_customer_id: null, stripe_subscription_id: null,
      trial_ends_at: '2026-01-01T00:00:00Z',
    }],
  };
}

// Mock unique pour Supabase ET Stripe : les deux passent par `fetch`, on les
// distingue par l'hôte. `stripeCalls` capture les corps envoyés à Stripe pour
// vérifier ce qui lui est réellement demandé.
function installMock(state, { stripeResponses = {} } = {}) {
  const original = globalThis.fetch;
  const stripeCalls = [];
  function matchRow(row, search) {
    const usp = new URLSearchParams(search.replace(/^\?/, ''));
    for (const [k, v] of usp.entries()) {
      if (k === 'select' || k === 'limit') continue;
      if (v.startsWith('eq.')) {
        if (String(row[k]) !== decodeURIComponent(v.slice(3))) return false;
      } else if (v.startsWith('in.(') && v.endsWith(')')) {
        const ids = v.slice(4, -1).split(',').map(decodeURIComponent);
        if (!ids.includes(String(row[k]))) return false;
      }
    }
    return true;
  }
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';

    if (u.host === 'api.stripe.com') {
      const body = Object.fromEntries(new URLSearchParams(opts.body || ''));
      stripeCalls.push({ path: u.pathname, method, body });
      const key = Object.keys(stripeResponses).find(k => u.pathname.startsWith(k));
      const payload = key ? stripeResponses[key] : { id: 'obj_1', url: 'https://checkout.stripe.com/pay/test' };
      if (payload && payload.__error) {
        return { ok: false, status: 400, json: async () => ({ error: { message: payload.__error } }) };
      }
      return { ok: true, status: 200, json: async () => payload };
    }

    const table = u.pathname.split('/').pop();
    const store = state[table];
    if (!store) return { ok: false, status: 404, text: async () => 'unknown table', json: async () => ({}) };
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => store.filter(r => matchRow(r, u.search)), text: async () => '' };
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(opts.body);
      // Simule une colonne absente : PostgREST rejette la requête entière.
      const unknown = Object.keys(patch).find(k => !(k in store[0]));
      if (unknown) {
        return { ok: false, status: 400, text: async () => `column "${unknown}" does not exist`, json: async () => ({}) };
      }
      store.forEach(r => { if (matchRow(r, u.search)) Object.assign(r, patch); });
      return { ok: true, status: 204, json: async () => ([]), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => 'unsupported', json: async () => ({}) };
  };
  return { restore: () => { globalThis.fetch = original; }, stripeCalls };
}

function fakeRes() {
  const res = {};
  res.statusCode = 200;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  res.end = () => { res.body = undefined; return res; };
  return res;
}
function fakeReq({ token, body, method = 'POST', headers = {} } = {}) {
  return {
    method,
    headers: { host: 'stagely.test', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  };
}
const validToken = () => issueAdminToken(ADMIN_ID, [{ id: CLUB_ID, name: 'Club A' }], CLUB_ID).token;

// Requête webhook : flux lisible + signature calculée comme le fait Stripe.
function webhookReq(rawBody, { secret = 'whsec_test_fake', timestamp = Math.floor(Date.now() / 1000), signature } = {}) {
  const sig = signature !== undefined
    ? signature
    : crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const req = {
    method: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${sig}` },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(rawBody, 'utf8'));
      if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

// ════════════════════════════════════════════════════════════════════════
// Paliers ↔ prix
// ════════════════════════════════════════════════════════════════════════

test('un palier sans variable d\'environnement n\'est pas achetable', () => {
  assert.equal(priceIdForPlan('pro'), 'price_pro_123');
  assert.equal(priceIdForPlan('essentiel'), null, 'STRIPE_PRICE_ESSENTIEL non renseignée');
  assert.equal(priceIdForPlan('inconnu'), null);
  assert.deepEqual(purchasablePlans().sort(), ['pro', 'reseau']);
});

test('un price id se retraduit en palier (changement fait depuis le portail Stripe)', () => {
  assert.equal(planForPriceId('price_reseau_456'), 'reseau');
  assert.equal(planForPriceId('price_inconnu'), null);
  assert.equal(planForPriceId(undefined), null);
});

test('billing-config n\'expose que les paliers achetables, jamais les price ids', async () => {
  const res = fakeRes();
  await configHandler(fakeReq({ method: 'GET' }), res);
  assert.equal(res.body.enabled, true);
  assert.deepEqual(res.body.plans.sort(), ['pro', 'reseau']);
  assert.equal(JSON.stringify(res.body).includes('price_'), false);
});

// ════════════════════════════════════════════════════════════════════════
// Signature des webhooks — le verrou du seul endpoint public
// ════════════════════════════════════════════════════════════════════════

test('signature valide acceptée', () => {
  const body = '{"hello":"world"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'secret').update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'secret'), true);
});

test('signature calculée sur un corps différent : rejetée', () => {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'secret').update(`${t}.{"a":1}`).digest('hex');
  assert.equal(verifyStripeSignature('{"a":2}', `t=${t},v1=${sig}`, 'secret'), false);
});

test('signature d\'un autre secret : rejetée', () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'autre-secret').update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'secret'), false);
});

test('horodatage trop ancien : rejeté (protection contre le rejeu)', () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000) - 3600;
  const sig = crypto.createHmac('sha256', 'secret').update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'secret'), false);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'secret', 7200), true, 'accepté si la tolérance le permet');
});

test('en-tête malformé, vide ou sans v1 : rejeté', () => {
  for (const header of ['', 'nimportequoi', 't=123', 'v1=abc', undefined]) {
    assert.equal(verifyStripeSignature('{}', header, 'secret'), false, String(header));
  }
});

test('plusieurs signatures v1 (rotation de secret) : accepté si l\'une correspond', () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  const good = crypto.createHmac('sha256', 'secret').update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${good}`, 'secret'), true);
});

test('webhook : une requête non signée ne change RIEN en base', async () => {
  const state = freshState();
  const mock = installMock(state);
  try {
    const res = fakeRes();
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { club_id: CLUB_ID, plan: 'pro' } } } });
    await webhookHandler(webhookReq(body, { signature: 'faux' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(state.clubs[0].status, 'trial', 'aucune activation gratuite possible');
    assert.equal(state.clubs[0].plan, 'essentiel');
  } finally { mock.restore(); }
});

// ════════════════════════════════════════════════════════════════════════
// Webhook — traduction Stripe → état du club
// ════════════════════════════════════════════════════════════════════════

test('statut Stripe → statut club : impayé toléré, abandon suspendu', () => {
  const f = webhookInternals.statusFromSubscription;
  assert.equal(f('active'), 'active');
  assert.equal(f('trialing'), 'active');
  // Stripe relance plusieurs jours : couper à la première carte refusée
  // ferait perdre un client pour une carte expirée.
  assert.equal(f('past_due'), 'active');
  assert.equal(f('incomplete'), 'active');
  assert.equal(f('canceled'), 'suspended');
  assert.equal(f('unpaid'), 'suspended');
  assert.equal(f('incomplete_expired'), 'suspended');
  assert.equal(f('statut_inconnu'), null, 'un statut inconnu ne doit rien changer');
});

test('checkout complété : le club passe actif, au palier réellement souscrit', async () => {
  const state = freshState();
  const mock = installMock(state, {
    stripeResponses: {
      '/v1/subscriptions/': { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_reseau_456' } }] } },
    },
  });
  try {
    const res = fakeRes();
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', metadata: { club_id: CLUB_ID, plan: 'pro' }, customer: 'cus_1', subscription: 'sub_1' } },
    });
    await webhookHandler(webhookReq(body), res);
    assert.equal(res.statusCode, 200);
    const club = state.clubs[0];
    assert.equal(club.status, 'active');
    // 'reseau' et non 'pro' : c'est l'abonnement réel qui fait foi, pas le
    // palier demandé au départ (l'utilisateur a pu en changer dans Checkout).
    assert.equal(club.plan, 'reseau');
    assert.equal(club.stripe_customer_id, 'cus_1');
    assert.equal(club.stripe_subscription_id, 'sub_1');
    assert.equal(club.trial_ends_at, null, 'l\'essai n\'a plus lieu d\'être');
  } finally { mock.restore(); }
});

test('abonnement résilié : club suspendu ET retombé au palier d\'entrée', async () => {
  const state = freshState();
  state.clubs[0].status = 'active';
  state.clubs[0].plan = 'pro';
  const mock = installMock(state);
  try {
    const res = fakeRes();
    const body = JSON.stringify({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', status: 'canceled', customer: 'cus_1', metadata: { club_id: CLUB_ID }, items: { data: [{ price: { id: 'price_pro_123' } }] } } },
    });
    await webhookHandler(webhookReq(body), res);
    assert.equal(res.statusCode, 200);
    assert.equal(state.clubs[0].status, 'suspended');
    assert.equal(state.clubs[0].plan, 'essentiel', 'un abonnement résilié ne laisse pas un palier payant en base');
  } finally { mock.restore(); }
});

test('changement de palier depuis le portail Stripe : reflété en base', async () => {
  const state = freshState();
  state.clubs[0].status = 'active';
  state.clubs[0].plan = 'pro';
  const mock = installMock(state);
  try {
    const res = fakeRes();
    const body = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { club_id: CLUB_ID }, items: { data: [{ price: { id: 'price_reseau_456' } }] } } },
    });
    await webhookHandler(webhookReq(body), res);
    assert.equal(state.clubs[0].plan, 'reseau');
    assert.equal(state.clubs[0].status, 'active');
  } finally { mock.restore(); }
});

test('club retrouvé par son customer Stripe quand la métadonnée manque', async () => {
  const state = freshState();
  state.clubs[0].stripe_customer_id = 'cus_1';
  const mock = installMock(state);
  try {
    const id = await webhookInternals.resolveClubId({ customer: 'cus_1' });
    assert.equal(id, CLUB_ID);
  } finally { mock.restore(); }
});

test('colonnes Stripe absentes (migration non appliquée) : status et plan sont écrits quand même', async () => {
  const state = freshState();
  delete state.clubs[0].stripe_customer_id;
  delete state.clubs[0].stripe_subscription_id;
  const mock = installMock(state, {
    stripeResponses: { '/v1/subscriptions/': { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_pro_123' } }] } } },
  });
  try {
    const res = fakeRes();
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', metadata: { club_id: CLUB_ID, plan: 'pro' }, customer: 'cus_1', subscription: 'sub_1' } },
    });
    await webhookHandler(webhookReq(body), res);
    assert.equal(res.statusCode, 200);
    assert.equal(state.clubs[0].status, 'active', 'le club payé est activé même sans les colonnes Stripe');
    assert.equal(state.clubs[0].plan, 'pro');
  } finally { mock.restore(); }
});

test('événement non géré : acquitté en 200 (sinon Stripe réessaie indéfiniment)', async () => {
  const state = freshState();
  const mock = installMock(state);
  try {
    const res = fakeRes();
    await webhookHandler(webhookReq(JSON.stringify({ type: 'invoice.paid', data: { object: {} } })), res);
    assert.equal(res.statusCode, 200);
    assert.equal(state.clubs[0].status, 'trial');
  } finally { mock.restore(); }
});

// ════════════════════════════════════════════════════════════════════════
// Checkout — les deux modes d'authentification
// ════════════════════════════════════════════════════════════════════════

test('checkout avec session admin : session Stripe créée pour le bon club', async () => {
  const state = freshState();
  const mock = installMock(state);
  try {
    const res = fakeRes();
    await checkoutHandler(fakeReq({ token: validToken(), body: { plan: 'pro' } }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.url.startsWith('https://checkout.stripe.com/'));
    const call = mock.stripeCalls.find(c => c.path === '/v1/checkout/sessions');
    assert.equal(call.body['metadata[club_id]'], CLUB_ID);
    assert.equal(call.body['subscription_data[metadata][club_id]'], CLUB_ID,
      'la métadonnée doit aussi être posée sur l\'abonnement : les événements customer.subscription.* ne portent pas celles de la session');
    assert.equal(call.body['line_items[0][price]'], 'price_pro_123');
    assert.equal(call.body.mode, 'subscription');
  } finally { mock.restore(); }
});

test('checkout : le client Stripe existant est réutilisé, pas dupliqué', async () => {
  const state = freshState();
  state.clubs[0].stripe_customer_id = 'cus_existant';
  const mock = installMock(state);
  try {
    await checkoutHandler(fakeReq({ token: validToken(), body: { plan: 'pro' } }), fakeRes());
    const call = mock.stripeCalls.find(c => c.path === '/v1/checkout/sessions');
    assert.equal(call.body.customer, 'cus_existant');
    assert.equal(call.body.customer_email, undefined);
  } finally { mock.restore(); }
});

test('checkout : palier sans prix configuré refusé', async () => {
  const state = freshState();
  const mock = installMock(state);
  try {
    const res = fakeRes();
    await checkoutHandler(fakeReq({ token: validToken(), body: { plan: 'essentiel' } }), res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body.available.sort(), ['pro', 'reseau']);
  } finally { mock.restore(); }
});

test('club suspendu : peut payer avec email + mot de passe, sans session', async () => {
  const state = freshState();
  state.clubs[0].status = 'suspended';
  const mock = installMock(state);
  try {
    const res = fakeRes();
    await checkoutHandler(fakeReq({ body: { plan: 'pro', email: 'admin@test.fr', password: PASSWORD } }), res);
    assert.equal(res.statusCode, 200, 'sans ce chemin, un essai expiré serait un cul-de-sac définitif');
    const call = mock.stripeCalls.find(c => c.path === '/v1/checkout/sessions');
    assert.equal(call.body['metadata[club_id]'], CLUB_ID);
  } finally { mock.restore(); }
});

test('club suspendu : mauvais mot de passe refusé, message identique à un email inconnu', async () => {
  const state = freshState();
  state.clubs[0].status = 'suspended';
  const mock = installMock(state);
  try {
    const bad = fakeRes();
    await checkoutHandler(fakeReq({ body: { plan: 'pro', email: 'admin@test.fr', password: 'faux' } }), bad);
    const unknown = fakeRes();
    await checkoutHandler(fakeReq({ body: { plan: 'pro', email: 'inconnu@test.fr', password: PASSWORD } }), unknown);
    assert.equal(bad.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.equal(bad.body.error, unknown.body.error, 'ne jamais révéler quels comptes existent');
    assert.equal(mock.stripeCalls.length, 0, 'aucune session de paiement ouverte');
  } finally { mock.restore(); }
});

test('checkout sans aucune authentification : 401', async () => {
  const state = freshState();
  const mock = installMock(state);
  try {
    const res = fakeRes();
    await checkoutHandler(fakeReq({ body: { plan: 'pro' } }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(mock.stripeCalls.length, 0);
  } finally { mock.restore(); }
});

// ════════════════════════════════════════════════════════════════════════
// Portail de facturation
// ════════════════════════════════════════════════════════════════════════

test('portail : refusé sans session admin', async () => {
  const state = freshState();
  const mock = installMock(state);
  try {
    const res = fakeRes();
    await portalHandler(fakeReq({ body: {} }), res);
    assert.equal(res.statusCode, 401);
  } finally { mock.restore(); }
});

test('portail : club sans abonnement → 404 explicite, orienté vers le paiement', async () => {
  const state = freshState();
  const mock = installMock(state);
  try {
    const res = fakeRes();
    await portalHandler(fakeReq({ token: validToken(), body: {} }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.needsCheckout, true);
  } finally { mock.restore(); }
});

test('portail : club abonné → URL de gestion Stripe', async () => {
  const state = freshState();
  state.clubs[0].stripe_customer_id = 'cus_1';
  const mock = installMock(state, {
    stripeResponses: { '/v1/billing_portal/sessions': { url: 'https://billing.stripe.com/session/xyz' } },
  });
  try {
    const res = fakeRes();
    await portalHandler(fakeReq({ token: validToken(), body: {} }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.url, 'https://billing.stripe.com/session/xyz');
    const call = mock.stripeCalls.find(c => c.path === '/v1/billing_portal/sessions');
    assert.equal(call.body.customer, 'cus_1');
  } finally { mock.restore(); }
});
