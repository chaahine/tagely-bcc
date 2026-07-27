// ════════════════════════════════════════════════════════════════════════
// Tests — chantier multitenant, étapes B + C (scoping serveur, bascule DB)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/multitenant-scoping.test.mjs
// (Node >= 18, test runner intégré — aucune dépendance ajoutée au projet.)
//
// Mis à jour pour l'étape C (branche multitenant/step-c) : le repli legacy
// "club_id IS NULL" (fenêtre entre le scoping serveur de l'étape B et le
// backfill réel de l'étape C) a été retiré de clubOrFilter(), et
// admin-login.js / portal-write.js lisent désormais réellement la table
// `clubs` au lieu des constantes en dur BCC_CLUB_ID / BCC_PORTAL_CODE. Les
// tests ci-dessous couvrent ce nouveau chemin ; des tests complémentaires
// (isolation entre deux vrais clubs post-migration) sont dans
// tests/multitenant-step-c.test.mjs.
//
// Honnêteté sur ce qui est testé :
//  - _lib.js (issueAdminToken/verifyAdminToken/clubOrFilter) est testé en
//    exécutant le VRAI code, sans mock — ce sont des fonctions pures/crypto,
//    aucun réseau impliqué.
//  - api/admin-write.js, api/admin-login.js, api/portal-write.js sont testés
//    en exécutant le VRAI code des handlers (le vrai fichier de prod, importé
//    tel quel), mais avec `fetch` global remplacé par un mock qui enregistre
//    chaque requête HTTP sortante vers Supabase (URL, méthode, params, body)
//    au lieu de réellement toucher la base. Aucun credential Supabase n'est
//    utilisé ni nécessaire ici.
//  - Ce qui N'EST PAS testé ici, faute d'accès à un vrai Supabase : que les
//    requêtes scopées produisent bien l'effet attendu une fois exécutées côté
//    serveur Postgres réel. La vérification en conditions réelles reste à
//    faire à la main après déploiement (section "Vérifications" du plan).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.ADMIN_PWD_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'; // sha256('test')
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const {
  issueAdminToken,
  verifyAdminToken,
  clubOrFilter,
  BCC_CLUB_ID,
} = await import('../api/_lib.js');

const OTHER_CLUB_ID = '11111111-1111-4111-a111-111111111111'; // club B fictif, jamais réel

