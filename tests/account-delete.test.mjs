// ════════════════════════════════════════════════════════════════════════
// Tests — suppression self-service d'un club / d'un compte
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/account-delete.test.mjs
//
// Couvre api/account-delete.js, ajoutée pour satisfaire l'App Store Review
// Guideline 5.1.1(v) (suppression du compte obligatoirement faisable depuis
// l'app) et le droit à l'effacement du RGPD.
//
// C'est la seule route du produit qui détruit des données hors du club
// courant : elle mérite la couverture la plus stricte du dépôt. Ce qui est
// vérifié ici tient en une phrase — elle détruit exactement ce qu'on lui
// demande, jamais plus (cloisonnement entre clubs, club partagé préservé),
// jamais moins (aucune table oubliée), et jamais sans les trois gardes
// (session, mot de passe, mot tapé à la main).
//
// Même méthode que les fichiers voisins (multitenant-step-f.test.mjs) : le
// VRAI handler est exécuté, `fetch` global est mocké sur un état en mémoire.
// Aucune donnée réelle n'est jamais touchée. Le mock gère ici DELETE en plus
// de GET/POST, ce dont les fichiers voisins n'avaient pas besoin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken, sha256Hex, verifyAdminToken } = await import('../api/_lib.js');
const deleteHandler = (await import('../api/account-delete.js')).default;

const ADMIN_ID = 'admin-1';
const OTHER_ADMIN_ID = 'admin-2';
const CLUB_A = 'club-aaa';
const CLUB_B = 'club-bbb';
const FOREIGN_CLUB = 'club-zzz';
const PASSWORD = 'motdepasse-du-club';

// Toutes les tables portant un club_id que la route doit purger, plus celles
// qui structurent le compte. Chaque table applicative reçoit une ligne pour
// CHACUN des trois clubs : c'est ce qui rend le cloisonnement vérifiable —
// si la route oubliait un filtre club_id, le club étranger perdrait ses
// lignes et les tests le verraient immédiatement.
function freshState() {
  const perClub = (clubId, n) => ({ id: `${clubId}-${n}`, club_id: clubId });
  return {
    admins: [
      { id: ADMIN_ID, email: 'admin@test.fr', password_hash: sha256Hex(PASSWORD) },
      { id: OTHER_ADMIN_ID, email: 'autre@test.fr', password_hash: sha256Hex('autre') },
    ],
    admin_club_links: [
      { admin_id: ADMIN_ID, club_id: CLUB_A },
      { admin_id: ADMIN_ID, club_id: CLUB_B },
      { admin_id: OTHER_ADMIN_ID, club_id: FOREIGN_CLUB },
    ],
    clubs: [
      { id: CLUB_A, name: 'Club A', slug: 'club-a', status: 'active' },
      { id: CLUB_B, name: 'Club B', slug: 'club-b', status: 'trial' },
      { id: FOREIGN_CLUB, name: 'Club Z', slug: 'club-z', status: 'active' },
    ],
    assignments: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    dispos: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    dispo_status: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    chapeau_entries: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    chat_messages: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    events: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    comedians: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    schedule_templates: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
    rooms: [perClub(CLUB_A, 1), perClub(CLUB_B, 1), perClub(FOREIGN_CLUB, 1)],
  };
}

// Mock Supabase stateful — GET/DELETE filtrent sur eq./in., DELETE mute
// réellement l'état pour que les assertions portent sur ce qui reste en base.
// `missingTables` simule un environnement où une migration n'a pas encore été
// appliquée (la table répond 404), cas explicitement géré par la route.
function installSupabaseMock(state, { missingTables = [], failReads = [], failReadsFrom = {} } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  const readCounts = {};
  function matchRow(row, search) {
    const usp = new URLSearchParams(search.replace(/^\?/, ''));
    for (const [k, v] of usp.entries()) {
      if (k === 'select' || k === 'limit') continue;
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
    calls.push(`${method} ${table}`);
    if (missingTables.includes(table)) {
      return { ok: false, status: 404, text: async () => 'relation does not exist', json: async () => ({}) };
    }
    if (method === 'GET') {
      readCounts[table] = (readCounts[table] || 0) + 1;
      // failReadsFrom : échoue seulement à partir de la Nième lecture de cette
      // table — sert à casser la relecture des co-admins SANS casser la
      // lecture initiale des clubs du compte, deux appels sur la même table.
      const from = failReadsFrom[table];
      if (failReads.includes(table) || (from && readCounts[table] >= from)) {
        return { ok: false, status: 500, text: async () => 'read failure', json: async () => ({}) };
      }
    }
    const store = state[table];
    if (!store) return { ok: false, status: 404, text: async () => 'unknown table', json: async () => ({}) };
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => store.filter(r => matchRow(r, u.search)), text: async () => '' };
    }
    if (method === 'DELETE') {
      const kept = store.filter(r => !matchRow(r, u.search));
      state[table] = kept;
      return { ok: true, status: 204, json: async () => ([]), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => 'unsupported method in mock', json: async () => ({}) };
  };
  return { restore: () => { globalThis.fetch = original; }, calls };
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
function tokenFor(activeClubId, clubs = [{ id: CLUB_A, name: 'Club A' }, { id: CLUB_B, name: 'Club B' }]) {
  return issueAdminToken(ADMIN_ID, clubs, activeClubId).token;
}
const APP_TABLES = ['assignments', 'dispos', 'dispo_status', 'chapeau_entries',
  'chat_messages', 'events', 'comedians', 'schedule_templates', 'rooms'];

function rowsFor(state, clubId) {
  return APP_TABLES.reduce((n, t) => n + state[t].filter(r => r.club_id === clubId).length, 0);
}

async function run(state, body, { token = tokenFor(CLUB_A), mockOpts } = {}) {
  const mock = installSupabaseMock(state, mockOpts);
  try {
    const res = fakeRes();
    await deleteHandler(fakeReq({ token, body }), res);
    return res;
  } finally {
    mock.restore();
  }
}

// ════════════════════════════════════════════════════════════════════════
// Les trois gardes — aucune destruction sans les trois
// ════════════════════════════════════════════════════════════════════════

test('sans token : 401, et rien n\'est supprimé', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'account', password: PASSWORD, confirm: 'SUPPRIMER' }, { token: null });
  assert.equal(res.statusCode, 401);
  assert.equal(state.admins.length, 2);
  assert.equal(state.clubs.length, 3);
});

