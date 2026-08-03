// ════════════════════════════════════════════════════════════════════════
// Tests — correctif bug critique : identité du club jamais chargée côté
// client (lien portail copié depuis Réglages codé en dur SANS ?code=,
// résolu par défaut sur 'BCCD25' — le vrai code du BCC — côté portal.html)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Avant ce correctif :
//  - api/admin-login.js ne renvoyait que { success, token, expiresAt } —
//    rien côté client ne chargeait jamais nom/ville/portal_code du club
//    connecté depuis la vraie ligne `clubs`.
//  - index.html initialisait `currentCode` une seule fois depuis
//    localStorage (ou, à défaut, depuis CLUB_CODE='BCCD25' codé en dur) et
//    ne le remettait JAMAIS à jour depuis la base — le lien portail copié
//    depuis Réglages était même codé en dur, sans ?code= du tout.
//  - portal.html affichait "Broadway Comedy Club" en dur pour tous les
//    clubs, et le bouton "Sauvegarder" de Réglages ne faisait qu'un toast
//    (rien n'était jamais persisté en base).
//
// Ce fichier couvre, avec le VRAI code shippé (serveur ET extraits client
// via le pattern TEST-EXTRACT, cf. tests/schedule-grid-client.test.mjs) :
//  1. api/admin-login.js renvoie désormais { club: { name, city,
//     portal_code, dispo_deadline_day } }, distinct et jamais mélangé entre
//     deux clubs différents.
//  2. api/portal-resolve.js renvoie aussi "name" (couvert dans
//     multitenant-step-d.test.mjs, référencé ici en commentaire).
//  3. api/admin-write.js action 'updateClub' persiste name/city/
//     dispo_deadline_day, scopé au club authentifié uniquement.
//  4. index.html — applyClubInfo()/buildPortalLink() (bloc TEST-EXTRACT
//     "club-identity") : le lien portail construit pour un club non-BCC ne
//     contient JAMAIS 'BCCD25'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken, sha256Hex, BCC_CLUB_ID } = await import('../api/_lib.js');
const adminLoginHandler = (await import('../api/admin-login.js')).default;
const adminWriteHandler = (await import('../api/admin-write.js')).default;

const SECOND_CLUB_ID = '44444444-4444-4444-a444-444444444444';

const CLUBS = [
  {
    id: BCC_CLUB_ID, status: 'active', admin_email: 'bruce@bcc.fr',
    admin_pwd_hash: sha256Hex('bruce-pwd'), name: 'Beer Comedy Club', city: 'Lille', portal_code: 'BCCD25',
  },
  {
    id: SECOND_CLUB_ID, status: 'active', admin_email: 'admin@lerirejaune.fr',
    admin_pwd_hash: sha256Hex('rire-pwd'), name: 'Le Rire Jaune', city: 'Paris', portal_code: 'RIREJ9',
  },
];

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

function mockClubsByEmailOrId(store) {
  return installFetchMock((call) => {
    if (!call.url.includes('/clubs') || call.method !== 'GET') return [];
    const em = call.url.match(/admin_email=eq\.([^&]+)/);
    if (em) return store.filter((c) => c.admin_email === decodeURIComponent(em[1]));
    const im = call.url.match(/id=eq\.([^&]+)/);
    if (im) return store.filter((c) => c.id === decodeURIComponent(im[1]));
    return [];
  });
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

// ════════════════════════════════════════════════════════════════════════
// api/admin-login.js — renvoie désormais l'identité réelle du club
// ════════════════════════════════════════════════════════════════════════

test('admin-login : deux clubs différents reçoivent chacun leur propre name/city/portal_code, jamais mélangés ni figés sur ceux du BCC', async () => {
  const mock = mockClubsByEmailOrId(CLUBS);
  const resA = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'bruce@bcc.fr', password: 'bruce-pwd' } }), resA);
  const resB = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'admin@lerirejaune.fr', password: 'rire-pwd' } }), resB);
  mock.restore();

  assert.equal(resA.statusCode, 200);
  assert.equal(resB.statusCode, 200);
  assert.equal(resA.body.club.name, 'Beer Comedy Club');
  assert.equal(resA.body.club.portal_code, 'BCCD25');
  assert.equal(resB.body.club.name, 'Le Rire Jaune');
  assert.equal(resB.body.club.portal_code, 'RIREJ9');
  assert.notEqual(resB.body.club.name, resA.body.club.name);
  assert.notEqual(resB.body.club.portal_code, resA.body.club.portal_code);
  assert.notEqual(resB.body.club.portal_code, 'BCCD25', 'le club B ne doit JAMAIS recevoir le code portail du BCC');
});

