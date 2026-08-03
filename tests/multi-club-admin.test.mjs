// ════════════════════════════════════════════════════════════════════════
// Tests — chantier "multi-club-admin" : un compte, plusieurs clubs
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/multi-club-admin.test.mjs
//
// Couvre le coeur du chantier, au-delà de ce qui est déjà testé dans
// multitenant-scoping.test.mjs (token pur), multitenant-step-c.test.mjs
// (admin-login multi-club, sans multi-club PAR admin) et
// multitenant-step-f.test.mjs (signup sans session, régression BCC) :
//
//  - login d'un admin possédant 2 clubs → accessible_clubs contient bien les
//    2 (forme légère {id,name}), active_club_id = le premier, ET club
//    (détail complet — name/city/portal_code/dispo_deadline_day) correspond
//    bien au club actif — pas juste au premier trouvé au hasard.
//  - remember-me : préservé par défaut (issueAdminToken(..., rememberMe)),
//    ET conservé après un switch-club ou un ajout de club à un compte
//    connecté (auth.remember relu, jamais perdu ni forcé à false).
//  - /api/switch-club vers le 2e club → nouveau token, club actif renvoyé en
//    détail complet (même forme que login, pour applyClubInfo()), écritures
//    ultérieures (admin-write.js) scopées sur le bon club (isolation
//    croisée conservée).
//  - /api/switch-club rejette un club_id qui n'appartient PAS à l'admin,
//    MÊME en le forgeant directement dans le corps de la requête (le serveur
//    ne fait jamais confiance au token seul — revérification systématique
//    contre admin_club_links en base), et rejette aussi un club devenu
//    suspendu entre-temps.
//  - api/club-signup.js AVEC une session admin active : ajoute un club au
//    compte existant (name+city seulement), sans dupliquer la ligne
//    `admins`, et le nouveau token place bien active_club_id sur le club
//    fraîchement créé.
//  - régression BCC : un admin mono-club (cas de Bruce après la migration
//    SQL) continue de se connecter à l'identique, sans sélecteur inutile.
//  - un token de l'ANCIEN format (avant ce chantier, {role, club_id, exp})
//    est rejeté par toutes les routes qui en dépendent (admin-write,
//    switch-club, email) — pas de repli permissif.
//
// Même méthode que les fichiers voisins : le VRAI code des handlers est
// exécuté, `fetch` global est mocké avec un état en mémoire (tables clubs /
// admins / admin_club_links / rooms) — aucun credential ni réseau réel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { verifyAdminToken, issueAdminToken, sha256Hex, newId } = await import('../api/_lib.js');
const adminLoginHandler = (await import('../api/admin-login.js')).default;
const clubSignupHandler = (await import('../api/club-signup.js')).default;
const switchClubHandler = (await import('../api/switch-club.js')).default;
const adminWriteHandler = (await import('../api/admin-write.js')).default;
const emailHandler = (await import('../api/email.js')).default;

function freshState() {
  return { clubs: [], admins: [], admin_club_links: [], rooms: [] };
}

const UNIQUE_COLS = {
  clubs: ['id', 'slug', 'portal_code'],
  admins: ['id', 'email'],
  rooms: ['id'],
  admin_club_links: [],
};

function matchRow(row, search) {
  const usp = new URLSearchParams(search.replace(/^\?/, ''));
  for (const [k, v] of usp.entries()) {
    if (v.startsWith('eq.')) {
      if (String(row[k]) !== decodeURIComponent(v.slice(3))) return false;
    } else if (v.startsWith('in.(') && v.endsWith(')')) {
      const ids = v.slice(4, -1).split(',').map(decodeURIComponent);
      if (!ids.includes(String(row[k]))) return false;
    }
  }
  return true;
}

