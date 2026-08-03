// ════════════════════════════════════════════════════════════════════════
// Tests — chantier "mode tournée" (dates ponctuelles hors grille, palier Pro)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Couvre les actions serveur ajoutées à api/admin-write.js pour le mode
// tournée (addEvent/removeEvent) : scoping club (mêmes garanties que le
// reste du fichier, voir tests/multitenant-scoping.test.mjs), gating Pro
// (SEULE action de admin-write.js protégée par computePlanAccess()
// aujourd'hui — la fusion grille/events côté client est testée séparément
// dans tests/schedule-grid-client.test.mjs), et isolation entre deux clubs
// réels. Même méthode que multitenant-scoping.test.mjs : le VRAI handler est
// exécuté, `fetch` global est mocké (aucun credential/réseau réel requis).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken } = await import('../api/_lib.js');
const adminWriteHandler = (await import('../api/admin-write.js')).default;

const CLUB_A = '11111111-1111-4111-a111-111111111111'; // club Pro fictif
const CLUB_B = '22222222-2222-4222-a222-222222222222'; // club Essentiel fictif, jamais réel

function tokenForClub(clubId, { adminId = `admin-${clubId}` } = {}) {
  return issueAdminToken(adminId, [{ id: clubId, name: 'Club' }], clubId).token;
}

function fakeReq({ token, body }) {
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

// responder(call) reçoit { url, method, body } pour chaque appel `fetch`
// sortant vers Supabase et renvoie les lignes à renvoyer (ou undefined -> []).
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

// Mock générique : répond aux lookups clubs/rooms/events attendus par
// addEvent(), paramétrable par plan/status et par salle(s) existante(s).
function mockAddEventDeps({ status = 'active', plan = 'pro', rooms = [{ id: 'room-1' }], existingEvent = null } = {}) {
  return installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') return [{ id: 'irrelevant', status, plan }];
    if (call.url.includes('/rooms') && call.method === 'GET') return rooms;
    if (call.url.includes('/events') && call.method === 'GET') return existingEvent ? [existingEvent] : [];
    return [];
  });
}

// ════════════════════════════════════════════════════════════════════════
// addEvent — validation
// ════════════════════════════════════════════════════════════════════════

test('addEvent : date malformée (calendaire invalide, ex. 30 février) → 400, aucune écriture', async () => {
  const mock = mockAddEventDeps();
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-02-30', time: '20:00' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
  assert.ok(!mock.calls.some(c => c.method === 'POST'));
});

test('addEvent : heure malformée → 400', async () => {
  const mock = mockAddEventDeps();
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20h00' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
});

// ════════════════════════════════════════════════════════════════════════
// addEvent — gating Pro (le coeur du chantier gating pour le mode tournée)
// ════════════════════════════════════════════════════════════════════════

test('addEvent : club actif au palier Essentiel → 403, MÊME en forçant l\'appel API directement (jamais fait confiance au client)', async () => {
  const mock = mockAddEventDeps({ status: 'active', plan: 'essentiel' });
  const req = fakeReq({ token: tokenForClub(CLUB_B), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
  assert.ok(!mock.calls.some(c => c.method === 'POST' && c.url.includes('/events')), 'aucune ligne events ne doit être insérée pour un club Essentiel');
});

test('addEvent : club actif au palier Pro → autorisé (201/200, ligne events insérée)', async () => {
  const mock = mockAddEventDeps({ status: 'active', plan: 'pro' });
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00', label: 'Tournée Marseille' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const post = mock.calls.find(c => c.method === 'POST' && c.url.includes('/events'));
  assert.ok(post, 'une ligne events doit être insérée pour un club Pro');
});

test('addEvent : club actif au palier Réseau → autorisé (même règle que Pro, PRO_PLANS = [pro, reseau])', async () => {
  const mock = mockAddEventDeps({ status: 'active', plan: 'reseau' });
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
});

test('addEvent : club en essai (trial) au palier Essentiel → autorisé (accès complet pendant l\'essai, même règle que le chapeau)', async () => {
  const mock = mockAddEventDeps({ status: 'trial', plan: 'essentiel' });
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
});

// ════════════════════════════════════════════════════════════════════════
// addEvent — scoping club + isolation
// ════════════════════════════════════════════════════════════════════════

test('addEvent : la ligne insérée porte le club_id du token authentifié (jamais un club_id du payload)', async () => {
  const mock = mockAddEventDeps({ status: 'active', plan: 'pro' });
  const req = fakeReq({
    token: tokenForClub(CLUB_A),
    body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00', club_id: CLUB_B /* tentative d'usurpation, doit être ignorée */ } },
  });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  const post = mock.calls.find(c => c.method === 'POST' && c.url.includes('/events'));
  assert.equal(post.body[0].club_id, CLUB_A);
});

test('addEvent : le slot_key est construit à partir de date+time, jamais fait confiance à une valeur envoyée directement', async () => {
  const mock = mockAddEventDeps({ status: 'active', plan: 'pro' });
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '18:30' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  const post = mock.calls.find(c => c.method === 'POST' && c.url.includes('/events'));
  assert.equal(post.body[0].slot_key, '2026-08-15-18H30');
});

