// ════════════════════════════════════════════════════════════════════════
// Tests — chantier multitenant, étape C (bascule vers la table `clubs` réelle)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/multitenant-step-c.test.mjs
//
// Complète tests/multitenant-scoping.test.mjs avec des scénarios propres à
// la bascule : deux clubs réels (BCC + un second club fictif) coexistant
// dans la table `clubs`, pour vérifier qu'admin-login et portal-write
// résolvent chacun le bon club et ne se mélangent jamais — le scénario
// concret qui devient possible une fois la migration de l'étape C exécutée
// (avant, un seul club existait, donc une partie de cette isolation n'était
// que théorique).
//
// Même méthode que le fichier voisin : le VRAI code des handlers est
// exécuté, `fetch` global est mocké pour intercepter les appels Supabase —
// aucun credential ni réseau réel.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { verifyAdminToken, verifyPasswordHash, BCC_CLUB_ID, sha256Hex } = await import('../api/_lib.js');

const SECOND_CLUB_ID = '22222222-2222-4222-a222-222222222222'; // club B fictif, jamais réel
const BCC_HASH = sha256Hex('bcc-secret');
const SECOND_HASH = sha256Hex('second-secret');

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

// ── Table `clubs` simulée : deux clubs actifs, hash, slug et email distincts ──
const BCC_ADMIN_EMAIL = 'bcc-admin@test.fr';
const SECOND_ADMIN_EMAIL = 'club2-admin@test.fr';
const CLUBS_TABLE = [
  { id: BCC_CLUB_ID, slug: 'bcc', portal_code: 'BCCD25', admin_email: BCC_ADMIN_EMAIL, status: 'active', admin_pwd_hash: BCC_HASH },
  { id: SECOND_CLUB_ID, slug: 'club2', portal_code: 'CLUB2X', admin_email: SECOND_ADMIN_EMAIL, status: 'active', admin_pwd_hash: SECOND_HASH },
];

function mockClubsTable(extra) {
  return installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      if (call.url.includes('slug=eq.bcc')) return CLUBS_TABLE.filter(c => c.slug === 'bcc');
      if (call.url.includes('portal_code=eq.BCCD25')) return CLUBS_TABLE.filter(c => c.portal_code === 'BCCD25');
      if (call.url.includes('portal_code=eq.CLUB2X')) return CLUBS_TABLE.filter(c => c.portal_code === 'CLUB2X');
      const m = call.url.match(/admin_email=eq\.([^&]+)/);
      if (m) return CLUBS_TABLE.filter(c => c.admin_email === decodeURIComponent(m[1]));
      return [];
    }
    return extra ? extra(call) : [];
  });
}

// ════════════════════════════════════════════════════════════════════════
// _lib.js — verifyPasswordHash (nouvelle fonction générique, étape C)
// ════════════════════════════════════════════════════════════════════════

test('verifyPasswordHash : accepte le bon mot de passe pour un hash donné', () => {
  assert.equal(verifyPasswordHash('bcc-secret', BCC_HASH), true);
});

test('verifyPasswordHash : rejette le mot de passe d\'un AUTRE club même si le hash est valide par ailleurs', () => {
  assert.equal(verifyPasswordHash('second-secret', BCC_HASH), false);
  assert.equal(verifyPasswordHash('bcc-secret', SECOND_HASH), false);
});

// ════════════════════════════════════════════════════════════════════════
// admin-login.js — le mot de passe du club BCC ne doit jamais déverrouiller
// un autre club, même si les deux existent en base simultanément
// ════════════════════════════════════════════════════════════════════════
// Mis à jour pour l'étape F : le endpoint résout désormais le club par
// admin_email (plus par slug 'bcc' en dur) — les deux clubs de CLUBS_TABLE
// sont donc chacun indépendamment atteignables via /api/admin-login. Ce qui
// est vérifié ici : le mot de passe du second club n'ouvre jamais le compte
// du BCC, même en connaissant son email — l'intention d'origine du test
// (pas de confusion inter-club) est inchangée, seul le contrat d'appel a
// changé ({email, password} au lieu de {password} seul). Couverture
// complémentaire (inscription self-service, isolation entre deux nouveaux
// clubs) dans tests/multitenant-step-f.test.mjs.