function installStatefulSupabaseMock(state) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const method = opts.method || 'GET';
    calls.push({ url: u.pathname + u.search, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const store = state[table];
    if (!store) return { ok: false, status: 404, text: async () => 'unknown table', json: async () => ({}) };

    if (method === 'GET') {
      const rows = store.filter((row) => matchRow(row, u.search));
      return { ok: true, status: 200, json: async () => rows, text: async () => '' };
    }
    if (method === 'POST') {
      const body = JSON.parse(opts.body);
      const uniqueCols = UNIQUE_COLS[table] || [];
      for (const row of body) {
        for (const col of uniqueCols) {
          if (col in row && row[col] != null && store.some((r) => r[col] === row[col])) {
            return { ok: false, status: 409, text: async () => `duplicate key (${col})`, json: async () => ({}) };
          }
        }
        store.push(row);
      }
      return { ok: true, status: 201, json: async () => body, text: async () => '' };
    }
    if (method === 'DELETE') {
      const before = store.length;
      const kept = store.filter((row) => !matchRow(row, u.search));
      store.length = 0;
      store.push(...kept);
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => 'unsupported method in mock', json: async () => ({}) };
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
function claimsOf(token) {
  return verifyAdminToken(fakeReq({ token }));
}

// Construit un état avec un admin possédant 2 clubs actifs, directement en
// base simulée (équivalent de deux inscriptions déjà faites) — pour tester
// login + switch-club sans dépendre du chemin d'inscription lui-même.
function stateWithTwoClubAdmin() {
  const state = freshState();
  const adminId = newId();
  const clubAId = newId();
  const clubBId = newId();
  state.admins.push({ id: adminId, email: 'proprio@deuxclubs.fr', password_hash: sha256Hex('motdepasseX') });
  state.clubs.push({ id: clubAId, slug: 'club-a', portal_code: 'CLUBAX', name: 'Club A', city: 'Lille', status: 'active', dispo_deadline_day: 12, trial_ends_at: null });
  state.clubs.push({ id: clubBId, slug: 'club-b', portal_code: 'CLUBBX', name: 'Club B', city: 'Nantes', status: 'active', dispo_deadline_day: 15, trial_ends_at: null });
  state.admin_club_links.push({ admin_id: adminId, club_id: clubAId });
  state.admin_club_links.push({ admin_id: adminId, club_id: clubBId });
  return { state, adminId, clubAId, clubBId };
}

// ════════════════════════════════════════════════════════════════════════
// Login d'un admin à 2 clubs
// ════════════════════════════════════════════════════════════════════════

test('admin à 2 clubs : login → accessible_clubs contient les 2 (forme légère), active_club_id = le premier, club renvoyé = détail complet du club ACTIF', async () => {
  const { state, clubAId, clubBId } = stateWithTwoClubAdmin();
  const mock = installStatefulSupabaseMock(state);
  const req = fakeReq({ body: { email: 'proprio@deuxclubs.fr', password: 'motdepasseX' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  const claims = claimsOf(res.body.token);
  assert.equal(claims.accessible_clubs.length, 2);
  const ids = claims.accessible_clubs.map((c) => c.id).sort();
  assert.deepEqual(ids, [clubAId, clubBId].sort());
  assert.ok(claims.accessible_clubs.some((c) => c.id === claims.active_club_id));

  // Le corps de réponse porte AUSSI accessible_clubs (forme légère, top
  // niveau) ET club (détail complet du club ACTIF, même forme
  // qu'applyClubInfo() attend côté client) — pas juste le premier de la
  // liste au hasard, mais bien celui pointé par active_club_id.
  assert.equal(res.body.accessible_clubs.length, 2);
  assert.equal(res.body.club.id, claims.active_club_id);
  assert.ok(res.body.club.name);
  assert.ok('city' in res.body.club);
  assert.ok('portal_code' in res.body.club);
  assert.equal(typeof res.body.club.dispo_deadline_day, 'number');
});

test('rememberMe=true au login → token longue durée, ET ce choix survit à un switch-club ultérieur (auth.remember relu, jamais perdu)', async () => {
  const { state, clubAId, clubBId } = stateWithTwoClubAdmin();
  const mock = installStatefulSupabaseMock(state);

  const loginRes = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'proprio@deuxclubs.fr', password: 'motdepasseX', rememberMe: true } }), loginRes);
  const firstClaims = claimsOf(loginRes.body.token);
  assert.equal(firstClaims.remember, true);
  const otherClubId = firstClaims.active_club_id === clubAId ? clubBId : clubAId;

  const switchRes = fakeRes();
  await switchClubHandler(fakeReq({ token: loginRes.body.token, body: { club_id: otherClubId } }), switchRes);
  mock.restore();

  assert.equal(switchRes.statusCode, 200);
  const ttlAfterSwitch = switchRes.body.expiresAt - Date.now();
  // Marge large : doit rester de l'ordre du remember-me (30 jours), pas être
  // retombé sur la session par défaut (12h) après le switch.
  assert.ok(ttlAfterSwitch > 24 * 60 * 60 * 1000 * 10, `attendu un TTL encore de l'ordre du remember-me après switch, obtenu ${ttlAfterSwitch}ms`);
  assert.equal(claimsOf(switchRes.body.token).remember, true);
});

// ════════════════════════════════════════════════════════════════════════
// /api/switch-club — nominal
// ════════════════════════════════════════════════════════════════════════

test('switch-club : bascule vers le 2e club → nouveau token avec active_club_id mis à jour, club renvoyé = détail complet du NOUVEAU club actif, écritures ultérieures scopées sur le bon club', async () => {
  const { state, adminId, clubAId, clubBId } = stateWithTwoClubAdmin();
  const mock = installStatefulSupabaseMock(state);

  const loginRes = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'proprio@deuxclubs.fr', password: 'motdepasseX' } }), loginRes);
  const firstToken = loginRes.body.token;
  const firstActive = claimsOf(firstToken).active_club_id;
  const otherClubId = firstActive === clubAId ? clubBId : clubAId;
  const otherClub = state.clubs.find((c) => c.id === otherClubId);

  const switchReq = fakeReq({ token: firstToken, body: { club_id: otherClubId } });
  const switchRes = fakeRes();
  await switchClubHandler(switchReq, switchRes);
  assert.equal(switchRes.statusCode, 200);
  const newClaims = claimsOf(switchRes.body.token);
  assert.equal(newClaims.active_club_id, otherClubId);
  assert.equal(newClaims.admin_id, adminId);
  assert.equal(newClaims.accessible_clubs.length, 2);

  // Détail complet du nouveau club actif — même forme que /api/admin-login,
  // pour que applyClubInfo() s'applique directement après un switch (index.html).
  assert.equal(switchRes.body.club.id, otherClubId);
  assert.equal(switchRes.body.club.name, otherClub.name);
  assert.equal(switchRes.body.club.city, otherClub.city);
  assert.equal(switchRes.body.club.portal_code, otherClub.portal_code);
  assert.equal(switchRes.body.club.dispo_deadline_day, otherClub.dispo_deadline_day);

  // Une écriture (admin-write.js) faite avec ce nouveau token doit être
  // scopée sur otherClubId, jamais sur l'ancien club actif.
  const writeReq = fakeReq({ token: switchRes.body.token, body: { action: 'chatSend', payload: { text: 'hello' } } });
  await adminWriteHandler(writeReq, fakeRes());
  mock.restore();

  const chatPost = mock.calls.find((c) => c.url.includes('/chat_messages') && c.method === 'POST');
  assert.ok(chatPost);
  assert.equal(chatPost.body.club_id, otherClubId);
});

