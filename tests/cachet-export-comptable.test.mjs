// ════════════════════════════════════════════════════════════════════════
// Tests — chantier "cachet + export comptable" (2026-08)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Couvre :
//  1. resolvePaymentMode() — fonction pure, api/_lib.js.
//  2. api/admin-write.js, nouvelles actions saveChapeauEntry/
//     getChapeauEntries/deleteChapeauEntry : scoping club_id, gate Pro
//     (requireProAccess), isolation entre deux clubs.
//  3. api/admin-write.js, action 'sync' étendue : cachet_amount sur
//     comedians — inclus pour un club Pro, retiré (jamais écrasé à null)
//     pour un club non-Pro, clearing (null explicite) jamais bloqué.
//  4. api/admin-write.js, action 'updateClub' étendue : payment_mode
//     ('chapeau'/'cachet' uniquement, repli best-effort si colonne absente).
//  5. api/switch-club.js : payment_mode relayé dans la réponse `club`, avec
//     repli 'chapeau' si la colonne manque (même relais existe dans
//     api/admin-login.js et api/club-signup.js, non re-testé ici pour éviter
//     la redite — le code est strictement le même schéma try/catch que
//     dispo_deadline_day/plan, déjà couvert par tests/plan-gating.test.mjs).
//
// Même méthode que tests/multitenant-scoping.test.mjs et
// tests/plan-gating.test.mjs : exécute le VRAI code des handlers, `fetch`
// global mocké pour enregistrer les appels Supabase sortants (jamais de
// vrai réseau/credential).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken, resolvePaymentMode } = await import('../api/_lib.js');
const adminWriteHandler = (await import('../api/admin-write.js')).default;
const switchClubHandler = (await import('../api/switch-club.js')).default;

const PRO_CLUB_ID = '22222222-2222-4222-a222-222222222222';
const ESSENTIEL_CLUB_ID = '33333333-3333-4333-a333-333333333333';
const TRIAL_CLUB_ID = '44444444-4444-4444-a444-444444444444';

const CLUBS_BY_ID = {
  [PRO_CLUB_ID]: { id: PRO_CLUB_ID, status: 'active', plan: 'pro', name: 'Club Pro' },
  [ESSENTIEL_CLUB_ID]: { id: ESSENTIEL_CLUB_ID, status: 'active', plan: 'essentiel', name: 'Club Essentiel' },
  [TRIAL_CLUB_ID]: { id: TRIAL_CLUB_ID, status: 'trial', plan: 'essentiel', name: 'Club En Essai' },
};