test('mot de passe incorrect : 403, et rien n\'est supprimé', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'account', password: 'mauvais', confirm: 'SUPPRIMER' });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /mot de passe/i);
  assert.equal(state.clubs.length, 3);
  assert.equal(rowsFor(state, CLUB_A), APP_TABLES.length);
});

test('mot de passe vide : 400, et rien n\'est supprimé', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'club', password: '', confirm: 'SUPPRIMER' });
  assert.equal(res.statusCode, 400);
  assert.equal(state.clubs.length, 3);
});

test('mot de confirmation absent ou faux : 400, et rien n\'est supprimé', async () => {
  for (const confirm of [undefined, '', 'supprime', 'DELETE', 'oui']) {
    const state = freshState();
    const res = await run(state, { scope: 'club', password: PASSWORD, confirm });
    assert.equal(res.statusCode, 400, `confirm=${confirm}`);
    assert.equal(state.clubs.length, 3);
  }
});

test('le mot de confirmation est accepté en minuscules et avec des espaces (saisie mobile)', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: '  supprimer ' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 'club');
});

test('scope inconnu : 400', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'tout', password: PASSWORD, confirm: 'SUPPRIMER' });
  assert.equal(res.statusCode, 400);
  assert.equal(state.clubs.length, 3);
});

// ════════════════════════════════════════════════════════════════════════
// scope 'club' — détruit ce club, rien d'autre
// ════════════════════════════════════════════════════════════════════════

test('supprime le club actif : ses lignes disparaissent dans TOUTES les tables', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 'club');
  assert.equal(rowsFor(state, CLUB_A), 0, 'aucune table ne doit garder de ligne du club supprimé');
  assert.equal(state.clubs.find(c => c.id === CLUB_A), undefined);
  assert.equal(state.admin_club_links.filter(l => l.club_id === CLUB_A).length, 0);
});

test('supprimer un club ne touche jamais les autres clubs du compte ni ceux d\'un autre admin', async () => {
  const state = freshState();
  await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' });
  assert.equal(rowsFor(state, CLUB_B), APP_TABLES.length, 'le second club du compte reste intact');
  assert.equal(rowsFor(state, FOREIGN_CLUB), APP_TABLES.length, 'le club d\'un autre admin reste intact');
  assert.ok(state.clubs.find(c => c.id === CLUB_B));
  assert.ok(state.clubs.find(c => c.id === FOREIGN_CLUB));
  assert.equal(state.admins.length, 2, 'le compte n\'est pas supprimé tant qu\'il reste un club');
});

test('supprimer un club renvoie un token repositionné sur un club restant', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' });
  assert.ok(res.body.token, 'un nouveau token doit être émis');
  const claims = verifyAdminToken(fakeReq({ token: res.body.token }));
  assert.equal(claims.active_club_id, CLUB_B);
  assert.deepEqual(claims.accessible_clubs.map(c => c.id), [CLUB_B]);
  assert.equal(claims.accessible_clubs[0].name, 'Club B', 'le nom est relu en base, pas repris du token périmé');
});

test('supprimer son DERNIER club supprime aussi le compte (sinon compte inutilisable)', async () => {
  const state = freshState();
  state.admin_club_links = state.admin_club_links.filter(l => l.club_id !== CLUB_B);
  const token = tokenFor(CLUB_A, [{ id: CLUB_A, name: 'Club A' }]);
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' }, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 'account');
  assert.equal(res.body.token, undefined, 'aucun token réémis : il n\'y a plus de compte');
  assert.equal(state.admins.find(a => a.id === ADMIN_ID), undefined);
});

