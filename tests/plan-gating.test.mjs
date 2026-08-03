// ════════════════════════════════════════════════════════════════════════
// Tests — chantier "gating de palier" (essentiel/pro/réseau), 2026-08
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Règle produit tranchée par Chahine, couverte ici :
//  1. Pendant l'essai (clubs.status === 'trial'), accès COMPLET à toutes les
//     fonctionnalités existantes, quel que soit clubs.plan.
//  2. Une fois status === 'active', seul un plan 'pro' ou 'reseau' débloque
//     le chapeau + le tableau de bord financier (les SEULES fonctionnalités
//     Pro réellement construites à ce jour — cf. commentaires en tête de
//     api/admin-write.js et api/_lib.js).
//  3. computePlanAccess() (api/_lib.js) est LA source de vérité serveur,
//     jamais devinée côté client — admin-login.js/switch-club.js/
//     club-signup.js la relaient toutes dans leur réponse `club`.
//  4. hasProAccess() (index.html, même bloc TEST-EXTRACT club-identity que
//     applyClubInfo()) reproduit la même règle côté client, avec un repli
//     sûr (accès complet) si `status` est absent — cas d'une session déjà
//     ouverte AVANT ce chantier (ex. BCC), pour ne jamais régresser tant
//     qu'elle n'a pas rechargé une identité fraîche.
//
// Même méthode que les fichiers voisins (club-identity.test.mjs,
// multi-club-admin.test.mjs) : le VRAI code des handlers/extraits client est
// exécuté, fetch/localStorage sont mockés — aucun credential ni réseau réel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { computePlanAccess, issueAdminToken, sha256Hex } = await import('../api/_lib.js');
const adminLoginHandler = (await import('../api/admin-login.js')).default;
const switchClubHandler = (await import('../api/switch-club.js')).default;
const clubSignupHandler = (await import('../api/club-signup.js')).default;

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
// computePlanAccess() — pure function, api/_lib.js
// ════════════════════════════════════════════════════════════════════════

test('computePlanAccess : essai (trial) → accès complet quel que soit le plan', () => {
  assert.equal(computePlanAccess({ status: 'trial', plan: 'essentiel' }).proFeatures, true);
  assert.equal(computePlanAccess({ status: 'trial', plan: null }).proFeatures, true);
  assert.equal(computePlanAccess({ status: 'trial', plan: 'pro' }).proFeatures, true);
});

test('computePlanAccess : actif + essentiel → PAS d\'accès Pro', () => {
  const access = computePlanAccess({ status: 'active', plan: 'essentiel' });
  assert.equal(access.proFeatures, false);
  assert.equal(access.plan, 'essentiel');
  assert.equal(access.status, 'active');
});

test('computePlanAccess : actif + pro → accès Pro', () => {
  assert.equal(computePlanAccess({ status: 'active', plan: 'pro' }).proFeatures, true);
});

test('computePlanAccess : actif + reseau → accès Pro (le palier Réseau inclut tout Pro)', () => {
  assert.equal(computePlanAccess({ status: 'active', plan: 'reseau' }).proFeatures, true);
});

test('computePlanAccess : plan NULL/absent (colonne jamais renseignée) → traité comme \'essentiel\', jamais un accès Pro accordé par erreur', () => {
  const access = computePlanAccess({ status: 'active', plan: null });
  assert.equal(access.plan, 'essentiel');
  assert.equal(access.proFeatures, false);
});

test('computePlanAccess : club/status totalement absents → repli \'trial\'/\'essentiel\' (accès complet, jamais un crash)', () => {
  const access = computePlanAccess(null);
  assert.equal(access.status, 'trial');
  assert.equal(access.plan, 'essentiel');
  assert.equal(access.proFeatures, true);
});

// ════════════════════════════════════════════════════════════════════════
// api/admin-login.js — plan/status/pro_features relayés dans `club`
// ════════════════════════════════════════════════════════════════════════

const BCC_ADMIN_ID = 'admin-bruce-uuid';
const ESSENTIEL_ADMIN_ID = 'admin-essentiel-uuid';
const BCC_CLUB_ID = '00000000-0000-4000-a000-0000000000bc';
const ESSENTIEL_CLUB_ID = '55555555-5555-4555-a555-555555555555';

const ADMINS = [
  { id: BCC_ADMIN_ID, email: 'bruce@bcc.fr', password_hash: sha256Hex('bruce-pwd') },
  { id: ESSENTIEL_ADMIN_ID, email: 'admin@essentiel-club.fr', password_hash: sha256Hex('ess-pwd') },
];
const LINKS = [
  { admin_id: BCC_ADMIN_ID, club_id: BCC_CLUB_ID },
  { admin_id: ESSENTIEL_ADMIN_ID, club_id: ESSENTIEL_CLUB_ID },
];
// BCC : actif, palier fondateur 'pro' (cohérent avec le tarif fondateur déjà
// décidé, qui inclut implicitement tout le palier Pro).
// Club B : actif, palier 'essentiel' (n'a pas encore débloqué le Pro).
const CLUBS = [
  { id: BCC_CLUB_ID, status: 'active', plan: 'pro', name: 'Beer Comedy Club', city: 'Lille', portal_code: 'BCCD25' },
  { id: ESSENTIEL_CLUB_ID, status: 'active', plan: 'essentiel', name: 'Club Essentiel', city: 'Metz', portal_code: 'ESSE01' },
];