function installFetchMock(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const canned = responder ? responder(call) : undefined;
    return { ok: true, status: 200, json: async () => (canned !== undefined ? canned : []), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Répond aux GET /clubs?id=eq.<id> (utilisé par requireProAccess() ET par
// admin-login.js/switch-club.js) avec la ligne club correspondante.
function clubAwareResponder(extra) {
  return (call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      const m = call.url.match(/id=eq\.([^&]+)/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        return CLUBS_BY_ID[id] ? [CLUBS_BY_ID[id]] : [];
      }
    }
    return extra ? extra(call) : undefined;
  };
}

function fakeReq({ token, body } = {}) {
  return { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body };
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
function tokenForClub(clubId) {
  return issueAdminToken(`admin-${clubId}`, [{ id: clubId, name: 'Club' }], clubId).token;
}

// ════════════════════════════════════════════════════════════════════════
// resolvePaymentMode() — fonction pure, api/_lib.js
// ════════════════════════════════════════════════════════════════════════

test('resolvePaymentMode : club sans payment_mode (colonne absente) -> repli "chapeau"', () => {
  assert.equal(resolvePaymentMode({ id: 'x' }), 'chapeau');
  assert.equal(resolvePaymentMode(null), 'chapeau');
});

test('resolvePaymentMode : "cachet" explicite -> "cachet"', () => {
  assert.equal(resolvePaymentMode({ payment_mode: 'cachet' }), 'cachet');
});

test('resolvePaymentMode : "chapeau" explicite -> "chapeau"', () => {
  assert.equal(resolvePaymentMode({ payment_mode: 'chapeau' }), 'chapeau');
});

test('resolvePaymentMode : valeur inattendue -> repli sûr "chapeau", jamais un crash ni une valeur arbitraire', () => {
  assert.equal(resolvePaymentMode({ payment_mode: 'tournee' }), 'chapeau');
  assert.equal(resolvePaymentMode({ payment_mode: 42 }), 'chapeau');
});

// ════════════════════════════════════════════════════════════════════════
// saveChapeauEntry / getChapeauEntries / deleteChapeauEntry
// ════════════════════════════════════════════════════════════════════════

test('saveChapeauEntry : club Pro -> upsert scopé club_id, on_conflict=club_id,slot_key', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'saveChapeauEntry', payload: {
    slot_key: '2026-08-11-20h15', amount_especes: 100, amount_cb: 50,
  } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const post = mock.calls.find(c => c.url.includes('/chapeau_entries') && c.method === 'POST');
  assert.ok(post, 'un POST chapeau_entries doit avoir eu lieu');
  assert.ok(post.url.includes('on_conflict=club_id%2Cslot_key') || post.url.includes('on_conflict=club_id,slot_key'));
  assert.equal(post.body[0].club_id, PRO_CLUB_ID);
  assert.equal(post.body[0].slot_key, '2026-08-11-20h15');
  assert.equal(post.body[0].amount_total, 150);
});

test('saveChapeauEntry : club essentiel actif -> 403, aucun POST chapeau_entries déclenché', async () => {
  const token = tokenForClub(ESSENTIEL_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'saveChapeauEntry', payload: {
    slot_key: '2026-08-11-20h15', amount_especes: 100, amount_cb: 0,
  } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 403);
  assert.ok(!mock.calls.some(c => c.url.includes('/chapeau_entries')), 'aucune écriture chapeau_entries pour un club non-Pro');
});

test('saveChapeauEntry : club en essai (trial, plan essentiel) -> autorisé (essai = accès complet)', async () => {
  const token = tokenForClub(TRIAL_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'saveChapeauEntry', payload: {
    slot_key: '2026-08-11-20h15', amount_especes: 10, amount_cb: 0,
  } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  assert.ok(mock.calls.some(c => c.url.includes('/chapeau_entries') && c.method === 'POST'));
});

test('saveChapeauEntry : slot_key invalide -> 400, aucun appel Supabase d\'écriture', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'saveChapeauEntry', payload: {
    slot_key: 'pas-un-slot-key', amount_especes: 100, amount_cb: 0,
  } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 400);
  assert.ok(!mock.calls.some(c => c.url.includes('/chapeau_entries')));
});

test('saveChapeauEntry : montant nul (especes=cb=0, pas de repli) -> 400', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'saveChapeauEntry', payload: {
    slot_key: '2026-08-11-20h15', amount_especes: 0, amount_cb: 0,
  } } }), res);
  mock.restore();
  assert.equal(res.statusCode, 400);
});

test('getChapeauEntries : club Pro -> lecture scopée club_id, jamais un autre club', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder((call) => {
    if (call.url.includes('/chapeau_entries')) return [{ id: 'e1', slot_key: '2026-08-11-20h15', amount_especes: 10, amount_cb: 5, amount_total: 15, created_at: '2026-08-11T00:00:00Z' }];
    return undefined;
  }));
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'getChapeauEntries', payload: {} } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.entries.length, 1);
  const get = mock.calls.find(c => c.url.includes('/chapeau_entries') && c.method === 'GET');
  assert.ok(get.url.includes(encodeURIComponent(PRO_CLUB_ID)));
});

test('getChapeauEntries : club essentiel actif -> 403', async () => {
  const token = tokenForClub(ESSENTIEL_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'getChapeauEntries', payload: {} } }), res);
  mock.restore();
  assert.equal(res.statusCode, 403);
});

test('deleteChapeauEntry : club Pro -> DELETE scopé club_id + slot_key', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'deleteChapeauEntry', payload: { slot_key: '2026-08-11-20h15' } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  const del = mock.calls.find(c => c.url.includes('/chapeau_entries') && c.method === 'DELETE');
  assert.ok(del);
  assert.ok(del.url.includes('slot_key=eq.'));
  assert.ok(del.url.includes(encodeURIComponent(PRO_CLUB_ID)));
});

test('deleteChapeauEntry : club essentiel actif -> 403, aucun DELETE déclenché', async () => {
  const token = tokenForClub(ESSENTIEL_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'deleteChapeauEntry', payload: { slot_key: '2026-08-11-20h15' } } }), res);
  mock.restore();
  assert.equal(res.statusCode, 403);
  assert.ok(!mock.calls.some(c => c.url.includes('/chapeau_entries')));
});