test('un club non rattaché au compte est refusé, même si le token le désigne', async () => {
  const state = freshState();
  // Token forgé côté serveur désignant le club d'un AUTRE admin : la route
  // doit se fier à admin_club_links en base, jamais au seul token signé.
  const token = issueAdminToken(ADMIN_ID, [{ id: FOREIGN_CLUB, name: 'Club Z' }], FOREIGN_CLUB).token;
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' }, { token });
  assert.equal(res.statusCode, 403);
  assert.equal(rowsFor(state, FOREIGN_CLUB), APP_TABLES.length);
  assert.ok(state.clubs.find(c => c.id === FOREIGN_CLUB));
});

// ════════════════════════════════════════════════════════════════════════
// scope 'account' — détruit tout le compte
// ════════════════════════════════════════════════════════════════════════

test('supprime le compte : tous ses clubs, toutes leurs données, la ligne admin', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'account', password: PASSWORD, confirm: 'SUPPRIMER' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 'account');
  assert.equal(rowsFor(state, CLUB_A), 0);
  assert.equal(rowsFor(state, CLUB_B), 0);
  assert.deepEqual(state.clubs.map(c => c.id), [FOREIGN_CLUB], 'seul le club de l\'autre admin subsiste');
  assert.equal(state.admins.find(a => a.id === ADMIN_ID), undefined);
  assert.ok(state.admins.find(a => a.id === OTHER_ADMIN_ID), 'l\'autre compte est intact');
  assert.equal(state.admin_club_links.filter(l => l.admin_id === ADMIN_ID).length, 0);
});

test('supprimer le compte ne touche jamais les données d\'un autre admin', async () => {
  const state = freshState();
  await run(state, { scope: 'account', password: PASSWORD, confirm: 'SUPPRIMER' });
  assert.equal(rowsFor(state, FOREIGN_CLUB), APP_TABLES.length);
});

// ════════════════════════════════════════════════════════════════════════
// Club partagé — on ne détruit jamais les données d'un tiers
// ════════════════════════════════════════════════════════════════════════

test('club encore administré par un autre admin : seul le lien est retiré, les données restent', async () => {
  const state = freshState();
  state.admin_club_links.push({ admin_id: OTHER_ADMIN_ID, club_id: CLUB_A });
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' });
  assert.equal(res.statusCode, 200);
  assert.ok(state.clubs.find(c => c.id === CLUB_A), 'le club survit — un autre admin l\'utilise encore');
  assert.equal(rowsFor(state, CLUB_A), APP_TABLES.length, 'ses données sont intactes');
  assert.equal(state.admin_club_links.filter(l => l.club_id === CLUB_A && l.admin_id === ADMIN_ID).length, 0,
    'mais le lien de l\'admin qui part est bien retiré');
  assert.equal(state.admin_club_links.filter(l => l.club_id === CLUB_A && l.admin_id === OTHER_ADMIN_ID).length, 1);
});

test('lecture des liens du compte impossible : 500 franc, aucune purge à l\'aveugle', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' },
    { mockOpts: { failReads: ['admin_club_links'] } });
  assert.equal(res.statusCode, 500);
  assert.ok(state.clubs.find(c => c.id === CLUB_A));
  assert.equal(rowsFor(state, CLUB_A), APP_TABLES.length);
});

test('relecture des co-admins impossible : le club et ses données sont préservés (en cas de doute, on ne détruit pas)', async () => {
  const state = freshState();
  // 1re lecture d'admin_club_links (clubs du compte) : OK.
  // 2e (les co-admins de ce club) : en échec → la route doit renoncer à
  // détruire le club, jamais supposer qu'il n'a pas d'autre administrateur.
  const res = await run(state, { scope: 'club', password: PASSWORD, confirm: 'SUPPRIMER' },
    { mockOpts: { failReadsFrom: { admin_club_links: 2 } } });
  assert.equal(res.statusCode, 200);
  assert.ok(state.clubs.find(c => c.id === CLUB_A), 'le club n\'est pas détruit sur une lecture douteuse');
  assert.equal(rowsFor(state, CLUB_A), APP_TABLES.length, 'ses données non plus');
  assert.equal(state.admin_club_links.filter(l => l.club_id === CLUB_A && l.admin_id === ADMIN_ID).length, 0,
    'le lien de l\'admin est tout de même retiré : il quitte le club');
});

// ════════════════════════════════════════════════════════════════════════
// Robustesse — un environnement incomplet ne laisse pas un compte à moitié détruit
// ════════════════════════════════════════════════════════════════════════

test('une table absente (migration non appliquée) n\'empêche pas la suppression d\'aboutir', async () => {
  const state = freshState();
  const res = await run(state, { scope: 'account', password: PASSWORD, confirm: 'SUPPRIMER' },
    { mockOpts: { missingTables: ['chapeau_entries', 'events'] } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 'account');
  assert.equal(state.admins.find(a => a.id === ADMIN_ID), undefined, 'le compte est bien supprimé');
  assert.equal(state.clubs.filter(c => c.id === CLUB_A || c.id === CLUB_B).length, 0);
});

test('méthode GET refusée (405)', async () => {
  const res = fakeRes();
  await deleteHandler({ method: 'GET', headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 405);
});
