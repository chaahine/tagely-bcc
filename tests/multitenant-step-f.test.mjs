// ════════════════════════════════════════════════════════════════════════
// Tests — chantier multitenant, étape F (inscription self-service + login
// généralisé par email)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/multitenant-step-f.test.mjs
//
// Couvre les deux routes changées/ajoutées à l'étape F, mises à jour pour le
// chantier "multi-club-admin" (voir tests/multi-club-admin.test.mjs pour la
// couverture spécifique multi-club/switch-club) :
//  - api/admin-login.js : résout désormais l'admin par `admins.email` (au
//    lieu du slug 'bcc' en dur, puis de clubs.admin_email) — accepte {email,
//    password}, message générique identique que l'email ou le mot de passe
//    soit faux, vérifie status != 'suspended' sur le(s) club(s) accessibles.
//  - api/club-signup.js (chemin SANS session, comportement d'origine) :
//    inscription self-service — validation, unicité de l'email (désormais
//    dans `admins`), génération slug/portal_code avec retry sur collision,
//    création de la salle par défaut, auto-connexion.
//
// Même méthode que les fichiers voisins (multitenant-scoping.test.mjs,
// multitenant-step-c.test.mjs) : le VRAI code des handlers est exécuté,
// `fetch` global est mocké — aucun credential ni réseau réel, et surtout
// AUCUNE donnée de la vraie base Supabase de prod n'est jamais touchée par
// ces tests.
//
// Différence avec les mocks des fichiers voisins : ceux-ci renvoient une
// réponse figée par requête. Ça ne suffit pas ici : club-signup.js enchaîne
// plusieurs lectures/écritures dont le résultat doit dépendre de ce qui a
// déjà été inséré par un appel précédent (retry de collision sur
// slug/portal_code, unicité de l'email). Le mock ci-dessous simule donc un
// vrai état — quatre tables en mémoire (`admins`, `admin_club_links`,
// `clubs`, `rooms`) avec les mêmes contraintes UNIQUE que le schéma réel
// (admins.id/email, clubs.id/slug/portal_code) — plutôt que des réponses
// figées.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { verifyAdminToken, sha256Hex, BCC_CLUB_ID } = await import('../api/_lib.js');
const adminLoginHandler = (await import('../api/admin-login.js')).default;
const clubSignupHandler = (await import('../api/club-signup.js')).default;

// ── BCC réel : même hash que la migration étape C (sha256('Hendeck59190@')),
// pour que la régression testée ici corresponde vraiment aux identifiants de
// Bruce en prod, pas à un mot de passe de test générique. ──
const BCC_ADMIN_EMAIL = 'chahinedjadel@gmail.com';
const BCC_ADMIN_PWD_HASH = '85d68d9dcfa242682cd25d93231bf7e92fcb0e757f2759760de31e463a8c3d70';
const BCC_ADMIN_ID = 'admin-bruce-uuid';

function freshState() {
  return {
    admins: [{ id: BCC_ADMIN_ID, email: BCC_ADMIN_EMAIL, password_hash: BCC_ADMIN_PWD_HASH }],
    admin_club_links: [{ admin_id: BCC_ADMIN_ID, club_id: BCC_CLUB_ID }],
    clubs: [{
      id: BCC_CLUB_ID, slug: 'bcc', portal_code: 'BCCD25', name: 'Beer Comedy Club', city: 'Lille',
      status: 'active', trial_ends_at: null,
    }],
    rooms: [],
  };
}

const UNIQUE_COLS = {
  admins: ['id', 'email'],
  clubs: ['id', 'slug', 'portal_code'],
  rooms: ['id'],
  admin_club_links: [],
};

// ── Mock Supabase stateful générique — 4 tables en mémoire, GET filtre par
// eq./in. générique (peu importe la colonne), POST insère en simulant les
// contraintes UNIQUE réelles. ──
function installStatefulSupabaseMock(state) {
  const original = globalThis.fetch;
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
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const method = opts.method || 'GET';
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
            return {
              ok: false,
              status: 409,
              text: async () => `duplicate key value violates unique constraint "x_${col}_key" - Key (${col})=(${row[col]}) already exists.`,
              json: async () => ({}),
            };
          }
        }
        store.push(row);
      }
      return { ok: true, status: 201, json: async () => body, text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => 'unsupported method in mock', json: async () => ({}) };
  };
  return { restore: () => { globalThis.fetch = original; } };
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
function tokenClubId(token) {
  const claims = verifyAdminToken(fakeReq({ token }));
  return claims && claims.active_club_id;
}

