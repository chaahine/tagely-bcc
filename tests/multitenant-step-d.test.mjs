// ════════════════════════════════════════════════════════════════════════
// Tests — chantier multitenant, étape D
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Couvre les deux volets livrés à l'étape D :
//   1. api/portal-resolve.js — nouvelle route publique de lecture seule qui
//      résout le code d'accès portail en club_id (nécessaire pour que
//      portal.html scope ses lectures directes Supabase, cf. sb()/getClubId()
//      dans portal.html). Réutilise resolveClubIdByPortalCode() de _lib.js,
//      déjà couverte indirectement par tests/multitenant-step-c.test.mjs via
//      portal-write.js — ici on teste la fonction elle-même et la nouvelle
//      route bout en bout.
//   2. api/admin-write.js — nouvelles actions addScheduleSlot/removeScheduleSlot
//      (grille pilotée par la base, schedule_templates) : scoping club_id,
//      validation des payloads, dédoublonnage, résolution/création de salle.
//
// Même méthode que les fichiers voisins : le VRAI code des handlers est
// exécuté, `fetch` global est mocké pour intercepter les appels Supabase —
// aucun credential ni réseau réel.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken, resolveClubIdByPortalCode, BCC_CLUB_ID } = await import('../api/_lib.js');

const SECOND_CLUB_ID = '22222222-2222-4222-a222-222222222222'; // club B fictif, jamais réel
const ROOM_A_ID = '11111111-1111-4111-a111-111111111111';
const ROOM_B_ID = '33333333-3333-4333-a333-333333333333';

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

const CLUBS_TABLE = [
  { id: BCC_CLUB_ID, slug: 'bcc', portal_code: 'BCCD25', status: 'active', name: 'Beer Comedy Club' },
  { id: SECOND_CLUB_ID, slug: 'club2', portal_code: 'CLUB2X', status: 'active', name: 'Le Rire Jaune' },
  { id: 'suspended-club', slug: 'susp', portal_code: 'SUSPND', status: 'suspended', name: 'Club suspendu' },
];

function mockClubsTable(extra) {
  return installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      const m = call.url.match(/portal_code=eq\.([^&]+)/);
      if (m) return CLUBS_TABLE.filter(c => c.portal_code === decodeURIComponent(m[1]));
      return [];
    }
    return extra ? extra(call) : [];
  });
}

// ════════════════════════════════════════════════════════════════════════
// resolveClubIdByPortalCode (_lib.js) — fonction partagée portal-write / portal-resolve
// ════════════════════════════════════════════════════════════════════════

test('resolveClubIdByPortalCode : code valide → club_id, code inconnu → null, club suspendu → null', async () => {
  const mock = mockClubsTable();
  const bcc = await resolveClubIdByPortalCode('BCCD25');
  const second = await resolveClubIdByPortalCode('club2x'); // insensible à la casse (toUpperCase())
  const unknown = await resolveClubIdByPortalCode('NOPE99');
  const suspended = await resolveClubIdByPortalCode('SUSPND');
  const empty = await resolveClubIdByPortalCode('');
  const notString = await resolveClubIdByPortalCode(undefined);
  mock.restore();
  assert.equal(bcc, BCC_CLUB_ID);
  assert.equal(second, SECOND_CLUB_ID);
  assert.equal(unknown, null);
  assert.equal(suspended, null);
  assert.equal(empty, null);
  assert.equal(notString, null);
});

// ════════════════════════════════════════════════════════════════════════
// api/portal-resolve.js — nouvelle route publique, lecture seule
// ════════════════════════════════════════════════════════════════════════

const portalResolveHandler = (await import('../api/portal-resolve.js')).default;

test('portal-resolve : code BCCD25 → 200 {success:true, club_id: BCC_CLUB_ID}', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { code: 'BCCD25' } });
  const res = fakeRes();
  await portalResolveHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club_id, BCC_CLUB_ID);
});

test('portal-resolve : code CLUB2X → club_id du second club, jamais celui du BCC', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { code: 'CLUB2X' } });
  const res = fakeRes();
  await portalResolveHandler(req, res);
  mock.restore();
  assert.equal(res.body.club_id, SECOND_CLUB_ID);
  assert.notEqual(res.body.club_id, BCC_CLUB_ID);
});

