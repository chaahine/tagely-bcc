// ════════════════════════════════════════════════════════════════════════
// Tests — api/data-read.js (fin de la lecture publique, 2026-10)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/data-read.test.mjs
// Le VRAI handler est exécuté, fetch remplacé par un mock qui enregistre les
// requêtes vers Supabase. Ce qui compte : le club_id envoyé à Supabase vient
// toujours du serveur, et rien ne permet d'élargir la requête.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken } = await import('../api/_lib.js');
const { default: handler, buildReadParams } = await import('../api/data-read.js');

const CLUB_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const CLUB_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

function installFetchMock(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET' };
    calls.push(call);
    const canned = responder ? responder(call) : undefined;
    return { ok: true, status: 200, json: async () => (canned !== undefined ? canned : []), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function fakeReq({ token, body }) {
  return { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body };
}

function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  res.end = () => res;
  return res;
}

const tokenFor = (clubId) => issueAdminToken(`admin-${clubId}`, [{ id: clubId, name: 'Club' }], clubId).token;

// Le mock répond au code portail 'CODEB' par le club B, à tout le reste par rien.
const portalResponder = (rows) => (call) => {
  if (call.url.includes('/clubs?')) return call.url.includes('portal_code=eq.CODEB') ? [{ id: CLUB_B, status: 'trial', name: 'B' }] : [];
  return rows;
};

test('buildReadParams : traduit filtres, tri et pagination, club_id toujours en dernier', () => {
  const p = buildReadParams({
    filters: [{ col: 'slot_key', op: 'gte', value: '2026-10-01' }, { col: 'slot_key', op: 'lt', value: '2026-11-01' }],
    order: 'slot_key', limit: 1000, offset: 0,
  }, ['slot_key'], CLUB_A);
  assert.equal(p, `?select=*&slot_key=gte.2026-10-01&slot_key=lt.2026-11-01&order=slot_key&limit=1000&offset=0&club_id=eq.${CLUB_A}`);
});

test('buildReadParams : refuse colonne, opérateur ou tri hors liste', () => {
  assert.equal(buildReadParams({ filters: [{ col: 'club_id', op: 'eq', value: CLUB_B }] }, [], CLUB_A), null);
  assert.equal(buildReadParams({ filters: [{ col: 'id', op: 'or', value: 'x' }] }, [], CLUB_A), null);
  assert.equal(buildReadParams({ order: 'name;drop' }, ['name'], CLUB_A), null);
  assert.equal(buildReadParams({ limit: 5000 }, [], CLUB_A), null);
});

test('buildReadParams : une valeur ne peut pas injecter un paramètre supplémentaire', () => {
  const p = buildReadParams({ filters: [{ col: 'id', op: 'eq', value: `x&club_id=eq.${CLUB_B}` }] }, [], CLUB_A);
  assert.ok(!p.includes(`club_id=eq.${CLUB_B}`));
  assert.ok(p.endsWith(`&club_id=eq.${CLUB_A}`));
});

test('admin : lit son propre club, jamais celui demandé par le client', async () => {
  const m = installFetchMock(() => [{ id: 'c1' }]);
  try {
    const res = fakeRes();
    await handler(fakeReq({ token: tokenFor(CLUB_A), body: { table: 'comedians', club_id: CLUB_B, query: { order: 'name' } } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, [{ id: 'c1' }]);
    assert.equal(m.calls.length, 1);
    assert.ok(m.calls[0].url.includes(`club_id=eq.${CLUB_A}`));
    assert.ok(!m.calls[0].url.includes(CLUB_B));
  } finally { m.restore(); }
});

test('admin : table hors liste refusée (clubs, admins)', async () => {
  const m = installFetchMock();
  try {
    for (const table of ['clubs', 'admins', 'admin_club_links']) {
      const res = fakeRes();
      await handler(fakeReq({ token: tokenFor(CLUB_A), body: { table } }), res);
      assert.equal(res.statusCode, 403, table);
    }
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('sans token ni code : 401, aucune lecture', async () => {
  const m = installFetchMock();
  try {
    const res = fakeRes();
    await handler(fakeReq({ body: { table: 'comedians' } }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('token falsifié : traité comme absent (401)', async () => {
  const m = installFetchMock();
  try {
    const [payload] = tokenFor(CLUB_A).split('.');
    const res = fakeRes();
    await handler(fakeReq({ token: `${payload}.forged`, body: { table: 'comedians' } }), res);
    assert.equal(res.statusCode, 401);
  } finally { m.restore(); }
});

test('portail : code invalide refusé', async () => {
  const m = installFetchMock(portalResponder([]));
  try {
    const res = fakeRes();
    await handler(fakeReq({ body: { code: 'NOPE', table: 'assignments' } }), res);
    assert.equal(res.statusCode, 403);
  } finally { m.restore(); }
});

test('portail : la liste des humoristes n\'est pas lisible', async () => {
  const m = installFetchMock(portalResponder([]));
  try {
    const res = fakeRes();
    await handler(fakeReq({ body: { code: 'CODEB', table: 'comedians' } }), res);
    assert.equal(res.statusCode, 403);
  } finally { m.restore(); }
});

test('portail : assignments scopés sur le club du code', async () => {
  const m = installFetchMock(portalResponder([{ slot_key: 'k' }]));
  try {
    const res = fakeRes();
    await handler(fakeReq({ body: { code: 'CODEB', table: 'assignments' } }), res);
    assert.equal(res.statusCode, 200);
    const read = m.calls.find(c => c.url.includes('/assignments?'));
    assert.ok(read.url.endsWith(`club_id=eq.${CLUB_B}`));
  } finally { m.restore(); }
});

test('portail : dispos exigent un comedian_id', async () => {
  const m = installFetchMock(portalResponder([]));
  try {
    const res = fakeRes();
    await handler(fakeReq({ body: { code: 'CODEB', table: 'dispos', query: {} } }), res);
    assert.equal(res.statusCode, 400);
    const ok = fakeRes();
    await handler(fakeReq({ body: { code: 'CODEB', table: 'dispos', query: { filters: [{ col: 'comedian_id', op: 'eq', value: 'c1' }] } } }), ok);
    assert.equal(ok.statusCode, 200);
  } finally { m.restore(); }
});

test('portail : recherche par nom ne renvoie ni email ni téléphone', async () => {
  const m = installFetchMock((call) => {
    if (call.url.includes('/clubs?')) return [{ id: CLUB_B, status: 'trial', name: 'B' }];
    if (call.url.includes('email=eq.')) return [];
    if (call.url.includes('/comedians?')) {
      assert.ok(call.url.includes('select=id,name,'));
      return [{ id: 'c1', name: 'Élodie MARTIN' }, { id: 'c2', name: 'PAUL DURAND' }];
    }
    return [];
  });
  try {
    const res = fakeRes();
    await handler(fakeReq({ body: { code: 'CODEB', lookup: 'comedian', email: 'x@y.fr', name: 'ELODIE  martin' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.comedian.id, 'c1');
    assert.equal(res.body.comedian.email, undefined);
  } finally { m.restore(); }
});

test('portail : recherche par email scopée sur le club du code', async () => {
  const m = installFetchMock((call) => {
    if (call.url.includes('/clubs?')) return [{ id: CLUB_B, status: 'trial', name: 'B' }];
    if (call.url.includes('email=eq.')) return [{ id: 'c9', name: 'X', email: 'x@y.fr' }];
    return [];
  });
  try {
    const res = fakeRes();
    await handler(fakeReq({ body: { code: 'CODEB', lookup: 'comedian', email: 'X@y.fr' } }), res);
    assert.equal(res.body.comedian.id, 'c9');
    const q = m.calls.find(c => c.url.includes('email=eq.'));
    assert.ok(q.url.includes('email=eq.x%40y.fr'));
    assert.ok(q.url.includes(`club_id=eq.${CLUB_B}`));
  } finally { m.restore(); }
});