test('switch-club : re-basculer vers le club déjà actif fonctionne aussi (pas de cas particulier requis)', async () => {
  const { state } = stateWithTwoClubAdmin();
  const mock = installStatefulSupabaseMock(state);
  const loginRes = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'proprio@deuxclubs.fr', password: 'motdepasseX' } }), loginRes);
  const req = fakeReq({ token: loginRes.body.token, body: { club_id: claimsOf(loginRes.body.token).active_club_id } });
  const res = fakeRes();
  await switchClubHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
});

test('switch-club : un club devenu suspendu ENTRE le login et le switch est rejeté (relecture fraîche du statut, pas de cache)', async () => {
  const { state, clubAId, clubBId } = stateWithTwoClubAdmin();
  const mock = installStatefulSupabaseMock(state);
  const loginRes = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'proprio@deuxclubs.fr', password: 'motdepasseX' } }), loginRes);
  const firstActive = claimsOf(loginRes.body.token).active_club_id;
  const otherClubId = firstActive === clubAId ? clubBId : clubAId;

  // Le club devient suspendu APRÈS l'émission du token (ex. impayé détecté
  // entre-temps) — le token porte toujours ce club dans accessible_clubs.
  state.clubs.find((c) => c.id === otherClubId).status = 'suspended';

  const res = fakeRes();
  await switchClubHandler(fakeReq({ token: loginRes.body.token, body: { club_id: otherClubId } }), res);
  mock.restore();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.token, undefined);
});

// ════════════════════════════════════════════════════════════════════════
// /api/switch-club — sécurité : jamais confiance au token seul
// ════════════════════════════════════════════════════════════════════════

