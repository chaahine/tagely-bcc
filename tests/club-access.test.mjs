// ════════════════════════════════════════════════════════════════════════
// Tests — chantier "plusieurs personnes par club" (2026-09)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Couvre les deux routes du chantier, avec le VRAI code des handlers et un
// Supabase simulé en mémoire (tables admins / admin_club_links / clubs) —
// aucun credential ni réseau réel, l'appel Brevo est intercepté lui aussi.
//
// Les points qui comptent vraiment ici :
//  - le club visé vient TOUJOURS du token (active_club_id), jamais du body ;
//  - l'appartenance de l'admin au club est revérifiée EN BASE à chaque appel,
//    donc un accès révoqué cesse d'agir sans attendre l'expiration du token ;
//  - inviter une adresse qui possède déjà un compte ne permet JAMAIS d'en
//    changer le mot de passe (sinon : prise de contrôle de compte par simple
//    invitation) ;
//  - on ne peut pas retirer son propre accès — c'est ce qui garantit qu'un
//    club conserve toujours au moins un administrateur.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.BREVO_API_KEY = 'test-brevo-key';
process.env.STAGELY_PUBLIC_URL = 'https://stagely.test';

const { issueAdminToken, issueInviteToken, verifyInviteToken, verifyAdminToken, sha256Hex } = await import('../api/_lib.js');
const clubAccessHandler = (await import('../api/club-access.js')).default;
const acceptInviteHandler = (await import('../api/accept-invite.js')).default;

const CLUB_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const CLUB_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ADMIN_1 = 'admin-1';
const ADMIN_2 = 'admin-2';

// ── Supabase en mémoire ───────────────────────────────────────────────────
// Ne réimplémente que ce que ces deux routes utilisent : filtres eq., in.(),
// select, order. Volontairement littéral — un mock qui devine trop finit par
// tester le mock au lieu du code.
function makeDb() {
  return {
    clubs: [
      { id: CLUB_A, name: 'Club A', city: 'Paris', slug: 'club-a', portal_code: 'AAA', dispo_deadline_day: 12, status: 'active', plan: 'pro' },
      { id: CLUB_B, name: 'Club B', city: 'Lyon', slug: 'club-b', portal_code: 'BBB', dispo_deadline_day: 12, status: 'trial', plan: 'essentiel' },
    ],
    admins: [
      { id: ADMIN_1, email: 'patron@club-a.fr', password_hash: sha256Hex('motdepasse1') },
      { id: ADMIN_2, email: 'assistant@club-a.fr', password_hash: sha256Hex('motdepasse2') },
    ],
    admin_club_links: [
      { admin_id: ADMIN_1, club_id: CLUB_A, created_at: '2026-01-01T00:00:00Z' },
      { admin_id: ADMIN_2, club_id: CLUB_B, created_at: '2026-01-02T00:00:00Z' },
    ],
  };
}

function parseFilters(query) {
  const out = {};
  for (const part of query.split('&')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    if (v.startsWith('eq.')) out[k] = decodeURIComponent(v.slice(3));
    else if (v.startsWith('in.(')) out[k] = { in: v.slice(4, -1).split(',').map(decodeURIComponent) };
  }
  return out;
}