// ── Correctif identité club (bug critique) — portal.html affichait
// "Broadway Comedy Club" codé en dur pour tous les clubs. portal-resolve.js
// renvoie désormais aussi "name", lu ici pour vérifier que deux clubs
// distincts reçoivent bien CHACUN leur propre nom, jamais mélangés ni figés
// sur celui du BCC. ──
test('portal-resolve : renvoie le vrai nom du club résolu par le code, jamais celui d\'un autre club', async () => {
  const mock = mockClubsTable();
  const resBcc = fakeRes();
  await portalResolveHandler(fakeReq({ body: { code: 'BCCD25' } }), resBcc);
  const resOther = fakeRes();
  await portalResolveHandler(fakeReq({ body: { code: 'CLUB2X' } }), resOther);
  mock.restore();
  assert.equal(resBcc.body.name, 'Beer Comedy Club');
  assert.equal(resOther.body.name, 'Le Rire Jaune');
  assert.notEqual(resOther.body.name, resBcc.body.name);
  assert.notEqual(resOther.body.name, 'Broadway Comedy Club');
});

test('portal-resolve : code inconnu → 403, pas de club_id renvoyé', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { code: 'INCONNU' } });
  const res = fakeRes();
  await portalResolveHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.club_id, undefined);
});

test('portal-resolve : club suspendu → 403 même si le code existe bel et bien', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { code: 'SUSPND' } });
  const res = fakeRes();
  await portalResolveHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
});

test('portal-resolve : ne sélectionne que id,status,name côté Supabase — jamais admin_pwd_hash ni autre champ sensible', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { code: 'BCCD25' } });
  await portalResolveHandler(req, fakeRes());
  const clubsCall = mock.calls.find(c => c.url.includes('/clubs'));
  mock.restore();
  assert.ok(clubsCall.url.includes('select=id,status,name'));
  assert.ok(!clubsCall.url.includes('admin_pwd_hash'));
});

test('portal-resolve : méthode GET rejetée (405) — route strictement POST comme les autres routes /api', async () => {
  const req = { method: 'GET', headers: {} };
  const res = fakeRes();
  await portalResolveHandler(req, res);
  assert.equal(res.statusCode, 405);
});

// ════════════════════════════════════════════════════════════════════════
// api/admin-write.js — addScheduleSlot / removeScheduleSlot
// ════════════════════════════════════════════════════════════════════════

const adminWriteHandler = (await import('../api/admin-write.js')).default;

function tokenFor(clubId) {
  return issueAdminToken(clubId).token;
}

test('addScheduleSlot : rejette weekday hors 0-6 et time mal formé', async () => {
  const mock = installFetchMock(() => []);
  const token = tokenFor(BCC_CLUB_ID);

  const badWeekday = fakeReq({ token, body: { action: 'addScheduleSlot', payload: { weekday: 7, time: '20:15' } } });
  const res1 = fakeRes();
  await adminWriteHandler(badWeekday, res1);
  assert.equal(res1.statusCode, 400);

  const badTime = fakeReq({ token, body: { action: 'addScheduleSlot', payload: { weekday: 2, time: '20h15' } } });
  const res2 = fakeRes();
  await adminWriteHandler(badTime, res2);
  assert.equal(res2.statusCode, 400);

  mock.restore();
});

