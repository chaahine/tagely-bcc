// ════════════════════════════════════════════════════════════════════════
// Tests — chantier multitenant, étape F (inscription self-service + login
// généralisé par email)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/multitenant-step-f.test.mjs
//
// Couvre les deux routes changées/ajoutées à l'étape F :
//  - api/admin-login.js : résout désormais le club par admin_email (au lieu
//    du slug 'bcc' en dur, repli posé à l'étape C) — accepte {email,
//    password}, message générique identique que l'email ou le mot de passe
//    soit faux, vérifie status != 'suspended'.
//  - api/club-signup.js (nouveau) : inscription self-service — validation,
//    unicité de l'email, génération slug/portal_code avec retry sur
//    collision, création de la salle par défaut, auto-connexion.
//
// Même méthode que les fichiers voisins (multitenant-scoping.test.mjs,
// multitenant-step-c.test.mjs) : le VRAI code des handlers est exécuté,
// `fetch` global est mocké — aucun credential ni réseau réel, et surtout
// AUCUNE donnée de la vraie base Supabase de prod n'est jamais touchée par
// ces tests.
//
// Différence avec les mocks des fichiers voisins : ceux-ci renvoient une
// réponse figée par requête (une seule ligne `clubs` toujours retournée).
// Ça ne suffit pas ici : club-signup.js enchaîne plusieurs lectures/écritures
// dont le résultat doit dépendre de ce qui a déjà été inséré par un appel
// précédent (retry de collision sur slug/portal_code, unicité de l'email).
// Le mock ci-dessous simule donc un vrai état — deux tables en mémoire
// (`clubs`, `rooms`) avec les mêmes contraintes UNIQUE que le schéma réel
// (id, slug, portal_code, admin_email) — plutôt que des réponses figées.

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

function freshClubsTable() {
  return [
    {
      id: BCC_CLUB_ID,
      slug: 'bcc',
      portal_code: 'BCCD25',
      name: 'Beer Comedy Club',
      city: 'Lille',
      admin_email: BCC_ADMIN_EMAIL,
      admin_pwd_hash: BCC_ADMIN_PWD_HASH,
      status: 'active',
    },
  ];
}