function mockClubsByEmailOrId(clubsStore) {
  return installFetchMock((call) => {
    if (call.url.includes('/admins') && call.method === 'GET') {
      const em = call.url.match(/email=eq\.([^&]+)/);
      if (em) return ADMINS.filter((a) => a.email === decodeURIComponent(em[1]));
      return [];
    }
    if (call.url.includes('/admin_club_links') && call.method === 'GET') {
      const am = call.url.match(/admin_id=eq\.([^&]+)/);
      if (am) return LINKS.filter((l) => l.admin_id === decodeURIComponent(am[1]));
      return [];
    }
    if (!call.url.includes('/clubs') || call.method !== 'GET') return [];
    const idIn = call.url.match(/id=in\.\(([^)]+)\)/);
    if (idIn) {
      const ids = idIn[1].split(',').map(decodeURIComponent);
      return clubsStore.filter((c) => ids.includes(c.id));
    }
    const im = call.url.match(/id=eq\.([^&]+)/);
    if (im) return clubsStore.filter((c) => c.id === decodeURIComponent(im[1]));
    return [];
  });
}

test('admin-login : BCC (actif, palier fondateur pro) → pro_features = true', async () => {
  const mock = mockClubsByEmailOrId(CLUBS);
  const res = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'bruce@bcc.fr', password: 'bruce-pwd' } }), res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.plan, 'pro');
  assert.equal(res.body.club.status, 'active');
  assert.equal(res.body.club.pro_features, true);
});

test('admin-login : club actif au palier essentiel → pro_features = false (chapeau/dashboard financier masqués)', async () => {
  const mock = mockClubsByEmailOrId(CLUBS);
  const res = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'admin@essentiel-club.fr', password: 'ess-pwd' } }), res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.plan, 'essentiel');
  assert.equal(res.body.club.pro_features, false);
});

test('admin-login : club en essai (peu importe plan) → pro_features = true', async () => {
  const trialClubs = [{ id: ESSENTIEL_CLUB_ID, status: 'trial', plan: 'essentiel', name: 'Nouveau Club', city: 'Metz', portal_code: 'ESSE01' }];
  const mock = mockClubsByEmailOrId(trialClubs);
  const res = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'admin@essentiel-club.fr', password: 'ess-pwd' } }), res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.status, 'trial');
  assert.equal(res.body.club.pro_features, true, 'essai = accès complet, même palier essentiel');
});

test('admin-login : colonne `plan` absente en base (migration pas encore appliquée sur cet environnement) → repli \'essentiel\', connexion jamais bloquée', async () => {
  // Simule l'environnement où la sélection avec plan/trial_ends_at échoue
  // (colonne inconnue) — seul le repli (sans plan) répond, même garde que
  // dispo_deadline_day déjà en place avant ce chantier.
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/admins')) return { ok: true, json: async () => ADMINS.filter((a) => a.email === 'bruce@bcc.fr') };
    if (url.includes('/admin_club_links')) return { ok: true, json: async () => LINKS.filter((l) => l.admin_id === BCC_ADMIN_ID) };
    if (url.includes('/clubs')) {
      if (url.includes('plan')) return { ok: false, status: 400, text: async () => 'column clubs.plan does not exist' };
      return { ok: true, json: async () => [{ id: BCC_CLUB_ID, status: 'active', name: 'Beer Comedy Club', city: 'Lille', portal_code: 'BCCD25' }] };
    }
    return { ok: true, json: async () => [] };
  };
  const res = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'bruce@bcc.fr', password: 'bruce-pwd' } }), res);
  globalThis.fetch = original;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.plan, 'essentiel', 'repli sûr — jamais un accès Pro accordé par défaut si la colonne manque');
  assert.equal(res.body.club.status, 'active');
  assert.equal(res.body.club.pro_features, false);
});

// ════════════════════════════════════════════════════════════════════════
// api/switch-club.js — même relais plan/status/pro_features au switch
// ════════════════════════════════════════════════════════════════════════

test('switch-club : bascule vers un club essentiel actif → pro_features = false (revérifié en base, jamais depuis le token)', async () => {
  const token = issueAdminToken(
    ESSENTIEL_ADMIN_ID,
    [{ id: ESSENTIEL_CLUB_ID, name: 'Club Essentiel' }],
    ESSENTIEL_CLUB_ID
  ).token;
  const mock = installFetchMock((call) => {
    if (call.url.includes('/admin_club_links')) return [{ club_id: ESSENTIEL_CLUB_ID }];
    if (call.url.includes('/clubs')) return CLUBS.filter((c) => c.id === ESSENTIEL_CLUB_ID);
    return [];
  });
  const res = fakeRes();
  await switchClubHandler(fakeReq({ token, body: { club_id: ESSENTIEL_CLUB_ID } }), res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.pro_features, false);
});