test('addScheduleSlot : sans token → 401, aucun appel Supabase déclenché', async () => {
  const mock = installFetchMock(() => []);
  const req = fakeReq({ body: { action: 'addScheduleSlot', payload: { weekday: 2, time: '20:15' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(mock.calls.length, 0);
});

test('addScheduleSlot : crée une salle par défaut si le club n\'en a aucune, puis insère le créneau avec ce room_id', async () => {
  const mock = installFetchMock((call) => {
    if (call.url.includes('/schedule_templates') && call.method === 'GET') return []; // pas de doublon existant
    if (call.url.includes('/rooms') && call.method === 'GET') return []; // aucune salle pour ce club
    return [];
  });
  const token = tokenFor(BCC_CLUB_ID);
  const req = fakeReq({ token, body: { action: 'addScheduleSlot', payload: { weekday: 2, time: '20:15', label: 'Mardi' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.template.weekday, 2);
  assert.equal(res.body.template.time, '20:15');
  assert.equal(res.body.template.club_id, BCC_CLUB_ID);

  const roomInsert = mock.calls.find(c => c.url.includes('/rooms') && c.method === 'POST');
  const templateInsert = mock.calls.find(c => c.url.includes('/schedule_templates') && c.method === 'POST');
  assert.ok(roomInsert, 'une salle par défaut doit être créée');
  assert.equal(roomInsert.body[0].club_id, BCC_CLUB_ID);
  assert.equal(templateInsert.body[0].room_id, roomInsert.body[0].id, 'le créneau doit référencer la salle tout juste créée');
});

test('addScheduleSlot : réutilise une salle existante plutôt que d\'en créer une nouvelle', async () => {
  const mock = installFetchMock((call) => {
    if (call.url.includes('/schedule_templates') && call.method === 'GET') return [];
    if (call.url.includes('/rooms') && call.method === 'GET') return [{ id: ROOM_A_ID }];
    return [];
  });
  const token = tokenFor(BCC_CLUB_ID);
  const req = fakeReq({ token, body: { action: 'addScheduleSlot', payload: { weekday: 5, time: '19:00' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  const roomInsert = mock.calls.find(c => c.url.includes('/rooms') && c.method === 'POST');
  assert.equal(roomInsert, undefined, 'pas de nouvelle salle créée si une existe déjà');
  assert.equal(res.body.template.room_id, ROOM_A_ID);
});

test('addScheduleSlot : dédoublonnage — un créneau déjà présent (même jour+heure, même club) n\'est pas réinséré', async () => {
  const existingRow = { id: 'tmpl-existing', club_id: BCC_CLUB_ID, room_id: ROOM_A_ID, weekday: 2, time: '20:15', active: true };
  const mock = installFetchMock((call) => {
    if (call.url.includes('/schedule_templates') && call.method === 'GET') return [existingRow];
    return [];
  });
  const token = tokenFor(BCC_CLUB_ID);
  const req = fakeReq({ token, body: { action: 'addScheduleSlot', payload: { weekday: 2, time: '20:15' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alreadyExists, true);
  assert.equal(res.body.template.id, 'tmpl-existing');
  const templateInsert = mock.calls.find(c => c.url.includes('/schedule_templates') && c.method === 'POST');
  assert.equal(templateInsert, undefined, 'aucun INSERT ne doit partir si la ligne existe déjà');
});

test('addScheduleSlot : le dédoublonnage est scopé par club — le même jour/heure existant chez un AUTRE club n\'empêche pas la création ici', async () => {
  // La requête de recherche de doublon doit inclure club_id=eq.<clubId> ;
  // un mock qui ignore ce filtre renverrait à tort la ligne du club B.
  const mock = installFetchMock((call) => {
    if (call.url.includes('/schedule_templates') && call.method === 'GET') {
      if (call.url.includes(`club_id=eq.${encodeURIComponent(BCC_CLUB_ID)}`)) return []; // rien pour le BCC
      return [{ id: 'other-club-row' }]; // le club B a bien ce créneau, mais ce n'est pas ce qu'on interroge
    }
    if (call.url.includes('/rooms') && call.method === 'GET') return [{ id: ROOM_A_ID }];
    return [];
  });
  const token = tokenFor(BCC_CLUB_ID);
  const req = fakeReq({ token, body: { action: 'addScheduleSlot', payload: { weekday: 2, time: '20:15' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  assert.equal(res.body.alreadyExists, undefined, 'ne doit pas se croire dupliqué à cause de la ligne d\'un autre club');
  const templateInsert = mock.calls.find(c => c.url.includes('/schedule_templates') && c.method === 'POST');
  assert.ok(templateInsert, 'doit bien insérer pour le BCC');
  assert.equal(templateInsert.body[0].club_id, BCC_CLUB_ID);
});

test('removeScheduleSlot : requiert un id', async () => {
  const mock = installFetchMock(() => []);
  const token = tokenFor(BCC_CLUB_ID);
  const req = fakeReq({ token, body: { action: 'removeScheduleSlot', payload: {} } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
});

test('removeScheduleSlot : le DELETE est scopé au club du token, pas seulement filtré par id', async () => {
  const mock = installFetchMock(() => []);
  const token = tokenFor(BCC_CLUB_ID);
  const req = fakeReq({ token, body: { action: 'removeScheduleSlot', payload: { id: 'tmpl-1' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  const del = mock.calls.find(c => c.url.includes('/schedule_templates') && c.method === 'DELETE');
  assert.ok(del.url.includes(`id=eq.tmpl-1`));
  assert.ok(del.url.includes(`club_id=eq.${encodeURIComponent(BCC_CLUB_ID)}`), 'le DELETE doit être scopé club_id, sinon un admin pourrait deviner/forger un id d\'un autre club');
});

test('isolation croisée : addScheduleSlot du club A insère toujours avec club_id=A, jamais B, même sur un payload identique', async () => {
  const mock = installFetchMock((call) => {
    if (call.url.includes('/schedule_templates') && call.method === 'GET') return [];
    if (call.url.includes('/rooms') && call.method === 'GET') return [{ id: ROOM_B_ID }];
    return [];
  });
  const tokenB = tokenFor(SECOND_CLUB_ID);
  const req = fakeReq({ token: tokenB, body: { action: 'addScheduleSlot', payload: { weekday: 2, time: '20:15' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.body.template.club_id, SECOND_CLUB_ID);
  assert.notEqual(res.body.template.club_id, BCC_CLUB_ID);
});

console.log('\nTests étape D (serveur) terminés — voir le résumé du test runner ci-dessus (node --test).');