const adminLoginHandler = (await import('../api/admin-login.js')).default;

test('admin-login : email + mot de passe du BCC → token avec BCC_CLUB_ID, même si un second club existe en base', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL, password: 'bcc-secret' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  const claims = verifyAdminToken(fakeReq({ token: res.body.token }));
  assert.equal(claims.club_id, BCC_CLUB_ID);
});

test('admin-login : le mot de passe du second club ne déverrouille JAMAIS le compte BCC, même avec le bon email BCC (pas de confusion inter-club)', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL, password: 'second-secret' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
});

test('admin-login : le second club se connecte désormais aussi avec ses propres identifiants (résolution par email, plus par slug en dur BCC)', async () => {
  const mock = mockClubsTable();
  const req = fakeReq({ body: { email: SECOND_ADMIN_EMAIL, password: 'second-secret' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  const claims = verifyAdminToken(fakeReq({ token: res.body.token }));
  assert.equal(claims.club_id, SECOND_CLUB_ID);
  assert.notEqual(claims.club_id, BCC_CLUB_ID);
});

// ════════════════════════════════════════════════════════════════════════
// portal-write.js — deux portal_code distincts résolvent deux club_id
// distincts, sans jamais se croiser
// ════════════════════════════════════════════════════════════════════════

const portalWriteHandler = (await import('../api/portal-write.js')).default;

test('portail : code BCCD25 résout BCC_CLUB_ID, code CLUB2X résout SECOND_CLUB_ID — jamais l\'inverse', async () => {
  const mockA = mockClubsTable((call) => (call.url.includes('/comedians') ? [] : []));
  const reqA = fakeReq({ body: { action: 'ensureComedian', payload: {
    code: 'BCCD25', newComedian: { name: 'A', email: 'a@test.fr', phone: '0600000000' },
  } } });
  await portalWriteHandler(reqA, fakeRes());
  const postA = mockA.calls.find(c => c.method === 'POST' && c.url.includes('/comedians'));
  mockA.restore();
  assert.equal(postA.body[0].club_id, BCC_CLUB_ID);

  const mockB = mockClubsTable((call) => (call.url.includes('/comedians') ? [] : []));
  const reqB = fakeReq({ body: { action: 'ensureComedian', payload: {
    code: 'CLUB2X', newComedian: { name: 'B', email: 'b@test.fr', phone: '0600000001' },
  } } });
  await portalWriteHandler(reqB, fakeRes());
  const postB = mockB.calls.find(c => c.method === 'POST' && c.url.includes('/comedians'));
  mockB.restore();
  assert.equal(postB.body[0].club_id, SECOND_CLUB_ID);
  assert.notEqual(postA.body[0].club_id, postB.body[0].club_id);
});

test('portail : un id de comédien du club B ne peut pas être manipulé via le code du club A (recherche scopée)', async () => {
  const mock = mockClubsTable((call) => {
    // Le comédien 'c-club2' n'existe que côté club B ; recherché avec le
    // scope club A, la requête réelle Postgres (club_id=eq.<A>) ne le
    // retournerait jamais — ce mock simule ce comportement en n'ayant
    // simplement rien à renvoyer, la vraie garantie venant du filtre déjà
    // couvert par les tests clubOrFilter().
    if (call.url.includes('/comedians')) return [];
    return [];
  });
  const req = fakeReq({ body: { action: 'cancelDates', payload: {
    code: 'BCCD25', comedianId: 'c-club2', comedianName: 'Fuite', slotKeys: ['2026-08-11-20h15'],
  } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 404, 'un comédien introuvable dans le scope du club résolu doit être rejeté');
});

console.log('\nTests étape C terminés — voir le résumé du test runner ci-dessus (node --test).');