function installMock(db) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });

    if (String(url).includes('api.brevo.com')) {
      return { ok: true, status: 201, json: async () => ({ messageId: 'fake' }), text: async () => '' };
    }

    const [path, query = ''] = String(url).split('/rest/v1/')[1].split('?');
    const table = path;
    const filters = parseFilters(query);
    const match = (row) => Object.entries(filters).every(([k, v]) => {
      if (['select', 'limit', 'order'].includes(k)) return true;
      if (v && typeof v === 'object' && v.in) return v.in.includes(row[k]);
      return String(row[k]) === String(v);
    });

    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => db[table].filter(match), text: async () => '' };
    }
    if (method === 'POST') {
      for (const row of body) {
        const dup = table === 'admin_club_links'
          && db[table].some(r => r.admin_id === row.admin_id && r.club_id === row.club_id);
        if (table === 'admins' && db.admins.some(a => a.email === row.email)) {
          return { ok: false, status: 409, json: async () => ({}), text: async () => 'duplicate key value violates unique constraint "admins_email_key"' };
        }
        if (!dup) db[table].push({ created_at: '2026-09-10T00:00:00Z', ...row });
      }
      return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
    }
    if (method === 'DELETE') {
      db[table] = db[table].filter(r => !match(r));
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
    }
    return { ok: false, status: 405, json: async () => ({}), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  res.end = () => { res.body = undefined; return res; };
  return res;
}

function tokenFor(adminId, clubs, activeClubId) {
  return issueAdminToken(adminId, clubs, activeClubId).token;
}

async function callAccess({ db, adminId = ADMIN_1, clubs = [{ id: CLUB_A, name: 'Club A' }], active = CLUB_A, action, payload, noAuth = false }) {
  const mock = installMock(db);
  const req = {
    method: 'POST',
    headers: noAuth ? {} : { authorization: `Bearer ${tokenFor(adminId, clubs, active)}` },
    body: { action, payload },
  };
  const res = fakeRes();
  await clubAccessHandler(req, res);
  mock.restore();
  return { res, calls: mock.calls };
}

async function callAccept({ db, action, token, password }) {
  const mock = installMock(db);
  const res = fakeRes();
  await acceptInviteHandler({ method: 'POST', headers: {}, body: { action, token, password } }, res);
  mock.restore();
  return { res, calls: mock.calls };
}

// ── club-access : autorisation ────────────────────────────────────────────

test('club-access : 401 sans token admin', async () => {
  const { res } = await callAccess({ db: makeDb(), action: 'list', noAuth: true });
  assert.equal(res.statusCode, 401);
});

test("club-access : un token encore valide dont l'accès a été révoqué en base est refusé (403)", async () => {
  const db = makeDb();
  db.admin_club_links = db.admin_club_links.filter(l => !(l.admin_id === ADMIN_1 && l.club_id === CLUB_A));
  const { res } = await callAccess({ db, action: 'list' });
  assert.equal(res.statusCode, 403);
});

test('club-access : le club visé vient du token, jamais du payload', async () => {
  const db = makeDb();
  // ADMIN_1 n'a accès qu'à CLUB_A ; il tente d'agir sur CLUB_B via le payload.
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'x@y.fr', club_id: CLUB_B } });
  assert.equal(res.statusCode, 200);
  assert.ok(!db.admin_club_links.some(l => l.club_id === CLUB_B && l.admin_id !== ADMIN_2),
    'aucun accès ne doit avoir été créé sur le club B');
});

// ── list ──────────────────────────────────────────────────────────────────

test('list : renvoie les personnes ayant accès, avec leur email et is_self', async () => {
  const { res } = await callAccess({ db: makeDb(), action: 'list' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.admins.length, 1);
  assert.equal(res.body.admins[0].email, 'patron@club-a.fr');
  assert.equal(res.body.admins[0].is_self, true);
});

// ── invite ────────────────────────────────────────────────────────────────

test('invite : adresse invalide refusée', async () => {
  const { res } = await callAccess({ db: makeDb(), action: 'invite', payload: { email: 'pas-un-email' } });
  assert.equal(res.statusCode, 400);
});

test('invite : compte Stagely existant → accès ouvert immédiatement, sans lien d\'invitation', async () => {
  const db = makeDb();
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'assistant@club-a.fr' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.url, undefined, 'aucun lien d\'invitation pour un compte existant');
  assert.ok(db.admin_club_links.some(l => l.admin_id === ADMIN_2 && l.club_id === CLUB_A));
  assert.equal(res.body.admins.length, 2);
});