// ════════════════════════════════════════════════════════════════════════
// admin-login.js — résolution par admins.email
// ════════════════════════════════════════════════════════════════════════

test('RÉGRESSION — login BCC avec l\'email et le mot de passe réels de Bruce → 200, club_id = BCC_CLUB_ID inchangé', async () => {
  const mock = installStatefulSupabaseMock(freshState());
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL, password: 'Hendeck59190@' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(tokenClubId(res.body.token), BCC_CLUB_ID);
  assert.equal(res.body.accessible_clubs.length, 1, 'Bruce (BCC) a un seul club — pas de matière à afficher un sélecteur');
});

test('login : bon email + mauvais mot de passe → 401 générique', async () => {
  const mock = installStatefulSupabaseMock(freshState());
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL, password: 'mauvais-mdp' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Email ou mot de passe incorrect');
});

test('login : email inconnu + mot de passe valide par ailleurs (celui du BCC) → 401 générique STRICTEMENT IDENTIQUE (même statut, même message)', async () => {
  const mock = installStatefulSupabaseMock(freshState());
  const req = fakeReq({ body: { email: 'inconnu@example.com', password: 'Hendeck59190@' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Email ou mot de passe incorrect');
});

test('login : club suspendu, bon mot de passe → 403 message dédié (distinct du cas identifiants invalides)', async () => {
  const state = freshState();
  const adminId = 'admin-suspendu-uuid';
  state.admins.push({ id: adminId, email: 'suspendu@example.com', password_hash: sha256Hex('mdp-suspendu') });
  state.clubs.push({
    id: 'suspended-club-id', slug: 'suspendu', portal_code: 'SUSP01', name: 'Club suspendu', city: null,
    status: 'suspended', trial_ends_at: null,
  });
  state.admin_club_links.push({ admin_id: adminId, club_id: 'suspended-club-id' });
  const mock = installStatefulSupabaseMock(state);
  const req = fakeReq({ body: { email: 'suspendu@example.com', password: 'mdp-suspendu' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Ce club est suspendu');
});

test('login : email ou mot de passe manquant → 400', async () => {
  const mock = installStatefulSupabaseMock(freshState());
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
});

// ════════════════════════════════════════════════════════════════════════
// club-signup.js — inscription self-service (chemin SANS session)
// ════════════════════════════════════════════════════════════════════════

test('signup : inscription complète → 201, admin + club + lien en base (club status trial, trial_ends_at renseigné), mot de passe hashé dans `admins`, salle par défaut créée, token auto-connecté', async () => {
  const state = freshState();
  const mock = installStatefulSupabaseMock(state);
  const req = fakeReq({ body: { name: 'Le Rire Jaune', city: 'Paris', email: 'admin@lerirejaune.fr', password: 'motdepasseA' } });
  const res = fakeRes();
  await clubSignupHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 201);
  assert.ok(res.body.success);
  assert.ok(res.body.token);
  assert.equal(res.body.club.slug, 'le-rire-jaune');
  assert.match(res.body.club.portal_code, /^[A-Z0-9]{6}$/);

  const adminRow = state.admins.find((a) => a.email === 'admin@lerirejaune.fr');
  assert.ok(adminRow, 'la ligne admins doit avoir été insérée');
  assert.equal(adminRow.password_hash, sha256Hex('motdepasseA'));
  assert.notEqual(adminRow.password_hash, 'motdepasseA', 'le mot de passe ne doit jamais être stocké en clair');

  const clubRow = state.clubs.find((c) => c.id === res.body.club.id);
  assert.ok(clubRow, 'la ligne clubs doit avoir été insérée');
  assert.equal(clubRow.status, 'trial');
  assert.ok(clubRow.trial_ends_at, 'trial_ends_at doit être renseigné');

  const link = state.admin_club_links.find((l) => l.admin_id === adminRow.id && l.club_id === clubRow.id);
  assert.ok(link, 'le lien admin_club_links doit exister');

  const room = state.rooms.find((r) => r.club_id === clubRow.id);
  assert.ok(room, 'une salle par défaut doit être créée');
  assert.equal(room.name, 'Salle principale');

  assert.equal(tokenClubId(res.body.token), clubRow.id);
  assert.equal(res.body.accessible_clubs.length, 1);
});

test('signup : email déjà utilisé (celui du BCC) → 409 propre, jamais un 500 brut', async () => {
  const mock = installStatefulSupabaseMock(freshState());
  const req = fakeReq({ body: { name: 'Autre club', city: null, email: BCC_ADMIN_EMAIL, password: 'peu-importe' } });
  const res = fakeRes();
  await clubSignupHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'Cette adresse a déjà un club associé');
});

test('signup : collision de slug (deux clubs au même nom) → suffixe automatique, jamais d\'erreur exposée à l\'utilisateur', async () => {
  const state = freshState();
  const mock = installStatefulSupabaseMock(state);

  const res1 = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Comedy Spot', city: 'Lille', email: 'a@comedyspot.fr', password: 'mdpA12345' } }), res1);
  const res2 = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Comedy Spot', city: 'Nantes', email: 'b@comedyspot.fr', password: 'mdpB12345' } }), res2);
  mock.restore();

  assert.equal(res1.statusCode, 201);
  assert.equal(res2.statusCode, 201);
  assert.equal(res1.body.club.slug, 'comedy-spot');
  assert.equal(res2.body.club.slug, 'comedy-spot-2');
  assert.notEqual(res1.body.club.id, res2.body.club.id);
  assert.notEqual(res1.body.club.portal_code, res2.body.club.portal_code);
});

test('signup : validation — nom vide, email invalide, mot de passe trop court → 400 (pas de 500, pas d\'écriture en base)', async () => {
  const state = freshState();
  const startLen = state.clubs.length;
  const startAdmins = state.admins.length;
  const mock = installStatefulSupabaseMock(state);

  const r1 = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: '', email: 'ok@ok.com', password: 'abcdef' } }), r1);
  assert.equal(r1.statusCode, 400);

  const r2 = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Club', email: 'pas-un-email', password: 'abcdef' } }), r2);
  assert.equal(r2.statusCode, 400);

  const r3 = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Club', email: 'ok@ok.com', password: '123' } }), r3);
  assert.equal(r3.statusCode, 400);

  mock.restore();
  assert.equal(state.clubs.length, startLen, 'aucune ligne clubs ne doit être insérée sur une inscription invalide');
  assert.equal(state.admins.length, startAdmins, 'aucune ligne admins ne doit être insérée sur une inscription invalide');
});