test('switch-club : bascule vers BCC (pro) → pro_features = true', async () => {
  const token = issueAdminToken(BCC_ADMIN_ID, [{ id: BCC_CLUB_ID, name: 'BCC' }], BCC_CLUB_ID).token;
  const mock = installFetchMock((call) => {
    if (call.url.includes('/admin_club_links')) return [{ club_id: BCC_CLUB_ID }];
    if (call.url.includes('/clubs')) return CLUBS.filter((c) => c.id === BCC_CLUB_ID);
    return [];
  });
  const res = fakeRes();
  await switchClubHandler(fakeReq({ token, body: { club_id: BCC_CLUB_ID } }), res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.plan, 'pro');
  assert.equal(res.body.club.pro_features, true);
});

// ════════════════════════════════════════════════════════════════════════
// api/club-signup.js — un nouveau club naît toujours en essai + essentiel
// ════════════════════════════════════════════════════════════════════════

test('club-signup : nouvelle inscription complète → plan=essentiel, status=trial, pro_features=true (essai = accès complet dès le 1er jour)', async () => {
  const mock = installFetchMock((call) => {
    if (call.url.includes('/admins') && call.method === 'GET') return []; // email pas encore pris
    return []; // POST admins/clubs/rooms/admin_club_links -> succès par défaut
  });
  const res = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Le Nouveau Club', city: 'Reims', email: 'contact@nouveau-club.fr', password: 'motdepasse123' } }), res);
  mock.restore();
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.club.plan, 'essentiel');
  assert.equal(res.body.club.status, 'trial');
  assert.equal(res.body.club.pro_features, true);
});

// ════════════════════════════════════════════════════════════════════════
// index.html — hasProAccess()/applyClubInfo() (logique CLIENT pure)
// ════════════════════════════════════════════════════════════════════════
// Même méthode que tests/club-identity.test.mjs : extrait le VRAI bloc
// shippé entre les marqueurs TEST-EXTRACT "club-identity" (qui couvre
// maintenant aussi hasProAccess()/currentClub.plan/status) et l'exécute dans
// un sandbox Node (module vm), sans DOM.

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

test('hasProAccess : club essai (trial) + plan essentiel → true (accès complet pendant l\'essai)', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'c1', name: 'X', portal_code: 'X1', status: 'trial', plan: 'essentiel' });
    this.__pro = hasProAccess();
  `);
  assert.equal(sandbox.__pro, true);
});

test('hasProAccess : club actif + plan essentiel → false (chapeau/dashboard financier masqués)', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'c1', name: 'X', portal_code: 'X1', status: 'active', plan: 'essentiel' });
    this.__pro = hasProAccess();
  `);
  assert.equal(sandbox.__pro, false);
});

test('hasProAccess : club actif + plan pro → true', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'c1', name: 'X', portal_code: 'X1', status: 'active', plan: 'pro' });
    this.__pro = hasProAccess();
  `);
  assert.equal(sandbox.__pro, true);
});

test('hasProAccess : club actif + plan reseau → true', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'c1', name: 'X', portal_code: 'X1', status: 'active', plan: 'reseau' });
    this.__pro = hasProAccess();
  `);
  assert.equal(sandbox.__pro, true);
});

test('hasProAccess : status/plan absents (session localStorage mise en cache AVANT ce chantier) → true, jamais de régression pour une session déjà ouverte', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'c1', name: 'X', portal_code: 'X1' }); // pas de status/plan, comme un vieux blob de session
    this.__pro = hasProAccess();
  `);
  assert.equal(sandbox.__pro, true);
});

test('applyClubInfo : un appel avec un objet partiel (ex. saveClubSettings, qui ne renvoie que name/city/deadline) ne doit JAMAIS effacer le plan/status déjà connus', () => {
  const sandbox = runClubIdentity(`
    applyClubInfo({ id: 'c1', name: 'Club Essentiel', portal_code: 'X1', status: 'active', plan: 'essentiel' });
    const proBefore = hasProAccess();
    // Appel partiel typique de saveClubSettings() — pas de plan/status dans le payload
    applyClubInfo({ id: 'c1', name: 'Club Essentiel Renommé', city: 'Lyon', portal_code: 'X1', dispo_deadline_day: 20 });
    this.__proBefore = proBefore;
    this.__proAfter = hasProAccess();
    this.__plan = currentClub.plan;
    this.__status = currentClub.status;
  `);
  assert.equal(sandbox.__proBefore, false);
  assert.equal(sandbox.__proAfter, false, 'le plan doit rester essentiel après un appel partiel, pas retomber sur un défaut permissif');
  assert.equal(sandbox.__plan, 'essentiel');
  assert.equal(sandbox.__status, 'active');
});

console.log('\nTests gating de palier terminés — voir le résumé du test runner ci-dessus (node --test).');