test('invite : personne déjà membre du club → 409', async () => {
  const { res } = await callAccess({ db: makeDb(), action: 'invite', payload: { email: 'patron@club-a.fr' } });
  assert.equal(res.statusCode, 409);
});

test('invite : adresse inconnue → lien d\'invitation signé, et AUCUN accès ouvert avant acceptation', async () => {
  const db = makeDb();
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'nouveau@club-a.fr' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, false);
  assert.ok(res.body.url.startsWith('https://stagely.test/rejoindre.html?token='));
  assert.equal(db.admin_club_links.length, 2, 'aucun lien ne doit exister tant que le lien n\'est pas accepté');
  assert.equal(db.admins.length, 2, 'aucun compte ne doit être créé à ce stade');
});

test('invite : un email qui échoue ne fait pas échouer l\'invitation', async () => {
  const db = makeDb();
  const original = globalThis.fetch;
  const mock = installMock(db);
  const withBrevoDown = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.brevo.com')) throw new Error('brevo down');
    return withBrevoDown(url, opts);
  };
  const res = fakeRes();
  await clubAccessHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(ADMIN_1, [{ id: CLUB_A, name: 'Club A' }], CLUB_A)}` },
    body: { action: 'invite', payload: { email: 'assistant@club-a.fr' } },
  }, res);
  mock.restore();
  globalThis.fetch = original;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailed, false, 'l\'UI doit savoir que l\'email n\'est pas parti');
  assert.equal(res.body.linked, true, 'mais l\'accès est bien ouvert');
});

// ── revoke ────────────────────────────────────────────────────────────────

test('revoke : retirer son propre accès est refusé (un club garde toujours un admin)', async () => {
  const { res } = await callAccess({ db: makeDb(), action: 'revoke', payload: { admin_id: ADMIN_1 } });
  assert.equal(res.statusCode, 400);
});

test('revoke : personne non membre → 404', async () => {
  const { res } = await callAccess({ db: makeDb(), action: 'revoke', payload: { admin_id: ADMIN_2 } });
  assert.equal(res.statusCode, 404);
});

test('revoke : retire bien le lien, et seulement pour ce club', async () => {
  const db = makeDb();
  db.admin_club_links.push({ admin_id: ADMIN_2, club_id: CLUB_A, created_at: '2026-02-01T00:00:00Z' });
  const { res } = await callAccess({ db, action: 'revoke', payload: { admin_id: ADMIN_2 } });
  assert.equal(res.statusCode, 200);
  assert.ok(!db.admin_club_links.some(l => l.admin_id === ADMIN_2 && l.club_id === CLUB_A));
  assert.ok(db.admin_club_links.some(l => l.admin_id === ADMIN_2 && l.club_id === CLUB_B),
    'son accès à son autre club ne doit pas être touché');
});

// ── accept-invite ─────────────────────────────────────────────────────────

test('accept-invite : lien invalide refusé', async () => {
  const { res } = await callAccept({ db: makeDb(), action: 'preview', token: 'nimportequoi.signature' });
  assert.equal(res.statusCode, 400);
});

test('accept-invite : lien expiré refusé', async () => {
  const expired = issueInviteToken(CLUB_A, 'nouveau@club-a.fr', Date.now() - 8 * 24 * 60 * 60 * 1000).token;
  const { res } = await callAccept({ db: makeDb(), action: 'preview', token: expired });
  assert.equal(res.statusCode, 400);
});

test('accept-invite : preview annonce le club et l\'adresse concernée', async () => {
  const token = issueInviteToken(CLUB_A, 'nouveau@club-a.fr').token;
  const { res } = await callAccept({ db: makeDb(), action: 'preview', token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.club.name, 'Club A');
  assert.equal(res.body.email, 'nouveau@club-a.fr');
  assert.equal(res.body.existingAccount, false);
});

test('accept-invite : mot de passe trop court refusé', async () => {
  const token = issueInviteToken(CLUB_A, 'nouveau@club-a.fr').token;
  const { res } = await callAccept({ db: makeDb(), action: 'accept', token, password: '123' });
  assert.equal(res.statusCode, 400);
});

test('accept-invite : nouveau compte créé, lié au club, et session ouverte directement', async () => {
  const db = makeDb();
  const token = issueInviteToken(CLUB_A, 'nouveau@club-a.fr').token;
  const { res } = await callAccept({ db, action: 'accept', token, password: 'motdepasse3' });
  assert.equal(res.statusCode, 201);
  assert.equal(db.admins.length, 3);
  assert.ok(db.admin_club_links.some(l => l.club_id === CLUB_A && l.admin_id !== ADMIN_1));
  const claims = verifyAdminToken({ headers: { authorization: `Bearer ${res.body.token}` } });
  assert.ok(claims, 'le token renvoyé doit être une session admin valide');
  assert.equal(claims.active_club_id, CLUB_A);
});

test('accept-invite : un compte EXISTANT est lié sans que son mot de passe ne change jamais', async () => {
  const db = makeDb();
  const before = db.admins.find(a => a.email === 'assistant@club-a.fr').password_hash;
  const token = issueInviteToken(CLUB_A, 'assistant@club-a.fr').token;
  const { res } = await callAccept({ db, action: 'accept', token, password: 'motdepasse-pirate' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.existingAccount, true);
  assert.equal(res.body.token, undefined, 'aucune session ne doit être ouverte pour un compte préexistant');
  const after = db.admins.find(a => a.email === 'assistant@club-a.fr').password_hash;
  assert.equal(after, before, 'PRISE DE CONTRÔLE DE COMPTE : le mot de passe ne doit jamais être réécrit par une invitation');
  assert.ok(db.admin_club_links.some(l => l.admin_id === ADMIN_2 && l.club_id === CLUB_A));
});

// ── Plafond de personnes du palier Essentiel ──────────────────────────────
// Rappel de la règle : 2 personnes au palier Essentiel, aucune limite en
// Pro/Réseau, et accès complet pendant l'essai. Comme partout ailleurs dans
// le gating, le plafond ne freine QUE l'ajout.

function essentielDb() {
  const db = makeDb();
  db.clubs.find(c => c.id === CLUB_A).plan = 'essentiel';
  db.clubs.find(c => c.id === CLUB_A).status = 'active';
  return db;
}

test('Essentiel : jusqu\'à 3 personnes, ça passe', async () => {
  const db = essentielDb();
  db.admin_club_links.push({ admin_id: ADMIN_2, club_id: CLUB_A, created_at: '2026-02-01T00:00:00Z' });
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'troisieme@club-a.fr' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, false, 'adresse inconnue : invitation, pas encore un accès');
});

test('Essentiel : la 4e est refusée, avec un code exploitable par le client', async () => {
  const db = essentielDb();
  db.admins.push({ id: 'admin-3', email: 'trois@club-a.fr', password_hash: 'x' });
  db.admin_club_links.push({ admin_id: ADMIN_2, club_id: CLUB_A, created_at: '2026-02-01T00:00:00Z' });
  db.admin_club_links.push({ admin_id: 'admin-3', club_id: CLUB_A, created_at: '2026-02-02T00:00:00Z' });
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'quatrieme@club-a.fr' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'plan_limit_club_access');
  assert.equal(res.body.limit, 3);
  assert.equal(db.admins.length, 3, 'aucun compte ne doit être créé quand le plafond refuse');
});

// Un club déjà au plafond Essentiel (3 personnes) : seul le palier change la
// réponse, d'où le même état de départ dans les deux tests qui suivent.
function atSeatLimit(db) {
  db.admins.push({ id: 'admin-3', email: 'trois@club-a.fr', password_hash: 'x' });
  db.admin_club_links.push({ admin_id: ADMIN_2, club_id: CLUB_A, created_at: '2026-02-01T00:00:00Z' });
  db.admin_club_links.push({ admin_id: 'admin-3', club_id: CLUB_A, created_at: '2026-02-02T00:00:00Z' });
  return db;
}

test('Pro : la 4e personne passe (le plafond Pro est plus haut, pas absent)', async () => {
  const db = atSeatLimit(makeDb()); // CLUB_A est en plan 'pro'
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'quatrieme@club-a.fr' } });
  assert.equal(res.statusCode, 200);
});

test('Pro : la 7e personne est refusée — Pro plafonne à 6', async () => {
  const db = makeDb(); // CLUB_A est en plan 'pro'
  for (let i = 0; i < 5; i++) {
    db.admins.push({ id: `admin-p${i}`, email: `p${i}@club-a.fr`, password_hash: 'x' });
    db.admin_club_links.push({ admin_id: `admin-p${i}`, club_id: CLUB_A, created_at: `2026-03-0${i + 1}T00:00:00Z` });
  }
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'septieme@club-a.fr' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'plan_limit_club_access');
  assert.equal(res.body.limit, 6);
});

test('Réseau : aucune limite de personnes', async () => {
  const db = makeDb();
  db.clubs.find(c => c.id === CLUB_A).plan = 'reseau';
  for (let i = 0; i < 8; i++) {
    db.admins.push({ id: `admin-r${i}`, email: `r${i}@club-a.fr`, password_hash: 'x' });
    db.admin_club_links.push({ admin_id: `admin-r${i}`, club_id: CLUB_A, created_at: `2026-04-0${i + 1}T00:00:00Z` });
  }
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'dixieme@club-a.fr' } });
  assert.equal(res.statusCode, 200);
});

test("pendant l'essai, aucune limite de personnes", async () => {
  const db = atSeatLimit(essentielDb());
  db.clubs.find(c => c.id === CLUB_A).status = 'trial';
  const { res } = await callAccess({ db, action: 'invite', payload: { email: 'quatrieme@club-a.fr' } });
  assert.equal(res.statusCode, 200);
});

test('Essentiel au plafond : ne peut plus ajouter, mais peut toujours retirer', async () => {
  const db = atSeatLimit(essentielDb());
  const add = await callAccess({ db, action: 'invite', payload: { email: 'quatrieme@club-a.fr' } });
  assert.equal(add.res.statusCode, 403);

  const remove = await callAccess({ db, action: 'revoke', payload: { admin_id: 'admin-3' } });
  assert.equal(remove.res.statusCode, 200, 'retirer un accès ne doit jamais être bloqué par le palier');
  assert.equal(remove.res.body.admins.length, 2);
});

test("lister qui a accès n'est jamais bloqué par le palier", async () => {
  const db = essentielDb();
  db.admin_club_links.push({ admin_id: ADMIN_2, club_id: CLUB_A, created_at: '2026-02-01T00:00:00Z' });
  const { res } = await callAccess({ db, action: 'list' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.admins.length, 2);
});

// ── étanchéité des deux familles de tokens ────────────────────────────────

test("un token d'invitation ne vaut pas une session admin", async () => {
  const invite = issueInviteToken(CLUB_A, 'nouveau@club-a.fr').token;
  assert.equal(verifyAdminToken({ headers: { authorization: `Bearer ${invite}` } }), null);
});

test("un token de session admin ne vaut pas une invitation", () => {
  const session = tokenFor(ADMIN_1, [{ id: CLUB_A, name: 'Club A' }], CLUB_A);
  assert.equal(verifyInviteToken(session), null);
});

test("un token d'invitation ne peut servir que pour l'adresse qui y est inscrite", () => {
  const invite = issueInviteToken(CLUB_A, 'cible@club-a.fr').token;
  const claims = verifyInviteToken(invite);
  assert.equal(claims.email, 'cible@club-a.fr');
  assert.equal(claims.club_id, CLUB_A);
});