test('isolation croisée : le token du club Pro ne référence jamais le club essentiel (ni l\'inverse) dans les appels chapeau_entries', async () => {
  const tokenPro = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  await adminWriteHandler(fakeReq({ token: tokenPro, body: { action: 'getChapeauEntries', payload: {} } }), fakeRes());
  mock.restore();
  for (const c of mock.calls) {
    if (!c.url.includes('/chapeau_entries')) continue;
    assert.ok(!c.url.includes(encodeURIComponent(ESSENTIEL_CLUB_ID)), `fuite vers club essentiel détectée : ${c.url}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// sync : cachet_amount sur comedians
// ════════════════════════════════════════════════════════════════════════

test('sync comedians : club Pro règle un cachet -> cachet_amount présent dans le POST', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'sync', payload: {
    comedians: [{ id: 'c1', name: 'Test', cachet_amount: 25.5 }],
  } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  const post = mock.calls.find(c => c.url.includes('/comedians') && c.method === 'POST');
  assert.equal(post.body[0].cachet_amount, 25.5);
  // Le gate Pro doit avoir été vérifié (GET /clubs) puisqu'une valeur non-nulle était proposée.
  assert.ok(mock.calls.some(c => c.url.includes('/clubs') && c.method === 'GET'));
});

test('sync comedians : club essentiel tente de régler un cachet -> valeur retirée (jamais écrasée à null), reste non écrite en base', async () => {
  const token = tokenForClub(ESSENTIEL_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'sync', payload: {
    comedians: [{ id: 'c1', name: 'Test', cachet_amount: 25.5 }],
  } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200); // le sync réussit quand même (comedians a d'autres champs légitimes)
  const post = mock.calls.find(c => c.url.includes('/comedians') && c.method === 'POST');
  assert.ok(!('cachet_amount' in post.body[0]), 'cachet_amount ne doit même pas apparaître dans la ligne envoyée à Supabase pour un club non-Pro');
});

test('sync comedians : effacer un cachet (cachet_amount: null) n\'est JAMAIS gaté, même pour un club essentiel', async () => {
  const token = tokenForClub(ESSENTIEL_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'sync', payload: {
    comedians: [{ id: 'c1', name: 'Test', cachet_amount: null }],
  } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  const post = mock.calls.find(c => c.url.includes('/comedians') && c.method === 'POST');
  assert.equal(post.body[0].cachet_amount, null);
  // Effacer ne coûte jamais l'aller-retour requireProAccess() (optimisation
  // du chemin commun) — aucun GET /clubs déclenché ici.
  assert.ok(!mock.calls.some(c => c.url.includes('/clubs') && c.method === 'GET'));
});

test('sync comedians : club Pro sans cachet_amount dans le payload -> ligne écrite sans la clé (colonne non touchée), aucun gate déclenché', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'sync', payload: {
    comedians: [{ id: 'c1', name: 'Test' }],
  } } }), res);
  mock.restore();

  const post = mock.calls.find(c => c.url.includes('/comedians') && c.method === 'POST');
  assert.ok(!('cachet_amount' in post.body[0]));
  assert.ok(!mock.calls.some(c => c.url.includes('/clubs') && c.method === 'GET'));
});

test('sync comedians : cachet_amount négatif -> traité comme absent (invalide), jamais écrit', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'sync', payload: {
    comedians: [{ id: 'c1', name: 'Test', cachet_amount: -5 }],
  } } }), res);
  mock.restore();
  const post = mock.calls.find(c => c.url.includes('/comedians') && c.method === 'POST');
  assert.ok(!('cachet_amount' in post.body[0]));
});

// ════════════════════════════════════════════════════════════════════════
// updateClub : payment_mode
// ════════════════════════════════════════════════════════════════════════

test('updateClub : payment_mode="cachet" valide -> PATCH clubs avec payment_mode, renvoyé dans la réponse', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'updateClub', payload: { name: 'Club Pro', city: 'Lille', payment_mode: 'cachet' } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  const patch = mock.calls.find(c => c.url.includes('/clubs') && c.method === 'PATCH');
  assert.equal(patch.body.payment_mode, 'cachet');
  assert.equal(res.body.club.payment_mode, 'cachet');
});

test('updateClub : payment_mode invalide -> 400, aucun PATCH', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  const mock = installFetchMock(clubAwareResponder());
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'updateClub', payload: { name: 'Club Pro', payment_mode: 'tournee' } } }), res);
  mock.restore();

  assert.equal(res.statusCode, 400);
  assert.ok(!mock.calls.some(c => c.method === 'PATCH'));
});

test('updateClub : colonne payment_mode absente (PATCH combiné échoue) -> repli, name/city quand même sauvés', async () => {
  const token = tokenForClub(PRO_CLUB_ID);
  // installFetchMock() (le petit harnais utilisé partout ailleurs dans ce
  // fichier) ne sait pas simuler un échec HTTP (son responder ne peut que
  // fournir un body 200) — on route donc ce test via un mock fetch dédié qui
  // renvoie un vrai statut 400 pour le PATCH combiné (dispo_deadline_day +
  // payment_mode), comme le ferait réellement PostgREST si une colonne
  // n'existe pas encore sur cet environnement.
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    if (call.url.includes('/clubs') && call.method === 'PATCH') {
      if (call.body && 'payment_mode' in call.body && 'dispo_deadline_day' in call.body) {
        return { ok: false, status: 400, text: async () => 'column clubs.payment_mode does not exist' };
      }
      return { ok: true, status: 200, json: async () => true, text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };

  const res = fakeRes();
  await adminWriteHandler(fakeReq({ token, body: { action: 'updateClub', payload: { name: 'Club Pro', city: 'Lille', dispo_deadline_day: 15, payment_mode: 'cachet' } } }), res);
  globalThis.fetch = original;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  // Le nom/ville doivent être sauvés malgré l'échec des colonnes optionnelles.
  const patches = calls.filter(c => c.url.includes('/clubs') && c.method === 'PATCH');
  assert.ok(patches.length >= 2, 'doit avoir retenté colonne par colonne après l\'échec combiné');
  assert.ok(patches.every(p => p.body.name === 'Club Pro'));
});

// ════════════════════════════════════════════════════════════════════════
// admin-login / switch-club : payment_mode relayé dans `club`
// ════════════════════════════════════════════════════════════════════════

const ADMIN_ID = 'admin-payment-mode-test';

test('switch-club : club en mode "cachet" -> payment_mode relayé tel quel dans la réponse', async () => {
  const club = { id: PRO_CLUB_ID, status: 'active', plan: 'pro', name: 'Club Pro', city: 'Lille', portal_code: 'PRO01', payment_mode: 'cachet' };
  const token = issueAdminToken(ADMIN_ID, [{ id: PRO_CLUB_ID, name: 'Club Pro' }], PRO_CLUB_ID).token;
  const mock = installFetchMock((call) => {
    if (call.url.includes('/admin_club_links')) return [{ club_id: PRO_CLUB_ID }];
    if (call.url.includes('/clubs')) return [club];
    return [];
  });
  const res = fakeRes();
  await switchClubHandler(fakeReq({ token, body: { club_id: PRO_CLUB_ID } }), res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.payment_mode, 'cachet');
});

test('switch-club : colonne payment_mode absente en base -> repli "chapeau", switch jamais bloqué', async () => {
  const token = issueAdminToken(ADMIN_ID, [{ id: PRO_CLUB_ID, name: 'Club Pro' }], PRO_CLUB_ID).token;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/admin_club_links')) return { ok: true, json: async () => [{ club_id: PRO_CLUB_ID }] };
    if (url.includes('/clubs')) {
      if (url.includes('payment_mode')) return { ok: false, status: 400, text: async () => 'column clubs.payment_mode does not exist' };
      return { ok: true, json: async () => [{ id: PRO_CLUB_ID, status: 'active', plan: 'pro', name: 'Club Pro', city: 'Lille', portal_code: 'PRO01' }] };
    }
    return { ok: true, json: async () => [] };
  };
  const res = fakeRes();
  await switchClubHandler(fakeReq({ token, body: { club_id: PRO_CLUB_ID } }), res);
  globalThis.fetch = original;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.payment_mode, 'chapeau', 'repli sûr — jamais un crash ni une valeur inventée si la colonne manque');
});

console.log('\nTests "cachet + export comptable" terminés — voir le résumé du test runner ci-dessus (node --test).');