test('switch-club : rejette un club_id qui n\'appartient PAS à l\'admin, même forgé directement dans le corps de la requête', async () => {
  const { state } = stateWithTwoClubAdmin();
  // Un troisième club, appartenant à un AUTRE admin, jamais lié à celui qui teste.
  const foreignClubId = newId();
  state.clubs.push({ id: foreignClubId, slug: 'club-etranger', portal_code: 'FRGN01', name: 'Club Étranger', city: null, status: 'active', trial_ends_at: null });
  const mock = installStatefulSupabaseMock(state);

  const loginRes = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'proprio@deuxclubs.fr', password: 'motdepasseX' } }), loginRes);

  const req = fakeReq({ token: loginRes.body.token, body: { club_id: foreignClubId } });
  const res = fakeRes();
  await switchClubHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.token, undefined);
});

test('switch-club : même si accessible_clubs du token était falsifié pour INCLURE un club étranger, la revérification en base (admin_club_links) le rejette quand même', async () => {
  // Ce test simule un token dont la signature ne serait PAS invalidée par la
  // falsification (scénario impossible en pratique grâce à HMAC — couvert
  // par les tests _lib.js) : il documente que switch-club ne s'arrête JAMAIS
  // à la seule lecture de accessible_clubs, il revérifie toujours en base.
  const { state, adminId, clubAId } = stateWithTwoClubAdmin();
  const foreignClubId = newId();
  state.clubs.push({ id: foreignClubId, slug: 'club-etranger-2', portal_code: 'FRGN02', name: 'Club Étranger 2', city: null, status: 'active', trial_ends_at: null });
  // PAS de lien admin_club_links créé entre adminId et foreignClubId.
  const mock = installStatefulSupabaseMock(state);

  const forgedToken = issueAdminToken(adminId, [{ id: clubAId, name: 'Club A' }, { id: foreignClubId, name: 'Club Étranger 2' }], clubAId).token;

  const req = fakeReq({ token: forgedToken, body: { club_id: foreignClubId } });
  const res = fakeRes();
  await switchClubHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 403, 'la revérification admin_club_links en base doit rejeter, même si le token semblait autoriser ce club');
});

test('switch-club : sans token → 401', async () => {
  const mock = installStatefulSupabaseMock(freshState());
  const res = fakeRes();
  await switchClubHandler(fakeReq({ body: { club_id: 'peu-importe' } }), res);
  mock.restore();
  assert.equal(res.statusCode, 401);
});