test('admin-login : dispo_deadline_day absent en base (colonne pas encore migrée sur cet environnement) → repli 15, connexion jamais bloquée', async () => {
  const mock = mockClubsByEmailOrId(CLUBS); // CLUBS n'ont pas de champ dispo_deadline_day
  const res = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'bruce@bcc.fr', password: 'bruce-pwd' } }), res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.dispo_deadline_day, 15);
});

// ════════════════════════════════════════════════════════════════════════
// api/admin-write.js — action 'updateClub' (bouton "Sauvegarder" de Réglages)
// ════════════════════════════════════════════════════════════════════════

test('updateClub : sauvegarde name/city pour le club authentifié, sans jamais toucher aux autres clubs', async () => {
  const store = JSON.parse(JSON.stringify(CLUBS));
  const mock = installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'PATCH') {
      const m = call.url.match(/id=eq\.([^&]+)/);
      const id = m && decodeURIComponent(m[1]);
      const row = store.find((c) => c.id === id);
      if (row) Object.assign(row, call.body);
      return [];
    }
    return [];
  });
  const token = issueAdminToken(SECOND_CLUB_ID).token;
  const req = fakeReq({ token, body: { action: 'updateClub', payload: { name: 'Le Rire Jaune Renommé', city: 'Lyon', dispo_deadline_day: 20 } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.club.name, 'Le Rire Jaune Renommé');

  const rowBcc = store.find((c) => c.id === BCC_CLUB_ID);
  const rowSecond = store.find((c) => c.id === SECOND_CLUB_ID);
  assert.equal(rowBcc.name, 'Beer Comedy Club', 'le BCC ne doit jamais être modifié par une écriture faite au nom d\'un autre club');
  assert.equal(rowSecond.name, 'Le Rire Jaune Renommé');
  assert.equal(rowSecond.city, 'Lyon');
});