// ── Petit harnais de mock fetch : enregistre chaque appel Supabase sortant ──
function installFetchMock(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url,
      method: opts.method || 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    };
    calls.push(call);
    const canned = responder ? responder(call) : undefined;
    return {
      ok: true,
      status: 200,
      json: async () => (canned !== undefined ? canned : []),
      text: async () => '',
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function fakeReq({ token, body }) {
  return {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
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

// ════════════════════════════════════════════════════════════════════════
// _lib.js — token et filtre de scoping (code réel, pas de mock)
// ════════════════════════════════════════════════════════════════════════

test('issueAdminToken embarque club_id, verifyAdminToken le restitue', () => {
  const { token } = issueAdminToken(OTHER_CLUB_ID);
  const claims = verifyAdminToken(fakeReq({ token }));
  assert.ok(claims);
  assert.equal(claims.role, 'admin');
  assert.equal(claims.club_id, OTHER_CLUB_ID);
});

test('verifyAdminToken rejette une signature falsifiée', () => {
  const { token } = issueAdminToken(BCC_CLUB_ID);
  const [payload] = token.split('.');
  const tampered = `${payload}.0000000000000000000000000000000000000000000000000000000000000000`;
  assert.equal(verifyAdminToken(fakeReq({ token: tampered })), null);
});

test('verifyAdminToken rejette un token dont le club_id a été modifié dans le payload (signature ne matche plus)', () => {
  const { token } = issueAdminToken(OTHER_CLUB_ID);
  const [payload, sig] = token.split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  data.club_id = BCC_CLUB_ID; // tentative d'usurpation du club
  const forgedPayload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const forged = `${forgedPayload}.${sig}`; // ancienne signature, payload modifié
  assert.equal(verifyAdminToken(fakeReq({ token: forged })), null);
});

test('verifyAdminToken rejette un token expiré', () => {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  const payload = Buffer.from(JSON.stringify({ role: 'admin', club_id: BCC_CLUB_ID, exp: Date.now() - 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal(verifyAdminToken(fakeReq({ token: `${payload}.${sig}` })), null);
});

test('clubOrFilter : le BCC ne matche plus que son propre club_id (repli IS NULL retiré depuis le backfill étape C)', () => {
  const f = clubOrFilter(BCC_CLUB_ID);
  assert.equal(f, `club_id=eq.${encodeURIComponent(BCC_CLUB_ID)}`);
  assert.ok(!f.includes('is.null'));
});

test('clubOrFilter : un vrai 2e club ne matche QUE son propre club_id', () => {
  const f = clubOrFilter(OTHER_CLUB_ID);
  assert.equal(f, `club_id=eq.${encodeURIComponent(OTHER_CLUB_ID)}`);
  assert.ok(!f.includes('is.null'));
});

// ════════════════════════════════════════════════════════════════════════
// admin-login.js — étape C : lecture réelle de clubs.admin_pwd_hash
// ════════════════════════════════════════════════════════════════════════
// Tests détaillés du nouveau flux DB dans tests/multitenant-step-c.test.mjs.
// Ceux-ci vérifient juste que le chemin nominal continue de fonctionner une
// fois la ligne `clubs` du BCC présente en base (mockée ici).

const adminLoginHandler = (await import('../api/admin-login.js')).default;
const BCC_ADMIN_PWD_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'; // sha256('test')

function mockClubsLookup(overrides = {}) {
  return installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      return [{ id: BCC_CLUB_ID, status: 'active', admin_pwd_hash: BCC_ADMIN_PWD_HASH, ...overrides }];
    }
    return [];
  });
}

test('admin-login : mot de passe correct → token portant l\'id réel du club lu en base', async () => {
  const mock = mockClubsLookup();
  const req = fakeReq({ body: { password: 'test' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  const claims = verifyAdminToken(fakeReq({ token: res.body.token }));
  assert.equal(claims.club_id, BCC_CLUB_ID);
});

test('admin-login : mauvais mot de passe → 401, pas de token émis', async () => {
  const mock = mockClubsLookup();
  const req = fakeReq({ body: { password: 'mauvais' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
});

test('admin-login : club absent de la table clubs (migration étape C pas exécutée) → 500 explicite, pas de repli silencieux', async () => {
  const mock = installFetchMock(() => []); // aucune ligne clubs
  const req = fakeReq({ body: { password: 'test' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 500);
  assert.ok(res.body.token === undefined);
});

test('admin-login : club suspendu → 403, même avec le bon mot de passe', async () => {
  const mock = mockClubsLookup({ status: 'suspended' });
  const req = fakeReq({ body: { password: 'test' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
});

// ════════════════════════════════════════════════════════════════════════
// admin-write.js — isolation entre clubs (handler réel, Supabase mocké)
// ════════════════════════════════════════════════════════════════════════

const adminWriteHandler = (await import('../api/admin-write.js')).default;

test('sync: le DELETE assignments est scopé au club du token (plus de wipe global ?id=gte.0)', async () => {
  const { token } = issueAdminToken(OTHER_CLUB_ID);
  const mock = installFetchMock();
  const req = fakeReq({ token, body: { action: 'sync', payload: { assignments: [] } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  const del = mock.calls.find(c => c.method === 'DELETE' && c.url.includes('/assignments'));
  assert.ok(del, 'un DELETE assignments doit avoir eu lieu');
  assert.ok(!del.url.includes('id=gte.0'), 'ne doit plus jamais utiliser le filtre non scopé id=gte.0');
  assert.ok(del.url.includes(encodeURIComponent(OTHER_CLUB_ID)), 'le DELETE doit référencer le club_id du token');
});

test('sync: les lignes insérées (comedians/assignments/dispos/dispoStatus) portent toutes club_id', async () => {
  const { token } = issueAdminToken(OTHER_CLUB_ID);
  const mock = installFetchMock();
  const req = fakeReq({ token, body: { action: 'sync', payload: {
    comedians: [{ id: 'c1', name: 'Test' }],
    assignments: [{ comedian_id: 'c1', slot_key: '2026-08-11-20h15' }],
    dispoStatus: [{ comedian_id: 'c1' }],
    dispos: [{ comedian_id: 'c1', slot_key: '2026-08-11-20h15', dispo: true }],
  } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  const posts = mock.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 4);
  for (const p of posts) {
    for (const row of p.body) {
      assert.equal(row.club_id, OTHER_CLUB_ID, `ligne sans club_id correct dans ${p.url}`);
    }
  }
});

test('clearAll: les 4 DELETE sont tous scopés au club du token', async () => {
  const { token } = issueAdminToken(OTHER_CLUB_ID);
  const mock = installFetchMock();
  const req = fakeReq({ token, body: { action: 'clearAll', payload: {} } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  const deletes = mock.calls.filter(c => c.method === 'DELETE');
  assert.equal(deletes.length, 4, 'assignments, dispos, dispo_status, comedians');
  for (const d of deletes) {
    assert.ok(
      d.url.includes(encodeURIComponent(OTHER_CLUB_ID)) || d.url.includes('is.null') === false,
      `DELETE non scopé détecté : ${d.url}`
    );
    // Aucun DELETE ne doit être un wipe sans clause club (ex: ?comedian_id=neq.null seul)
    assert.ok(!/\?comedian_id=neq\.null$/.test(d.url) && !/\?id=neq\.null$/.test(d.url),
      `DELETE avec l'ancien filtre bidon non scopé détecté : ${d.url}`);
  }
});

test('isolation croisée : clearAll du club A ne référence jamais le club B, et inversement', async () => {
  const tokenA = issueAdminToken(BCC_CLUB_ID).token;
  const tokenB = issueAdminToken(OTHER_CLUB_ID).token;

  const mockA = installFetchMock();
  await adminWriteHandler(fakeReq({ token: tokenA, body: { action: 'clearAll', payload: {} } }), fakeRes());
  mockA.restore();
  for (const c of mockA.calls) {
    assert.ok(!c.url.includes(encodeURIComponent(OTHER_CLUB_ID)), `fuite vers club B détectée dans un appel scopé club A : ${c.url}`);
  }

  const mockB = installFetchMock();
  await adminWriteHandler(fakeReq({ token: tokenB, body: { action: 'clearAll', payload: {} } }), fakeRes());
  mockB.restore();
  for (const c of mockB.calls) {
    assert.ok(!c.url.includes(encodeURIComponent(BCC_CLUB_ID)) || c.url.includes('is.null'),
      `fuite vers club BCC détectée dans un appel scopé club B : ${c.url}`);
    // Le club B (non-BCC) ne doit jamais bénéficier du repli is.null
    if (c.method === 'DELETE') assert.ok(!c.url.includes('is.null'), `club B ne doit pas matcher les lignes NULL : ${c.url}`);
  }
});

test('deleteComedian: les 4 DELETE sont scopés club_id, pas seulement par id', async () => {
  const { token } = issueAdminToken(OTHER_CLUB_ID);
  const mock = installFetchMock();
  const req = fakeReq({ token, body: { action: 'deleteComedian', payload: { id: 'c1' } } });
  await adminWriteHandler(req, fakeRes());
  mock.restore();

  const deletes = mock.calls.filter(c => c.method === 'DELETE');
  assert.equal(deletes.length, 4);
  for (const d of deletes) {
    assert.ok(d.url.includes('id=eq.c1') || d.url.includes('comedian_id=eq.c1'));
    assert.ok(d.url.includes(encodeURIComponent(OTHER_CLUB_ID)), `deleteComedian non scopé club : ${d.url}`);
  }
});

test('chatSend: le message inséré porte le club_id du token', async () => {
  const { token } = issueAdminToken(OTHER_CLUB_ID);
  const mock = installFetchMock();
  const req = fakeReq({ token, body: { action: 'chatSend', payload: { text: 'hello' } } });
  await adminWriteHandler(req, fakeRes());
  mock.restore();

  const post = mock.calls.find(c => c.url.includes('/chat_messages'));
  assert.equal(post.body.club_id, OTHER_CLUB_ID);
});

test('sans token → 401, aucun appel Supabase déclenché', async () => {
  const mock = installFetchMock();
  const res = fakeRes();
  await adminWriteHandler(fakeReq({ body: { action: 'clearAll', payload: {} } }), res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(mock.calls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// portal-write.js — résolution code → club (étape C : lecture clubs.portal_code)
// ════════════════════════════════════════════════════════════════════════
// resolveClubId() interroge désormais réellement la table `clubs` (au lieu du
// mapping en dur BCC_PORTAL_CODE='BCCD25' → BCC_CLUB_ID de l'étape B). Chaque
// test qui passe par une action portail doit donc aussi répondre à ce GET
// /clubs?portal_code=eq...; withClubsMock() le fait en plus du responder
// spécifique à l'action testée.

const portalWriteHandler = (await import('../api/portal-write.js')).default;

function withClubsMock(extra) {
  return installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      // Seul le code BCCD25 est un portal_code connu dans ces tests.
      return call.url.includes('portal_code=eq.BCCD25')
        ? [{ id: BCC_CLUB_ID, status: 'active' }]
        : [];
    }
    return extra ? extra(call) : [];
  });
}

test('code inconnu → 403, aucun appel d\'écriture déclenché', async () => {
  const mock = withClubsMock();
  const req = fakeReq({ body: { action: 'ensureComedian', payload: { code: 'NIMPORTEQUOI', newComedian: { name: 'X', email: 'x@x.fr', phone: '0600000000' } } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
  assert.equal(mock.calls.filter(c => c.method !== 'GET' || !c.url.includes('/clubs')).length, 0,
    'aucune écriture ni lecture comedians/dispos ne doit être tentée sans club résolu');
});

test('club suspendu → 403 (même logique que "code inconnu", club_id existant mais status suspended)', async () => {
  const mock = installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') return [{ id: BCC_CLUB_ID, status: 'suspended' }];
    return [];
  });
  const req = fakeReq({ body: { action: 'ensureComedian', payload: { code: 'BCCD25', newComedian: { name: 'X', email: 'x@x.fr', phone: '0600000000' } } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
});

test('code BCCD25 valide → ensureComedian crée une ligne avec le club_id réel lu en base', async () => {
  const mock = withClubsMock((call) => {
    if (call.url.includes('/comedians') && call.method === 'GET') return []; // pas trouvé -> création
    return [];
  });
  const req = fakeReq({ body: { action: 'ensureComedian', payload: {
    code: 'BCCD25', newComedian: { name: 'Nouveau Humoriste', email: 'nouveau@test.fr', phone: '0600000000' },
  } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  mock.restore();

  const post = mock.calls.find(c => c.method === 'POST' && c.url.includes('/comedians'));
  assert.ok(post);
  assert.equal(post.body[0].club_id, BCC_CLUB_ID);
  assert.equal(res.body.success, true);
});

test('recherche de comédien existant : le GET comedians est scopé club_id=eq.<id>, sans repli IS NULL (backfill étape C fait)', async () => {
  const mock = withClubsMock();
  const req = fakeReq({ body: { action: 'ensureComedian', payload: {
    code: 'BCCD25', newComedian: { name: 'X', email: 'existe@test.fr', phone: '0600000000' },
  } } });
  await portalWriteHandler(req, fakeRes());
  mock.restore();

  const get = mock.calls.find(c => c.method === 'GET' && c.url.includes('/comedians') && c.url.includes('email='));
  assert.ok(get, 'un GET comedians doit avoir eu lieu');
  assert.ok(get.url.includes(`club_id=eq.${encodeURIComponent(BCC_CLUB_ID)}`));
  assert.ok(!get.url.includes('is.null'), 'plus de repli legacy après le backfill de l\'étape C');
});

test('cancelDates : le DELETE assignments combine slot_key + comedian_id + scope club', async () => {
  const mock = withClubsMock((call) => {
    if (call.url.includes('/comedians') && call.method === 'GET') return [{ id: 'c1', name: 'Test' }];
    return [];
  });
  const req = fakeReq({ body: { action: 'cancelDates', payload: {
    code: 'BCCD25', comedianId: 'c1', comedianName: 'Test', slotKeys: ['2026-08-11-20h15'],
  } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  mock.restore();

  const del = mock.calls.find(c => c.method === 'DELETE' && c.url.includes('/assignments'));
  assert.ok(del.url.includes('slot_key=eq.2026-08-11-20h15'));
  assert.ok(del.url.includes('comedian_id=eq.c1'));
  assert.ok(del.url.includes(encodeURIComponent(BCC_CLUB_ID)));
  assert.equal(res.body.success, true);
});

console.log('\nTests terminés — voir le résumé du test runner ci-dessus (node --test).');