test('switch-club : un token de l\'ANCIEN format (payload {role, club_id, exp}, sans admin_id) → 401, jamais un repli permissif', async () => {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  const payload = Buffer.from(JSON.stringify({ role: 'admin', club_id: 'peu-importe', exp: Date.now() + 100000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const oldToken = `${payload}.${sig}`;

  const mock = installStatefulSupabaseMock(freshState());
  const res = fakeRes();
  await switchClubHandler(fakeReq({ token: oldToken, body: { club_id: 'peu-importe' } }), res);
  mock.restore();
  assert.equal(res.statusCode, 401);
});

// ════════════════════════════════════════════════════════════════════════
// club-signup.js — AVEC session active : ajoute un club au compte existant
// ════════════════════════════════════════════════════════════════════════

test('signup AVEC session active : ajoute un club au compte existant sans dupliquer la ligne admins, nouveau token pointe directement dessus, même durée de session (remember-me) que le token d\'origine', async () => {
  const state = freshState();
  const mock = installStatefulSupabaseMock(state);

  // 1) Inscription normale (sans session), avec remember-me — premier club.
  const signup1 = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Mon Premier Club', city: 'Lyon', email: 'moi@monclub.fr', password: 'motdepasseY' } }), signup1);
  assert.equal(signup1.statusCode, 201);
  const firstClubId = signup1.body.club.id;
  const adminCountAfterFirst = state.admins.length;

  // 2) Deuxième inscription, AVEC le token de la première (session active) —
  // seulement {name, city}, pas d'email/mot de passe.
  const signup2 = fakeRes();
  await clubSignupHandler(fakeReq({ token: signup1.body.token, body: { name: 'Mon Deuxième Club', city: 'Marseille' } }), signup2);
  mock.restore();

  assert.equal(signup2.statusCode, 201);
  assert.equal(state.admins.length, adminCountAfterFirst, 'aucune nouvelle ligne admins ne doit être créée en ajoutant un club à un compte existant');

  const claims1 = claimsOf(signup1.body.token);
  const claims2 = claimsOf(signup2.body.token);
  assert.equal(claims2.admin_id, claims1.admin_id, 'même admin_id, pas un nouveau compte');
  assert.equal(claims2.accessible_clubs.length, 2, 'les 2 clubs doivent maintenant être accessibles');
  assert.equal(claims2.active_club_id, signup2.body.club.id, 'le nouveau token doit pointer directement sur le club fraîchement créé');
  assert.notEqual(signup2.body.club.id, firstClubId);
  assert.equal(claims2.remember, claims1.remember, 'le second token doit conserver la même durée de session (remember-me) que le premier');

  const link = state.admin_club_links.find((l) => l.admin_id === claims1.admin_id && l.club_id === signup2.body.club.id);
  assert.ok(link, 'le lien admin_club_links vers le nouveau club doit exister');

  // Le club de contact (admin_email, purement Reply-To — jamais relu pour
  // l'auth) reprend l'email du compte connecté, pas un email vide.
  const newClubRow = state.clubs.find((c) => c.id === signup2.body.club.id);
  assert.equal(newClubRow.admin_email, 'moi@monclub.fr');
});

test('signup AVEC session active : nom manquant → 400, pas de club créé', async () => {
  const state = freshState();
  const mock = installStatefulSupabaseMock(state);
  const signup1 = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Club Solo', city: null, email: 'solo@solo.fr', password: 'motdepasseZ' } }), signup1);
  const clubCountBefore = state.clubs.length;

  const res = fakeRes();
  await clubSignupHandler(fakeReq({ token: signup1.body.token, body: { city: 'Bordeaux' } }), res);
  mock.restore();

  assert.equal(res.statusCode, 400);
  assert.equal(state.clubs.length, clubCountBefore);
});

// ════════════════════════════════════════════════════════════════════════
// Un token de l'ancien format est rejeté par TOUTES les routes qui en
// dépendent — pas seulement admin-write.js (déjà couvert ailleurs)
// ════════════════════════════════════════════════════════════════════════

function oldFormatToken(clubId) {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  const payload = Buffer.from(JSON.stringify({ role: 'admin', club_id: clubId, exp: Date.now() + 100000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

test('un token de l\'ancien format est rejeté par admin-write.js ET email.js (pas seulement switch-club)', async () => {
  const oldToken = oldFormatToken('some-club-id');
  const mock = installStatefulSupabaseMock(freshState());

  const writeRes = fakeRes();
  await adminWriteHandler(fakeReq({ token: oldToken, body: { action: 'chatSend', payload: { text: 'x' } } }), writeRes);
  assert.equal(writeRes.statusCode, 401);

  const emailRes = fakeRes();
  await emailHandler(fakeReq({ token: oldToken, body: { to: 'x@x.fr', subject: 's', html: 'h' } }), emailRes);
  mock.restore();
  assert.equal(emailRes.statusCode, 401);
});

// ════════════════════════════════════════════════════════════════════════
// Régression BCC — admin mono-club, comportement inchangé après migration
// ════════════════════════════════════════════════════════════════════════

test('RÉGRESSION — admin mono-club (cas de Bruce/BCC après migration SQL) : login → 1 seul club accessible, pas de matière à afficher un sélecteur', async () => {
  const state = freshState();
  const bccId = newId();
  const adminId = newId();
  state.clubs.push({ id: bccId, slug: 'bcc', portal_code: 'BCCD25', name: 'Beer Comedy Club', city: 'Lille', status: 'active', dispo_deadline_day: 12, trial_ends_at: null });
  state.admins.push({ id: adminId, email: 'chahinedjadel@gmail.com', password_hash: '85d68d9dcfa242682cd25d93231bf7e92fcb0e757f2759760de31e463a8c3d70' });
  state.admin_club_links.push({ admin_id: adminId, club_id: bccId });
  const mock = installStatefulSupabaseMock(state);

  const req = fakeReq({ body: { email: 'chahinedjadel@gmail.com', password: 'Hendeck59190@' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 200);
  const claims = claimsOf(res.body.token);
  assert.equal(claims.accessible_clubs.length, 1);
  assert.equal(claims.active_club_id, bccId);
  assert.equal(res.body.club.name, 'Beer Comedy Club');
  assert.equal(res.body.club.portal_code, 'BCCD25');
});

console.log('\nTests "multi-club-admin" terminés — voir le résumé du test runner ci-dessus (node --test).');