// ════════════════════════════════════════════════════════════════════════
// Isolation croisée — deux clubs inscrits en self-service ne se mélangent
// jamais, ni à la connexion ni dans le token émis
// ════════════════════════════════════════════════════════════════════════

test('isolation : deux clubs inscrits en self-service ont des club_id distincts, et chacun ne se connecte JAMAIS avec les identifiants de l\'autre', async () => {
  const state = freshState();
  const mock = installStatefulSupabaseMock(state);

  const signupA = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Club Alpha', city: 'Lille', email: 'admin@alpha.fr', password: 'mdpAlpha1' } }), signupA);
  const signupB = fakeRes();
  await clubSignupHandler(fakeReq({ body: { name: 'Club Beta', city: 'Nice', email: 'admin@beta.fr', password: 'mdpBeta12' } }), signupB);

  const idA = signupA.body.club.id;
  const idB = signupB.body.club.id;
  assert.notEqual(idA, idB);
  assert.equal(tokenClubId(signupA.body.token), idA);
  assert.equal(tokenClubId(signupB.body.token), idB);

  // A se connecte avec ses propres identifiants → club_id A
  const loginA = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'admin@alpha.fr', password: 'mdpAlpha1' } }), loginA);
  assert.equal(loginA.statusCode, 200);
  assert.equal(tokenClubId(loginA.body.token), idA);

  // A avec le mot de passe de B → refusé, pas de fuite inter-club
  const crossLogin = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'admin@alpha.fr', password: 'mdpBeta12' } }), crossLogin);
  assert.equal(crossLogin.statusCode, 401);
  assert.equal(crossLogin.body.token, undefined);

  // B se connecte avec ses propres identifiants → club_id B, jamais A ni BCC
  const loginB = fakeRes();
  await adminLoginHandler(fakeReq({ body: { email: 'admin@beta.fr', password: 'mdpBeta12' } }), loginB);
  assert.equal(loginB.statusCode, 200);
  assert.equal(tokenClubId(loginB.body.token), idB);
  assert.notEqual(tokenClubId(loginB.body.token), idA);
  assert.notEqual(tokenClubId(loginB.body.token), BCC_CLUB_ID);

  mock.restore();
});

console.log('\nTests étape F terminés — voir le résumé du test runner ci-dessus (node --test).');