test('addEvent : un room_id fourni qui n\'appartient pas au club (scoping cassé côté rooms) est ignoré, remplacé par la salle par défaut du club', async () => {
  const mock = installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') return [{ id: 'x', status: 'active', plan: 'pro' }];
    if (call.url.includes('/rooms') && call.method === 'GET') {
      // room_id demandé introuvable pour CE club (scope club_id ne matche pas) -> []
      if (call.url.includes('room-etrangere')) return [];
      return [{ id: 'room-defaut' }]; // resolveDefaultRoomId
    }
    if (call.url.includes('/events') && call.method === 'GET') return [];
    return [];
  });
  const req = fakeReq({
    token: tokenForClub(CLUB_A),
    body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00', room_id: 'room-etrangere' } },
  });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  const post = mock.calls.find(c => c.method === 'POST' && c.url.includes('/events'));
  assert.equal(post.body[0].room_id, 'room-defaut', 'doit retomber sur la salle par défaut, jamais sur le room_id fourni non vérifié');
});

test('addEvent : idempotent — une date déjà ajoutée (même club, même slot_key, pas annulée) n\'est pas dupliquée', async () => {
  const existing = { id: 'ev-existing', club_id: CLUB_A, room_id: 'room-1', slot_key: '2026-08-15-20H00', source: 'manual', cancelled: false, label: null };
  const mock = mockAddEventDeps({ status: 'active', plan: 'pro', existingEvent: existing });
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alreadyExists, true);
  assert.ok(!mock.calls.some(c => c.method === 'POST' && c.url.includes('/events')), 'aucun INSERT ne doit avoir lieu si la date existe déjà');
});

test('isolation croisée : addEvent du club A ne référence jamais le club B dans ses requêtes Supabase, et inversement', async () => {
  const mockA = mockAddEventDeps({ status: 'active', plan: 'pro' });
  await adminWriteHandler(fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'addEvent', payload: { date: '2026-08-15', time: '20:00' } } }), fakeRes());
  mockA.restore();
  for (const c of mockA.calls) {
    assert.ok(!c.url.includes(encodeURIComponent(CLUB_B)), `fuite vers club B détectée dans un appel scopé club A : ${c.url}`);
  }

  const mockB = mockAddEventDeps({ status: 'active', plan: 'pro' });
  await adminWriteHandler(fakeReq({ token: tokenForClub(CLUB_B), body: { action: 'addEvent', payload: { date: '2026-08-16', time: '20:00' } } }), fakeRes());
  mockB.restore();
  for (const c of mockB.calls) {
    assert.ok(!c.url.includes(encodeURIComponent(CLUB_A)), `fuite vers club A détectée dans un appel scopé club B : ${c.url}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// removeEvent
// ════════════════════════════════════════════════════════════════════════

test('removeEvent : le DELETE est scopé club_id + id + source=manual (ne touche jamais une ligne "template")', async () => {
  const mock = installFetchMock();
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'removeEvent', payload: { id: 'ev-1' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  const del = mock.calls.find(c => c.method === 'DELETE' && c.url.includes('/events'));
  assert.ok(del);
  assert.ok(del.url.includes('id=eq.ev-1'));
  assert.ok(del.url.includes('source=eq.manual'));
  assert.ok(del.url.includes(encodeURIComponent(CLUB_A)));
});

test('removeEvent : sans id → 400, aucun DELETE déclenché', async () => {
  const mock = installFetchMock();
  const req = fakeReq({ token: tokenForClub(CLUB_A), body: { action: 'removeEvent', payload: {} } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
  assert.equal(mock.calls.length, 0);
});

test('removeEvent : autorisé même pour un club au palier Essentiel (seul l\'AJOUT est gaté Pro, pas le retrait)', async () => {
  // removeEvent ne fait aucun lookup clubs/plan — ce test documente ce choix
  // volontairement : un club redescendu au palier Essentiel doit pouvoir
  // nettoyer les dates déjà créées.
  const mock = installFetchMock();
  const req = fakeReq({ token: tokenForClub(CLUB_B), body: { action: 'removeEvent', payload: { id: 'ev-1' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.ok(!mock.calls.some(c => c.url.includes('/clubs')), 'removeEvent ne doit pas consulter clubs.plan');
});

// ════════════════════════════════════════════════════════════════════════
// Sécurité de base — cohérente avec le reste de admin-write.js
// ════════════════════════════════════════════════════════════════════════

test('addEvent/removeEvent : sans token → 401, aucun appel Supabase déclenché', async () => {
  for (const action of ['addEvent', 'removeEvent']) {
    const mock = installFetchMock();
    const res = fakeRes();
    await adminWriteHandler(fakeReq({ body: { action, payload: { date: '2026-08-15', time: '20:00', id: 'ev-1' } } }), res);
    mock.restore();
    assert.equal(res.statusCode, 401, `action ${action}`);
    assert.equal(mock.calls.length, 0, `action ${action}`);
  }
});

console.log('\nTests mode tournée terminés — voir le résumé du test runner ci-dessus (node --test).');