test('updateClub : nom vide → 400, aucune écriture Supabase déclenchée', async () => {
  const mock = installFetchMock(() => []);
  const token = issueAdminToken(BCC_CLUB_ID).token;
  const req = fakeReq({ token, body: { action: 'updateClub', payload: { name: '   ' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
  assert.equal(mock.calls.length, 0);
});

test('updateClub : sans token → 401', async () => {
  const mock = installFetchMock(() => []);
  const req = fakeReq({ body: { action: 'updateClub', payload: { name: 'Peu importe' } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(mock.calls.length, 0);
});

test('updateClub : dispo_deadline_day hors bornes (1-28) → 400', async () => {
  const mock = installFetchMock(() => []);
  const token = issueAdminToken(BCC_CLUB_ID).token;
  const req = fakeReq({ token, body: { action: 'updateClub', payload: { name: 'BCC', dispo_deadline_day: 40 } } });
  const res = fakeRes();
  await adminWriteHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
});

// ════════════════════════════════════════════════════════════════════════
// index.html — applyClubInfo()/buildPortalLink() (logique CLIENT pure)
// ════════════════════════════════════════════════════════════════════════
// Même méthode que tests/schedule-grid-client.test.mjs : extrait le VRAI
// bloc shippé entre les marqueurs TEST-EXTRACT et l'exécute dans un sandbox
// Node (module vm), sans DOM (le bloc s'arrête tôt via
// `if (typeof document === 'undefined') return;`, testant ainsi
// exactement la logique d'état — currentCode/currentClub/buildPortalLink —
// indépendamment du rendu DOM).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function extractBlock(source, name) {
  const start = `// ── TEST-EXTRACT-START: ${name} ──`;
  const end = `// ── TEST-EXTRACT-END: ${name} ──`;
  const i = source.indexOf(start);
  const j = source.indexOf(end);
  assert.ok(i !== -1 && j !== -1 && j > i, `marqueurs TEST-EXTRACT "${name}" introuvables ou dans le mauvais ordre`);
  return source.slice(i + start.length, j);
}

const clubIdentityCode = extractBlock(indexHtml, 'club-identity');

function runClubIdentity(script) {
  const store = {};
  const sandbox = vm.createContext({
    localStorage: {
      setItem: (k, v) => { store[k] = String(v); },
      getItem: (k) => (k in store ? store[k] : null),
    },
  });
  vm.runInContext(clubIdentityCode + '\n' + script, sandbox);
  return sandbox;
}

test('applyClubInfo : avant tout login, repli sur l\'identité du BCC (comportement historique inchangé)', () => {
  const sandbox = runClubIdentity('this.__link = buildPortalLink(); this.__code = currentCode;');
  assert.equal(sandbox.__code, 'BCCD25');
  assert.match(sandbox.__link, /code=BCCD25$/);
});

test('applyClubInfo : un club non-BCC → currentCode devient son propre portal_code, le lien portail ne contient JAMAIS BCCD25', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'club-b', name: 'Le Rire Jaune', city: 'Paris', portal_code: 'RIREJ9', dispo_deadline_day: 20 });
    this.__link = buildPortalLink();
    this.__code = currentCode;
    this.__name = currentClub.name;
  `);
  assert.equal(sandbox.__code, 'RIREJ9');
  assert.equal(sandbox.__name, 'Le Rire Jaune');
  assert.match(sandbox.__link, /code=RIREJ9$/);
  assert.ok(!sandbox.__link.includes('BCCD25'), 'le lien portail d\'un club non-BCC ne doit jamais contenir BCCD25');
});

test('applyClubInfo : appelée deux fois pour deux clubs différents (ex. déconnexion/reconnexion sur le même navigateur) → la seconde identité remplace entièrement la première, aucun résidu', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'club-a', name: 'Club Alpha', city: 'Nice', portal_code: 'ALPHA1', dispo_deadline_day: 10 });
    const firstCode = currentCode, firstName = currentClub.name;
    applyClubInfo({ id: 'club-b', name: 'Club Beta', city: 'Nantes', portal_code: 'BETA22', dispo_deadline_day: 25 });
    this.__firstCode = firstCode; this.__firstName = firstName;
    this.__secondCode = currentCode; this.__secondName = currentClub.name;
    this.__link = buildPortalLink();
  `);
  assert.equal(sandbox.__firstCode, 'ALPHA1');
  assert.equal(sandbox.__secondCode, 'BETA22');
  assert.notEqual(sandbox.__firstName, sandbox.__secondName);
  assert.match(sandbox.__link, /code=BETA22$/);
  assert.ok(!sandbox.__link.includes('ALPHA1'));
  assert.ok(!sandbox.__link.includes('BCCD25'));
});

test('applyClubInfo : persiste currentCode en localStorage (survit à un rechargement de page tant que la session reste valide)', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'club-b', name: 'Le Rire Jaune', portal_code: 'RIREJ9' });
    this.__stored = localStorage.getItem('stagely_club_code');
  `);
  assert.equal(sandbox.__stored, 'RIREJ9');
});

console.log('\nTests correctif identité club terminés — voir le résumé du test runner ci-dessus (node --test).');