// ── Mock Supabase stateful : GET filtre par eq. générique (peu importe la
// colonne), POST insère en simulant les contraintes UNIQUE réelles. ──
function installStatefulSupabaseMock(clubsTable, roomsTable) {
  const original = globalThis.fetch;
  function parseEqFilters(search) {
    const usp = new URLSearchParams(search.replace(/^\?/, ''));
    const filters = [];
    for (const [k, v] of usp.entries()) {
      if (v.startsWith('eq.')) filters.push([k, decodeURIComponent(v.slice(3))]);
    }
    return filters;
  }
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const method = opts.method || 'GET';
    const store = table === 'clubs' ? clubsTable : table === 'rooms' ? roomsTable : null;
    if (!store) return { ok: false, status: 404, text: async () => 'unknown table', json: async () => ({}) };

    if (method === 'GET') {
      const filters = parseEqFilters(u.search);
      const rows = store.filter((row) => filters.every(([k, v]) => String(row[k]) === v));
      return { ok: true, status: 200, json: async () => rows, text: async () => '' };
    }
    if (method === 'POST') {
      const body = JSON.parse(opts.body);
      for (const row of body) {
        for (const col of ['id', 'slug', 'portal_code', 'admin_email']) {
          if (col in row && store.some((r) => r[col] === row[col])) {
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
  return claims && claims.club_id;
}

// ════════════════════════════════════════════════════════════════════════
// admin-login.js — résolution par admin_email
// ════════════════════════════════════════════════════════════════════════

test('RÉGRESSION — login BCC avec l\'email et le mot de passe réels de Bruce → 200, club_id = BCC_CLUB_ID inchangé', async () => {
  const mock = installStatefulSupabaseMock(freshClubsTable(), []);
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL, password: 'Hendeck59190@' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(tokenClubId(res.body.token), BCC_CLUB_ID);
});

test('login : bon email + mauvais mot de passe → 401 générique', async () => {
  const mock = installStatefulSupabaseMock(freshClubsTable(), []);
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL, password: 'mauvais-mdp' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Email ou mot de passe incorrect');
});

test('login : email inconnu + mot de passe valide par ailleurs (celui du BCC) → 401 générique STRICTEMENT IDENTIQUE (même statut, même message)', async () => {
  const mock = installStatefulSupabaseMock(freshClubsTable(), []);
  const req = fakeReq({ body: { email: 'inconnu@example.com', password: 'Hendeck59190@' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Email ou mot de passe incorrect');
});

test('login : club suspendu, bon mot de passe → 403 message dédié (distinct du cas identifiants invalides)', async () => {
  const clubs = freshClubsTable();
  clubs.push({
    id: 'suspended-club-id',
    slug: 'suspendu',
    portal_code: 'SUSP01',
    name: 'Club suspendu',
    city: null,
    admin_email: 'suspendu@example.com',
    admin_pwd_hash: sha256Hex('mdp-suspendu'),
    status: 'suspended',
  });
  const mock = installStatefulSupabaseMock(clubs, []);
  const req = fakeReq({ body: { email: 'suspendu@example.com', password: 'mdp-suspendu' } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Ce club est suspendu');
});

test('login : email ou mot de passe manquant → 400', async () => {
  const mock = installStatefulSupabaseMock(freshClubsTable(), []);
  const req = fakeReq({ body: { email: BCC_ADMIN_EMAIL } });
  const res = fakeRes();
  await adminLoginHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 400);
});

// ════════════════════════════════════════════════════════════════════════
// club-signup.js — inscription self-service
// ════════════════════════════════════════════════════════════════════════

test('signup : inscription complète → 201, club en base (status trial, trial_ends_at renseigné), mot de passe hashé, salle par défaut créée, token auto-connecté', async () => {
  const clubs = freshClubsTable();
  const rooms = [];
  const mock = installStatefulSupabaseMock(clubs, rooms);
  const req = fakeReq({ body: { name: 'Le Rire Jaune', city: 'Paris', email: 'admin@lerirejaune.fr', password: 'motdepasseA' } });
  const res = fakeRes();
  await clubSignupHandler(req, res);
  mock.restore();

  assert.equal(res.statusCode, 201);
  assert.ok(res.body.success);
  assert.ok(res.body.token);
  assert.equal(res.body.club.slug, 'le-rire-jaune');
  assert.match(res.body.club.portal_code, /^[A-Z0-9]{6}$/);

  const row = clubs.find((c) => c.admin_email === 'admin@lerirejaune.fr');
  assert.ok(row, 'la ligne clubs doit avoir été insérée');
  assert.equal(row.status, 'trial');
  assert.ok(row.trial_ends_at, 'trial_ends_at doit être renseigné');
  assert.equal(row.admin_pwd_hash, sha256Hex('motdepasseA'));
  assert.notEqual(row.admin_pwd_hash, 'motdepasseA', 'le mot de passe ne doit jamais être stocké en clair');

  const room = rooms.find((r) => r.club_id === row.id);
  assert.ok(room, 'une salle par défaut doit être créée');
  assert.equal(room.name, 'Salle principale');

  assert.equal(tokenClubId(res.body.token), row.id);
});

test('signup : email déjà utilisé (celui du BCC) → 409 propre, jamais un 500 brut', async () => {
  const mock = installStatefulSupabaseMock(freshClubsTable(), []);
  const req = fakeReq({ body: { name: 'Autre club', city: null, email: BCC_ADMIN_EMAIL, password: 'peu-importe' } });
  const res = fakeRes();
  await clubSignupHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'Cette adresse a déjà un club associé');
});

test('signup : collision de slug (deux clubs au même nom) → suffixe automatique, jamais d\'erreur exposée à l\'utilisateur', async () => {
  const clubs = freshClubsTable();
  const rooms = [];
  const mock = installStatefulSupabaseMock(clubs, rooms);

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
  const clubs = freshClubsTable();
  const startLen = clubs.length;
  const mock = installStatefulSupabaseMock(clubs, []);

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
  assert.equal(clubs.length, startLen, 'aucune ligne clubs ne doit être insérée sur une inscription invalide');
});

// ════════════════════════════════════════════════════════════════════════
// Isolation croisée — deux clubs inscrits en self-service ne se mélangent
// jamais, ni à la connexion ni dans le token émis
// ════════════════════════════════════════════════════════════════════════

test('isolation : deux clubs inscrits en self-service ont des club_id distincts, et chacun ne se connecte JAMAIS avec les identifiants de l\'autre', async () => {
  const clubs = freshClubsTable();
  const rooms = [];
  const mock = installStatefulSupabaseMock(clubs, rooms);

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
