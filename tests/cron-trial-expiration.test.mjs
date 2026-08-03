// ════════════════════════════════════════════════════════════════════════
// Tests — api/cron-trial-expiration.js (audit de cohérence, point 4)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/cron-trial-expiration.test.mjs
//
// Contexte : clubs.trial_ends_at est écrit à l'inscription (club-signup.js)
// mais n'était vérifié nulle part — cette route ajoute le déclencheur
// manquant, qui passe `status` de 'trial' à 'suspended' une fois l'essai
// dépassé de plus de GRACE_DAYS jours. Le blocage lui-même (status ===
// 'suspended') existe déjà et est testé ailleurs (admin-login.js,
// multitenant-step-f.test.mjs) — ces tests couvrent uniquement le
// déclencheur : qui doit être suspendu, qui ne doit surtout pas l'être.
//
// Même méthode que les fichiers voisins : le VRAI code du handler est
// exécuté, `fetch` global est mocké — aucun credential ni réseau réel,
// aucune donnée de la vraie base Supabase de prod n'est jamais touchée.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.CRON_SECRET = 'test-cron-secret-do-not-use-in-prod';

const { isExpired, runTrialExpiration, GRACE_DAYS, default: handler } = await import('../api/cron-trial-expiration.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-03T09:00:00.000Z');

function isoDaysAgo(days) {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}
function isoDaysFromNow(days) {
  return new Date(NOW.getTime() + days * DAY_MS).toISOString();
}

// ── Mock Supabase stateful minimal : GET filtre clubs par status=eq.,
// PATCH met à jour la ligne visée par id=eq. — assez pour ce que
// runTrialExpiration() effectue réellement, pas plus. ──
function installMock(clubsTable) {
  const original = globalThis.fetch;
  const patchCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    if (table !== 'clubs') {
      return { ok: false, status: 404, text: async () => 'unknown table', json: async () => ({}) };
    }
    const method = opts.method || 'GET';
    if (method === 'GET') {
      const statusMatch = u.search.match(/status=eq\.([^&]+)/);
      const wanted = statusMatch && decodeURIComponent(statusMatch[1]);
      const rows = wanted ? clubsTable.filter((c) => c.status === wanted) : clubsTable.slice();
      return { ok: true, status: 200, json: async () => rows, text: async () => '' };
    }
    if (method === 'PATCH') {
      const idMatch = u.search.match(/id=eq\.([^&]+)/);
      const id = idMatch && decodeURIComponent(idMatch[1]);
      const body = JSON.parse(opts.body);
      patchCalls.push({ id, body });
      const row = clubsTable.find((c) => c.id === id);
      if (row) Object.assign(row, body);
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => 'unsupported method in mock', json: async () => ({}) };
  };
  return { patchCalls, restore: () => { globalThis.fetch = original; } };
}

function fakeReq(secret) {
  return { headers: secret ? { authorization: `Bearer ${secret}` } : {} };
}
function fakeRes() {
  const res = {};
  res.statusCode = 200;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// ════════════════════════════════════════════════════════════════════════
// isExpired() — logique pure, pas de réseau
// ════════════════════════════════════════════════════════════════════════

test('isExpired : club trial dont la grâce est dépassée → true', () => {
  const club = { status: 'trial', trial_ends_at: isoDaysAgo(GRACE_DAYS + 1) };
  assert.equal(isExpired(club, NOW), true);
});

test('isExpired : club trial encore dans sa fenêtre de grâce → false', () => {
  const club = { status: 'trial', trial_ends_at: isoDaysAgo(1) }; // essai fini hier, grâce de 3j pas encore écoulée
  assert.equal(isExpired(club, NOW), false);
});

test('isExpired : club trial pas encore arrivé à échéance → false', () => {
  const club = { status: 'trial', trial_ends_at: isoDaysFromNow(10) };
  assert.equal(isExpired(club, NOW), false);
});

test('isExpired : club déjà "active" avec un vieux trial_ends_at → false (jamais concerné, quel que soit le statut du filtre trial)', () => {
  const club = { status: 'active', trial_ends_at: isoDaysAgo(365) };
  assert.equal(isExpired(club, NOW), false);
});

test('isExpired : club déjà "suspended" → false (ce cron ne fait que suspendre, jamais autre chose)', () => {
  const club = { status: 'suspended', trial_ends_at: isoDaysAgo(365) };
  assert.equal(isExpired(club, NOW), false);
});

// ════════════════════════════════════════════════════════════════════════
// runTrialExpiration() — bout en bout avec le mock Supabase
// ════════════════════════════════════════════════════════════════════════

test('runTrialExpiration : club trial expiré + grâce dépassée → passé à suspended', async () => {
  const clubs = [
    { id: 'club-expired', name: 'Club Expiré', status: 'trial', trial_ends_at: isoDaysAgo(GRACE_DAYS + 5) },
  ];
  const mock = installMock(clubs);
  const result = await runTrialExpiration(NOW);
  mock.restore();

  assert.equal(result.suspendedCount, 1);
  assert.equal(clubs[0].status, 'suspended');
  assert.equal(mock.patchCalls.length, 1);
  assert.equal(mock.patchCalls[0].id, 'club-expired');
  assert.equal(mock.patchCalls[0].body.status, 'suspended');
});

test('runTrialExpiration : club trial dans sa fenêtre de grâce → pas encore suspendu', async () => {
  const clubs = [
    { id: 'club-grace', name: 'Club En Grâce', status: 'trial', trial_ends_at: isoDaysAgo(1) },
  ];
  const mock = installMock(clubs);
  const result = await runTrialExpiration(NOW);
  mock.restore();

  assert.equal(result.suspendedCount, 0);
  assert.equal(clubs[0].status, 'trial');
  assert.equal(mock.patchCalls.length, 0);
});

test('runTrialExpiration : club déjà "active" avec un très vieux trial_ends_at → jamais touché par ce cron', async () => {
  const clubs = [
    { id: 'club-bcc', name: 'Beer Comedy Club', status: 'active', trial_ends_at: isoDaysAgo(1000) },
  ];
  const mock = installMock(clubs);
  const result = await runTrialExpiration(NOW);
  mock.restore();

  assert.equal(result.suspendedCount, 0);
  assert.equal(clubs[0].status, 'active', 'un club actif ne doit JAMAIS être repassé à un autre statut par ce cron');
  assert.equal(mock.patchCalls.length, 0);
});

test('runTrialExpiration : mélange de clubs — seuls les trial réellement expirés (grâce dépassée) sont suspendus, les autres restent inchangés', async () => {
  const clubs = [
    { id: 'club-bcc', name: 'BCC', status: 'active', trial_ends_at: isoDaysAgo(1000) },
    { id: 'club-fresh-trial', name: 'Tout juste inscrit', status: 'trial', trial_ends_at: isoDaysFromNow(25) },
    { id: 'club-grace', name: 'En grâce', status: 'trial', trial_ends_at: isoDaysAgo(2) },
    { id: 'club-expired-1', name: 'Expiré 1', status: 'trial', trial_ends_at: isoDaysAgo(GRACE_DAYS + 1) },
    { id: 'club-expired-2', name: 'Expiré 2', status: 'trial', trial_ends_at: isoDaysAgo(60) },
    { id: 'club-already-suspended', name: 'Déjà suspendu', status: 'suspended', trial_ends_at: isoDaysAgo(90) },
  ];
  const mock = installMock(clubs);
  const result = await runTrialExpiration(NOW);
  mock.restore();

  assert.equal(result.suspendedCount, 2);
  const suspendedIds = result.suspended.map((c) => c.id).sort();
  assert.deepEqual(suspendedIds, ['club-expired-1', 'club-expired-2']);

  assert.equal(clubs.find((c) => c.id === 'club-bcc').status, 'active');
  assert.equal(clubs.find((c) => c.id === 'club-fresh-trial').status, 'trial');
  assert.equal(clubs.find((c) => c.id === 'club-grace').status, 'trial');
  assert.equal(clubs.find((c) => c.id === 'club-expired-1').status, 'suspended');
  assert.equal(clubs.find((c) => c.id === 'club-expired-2').status, 'suspended');
  assert.equal(clubs.find((c) => c.id === 'club-already-suspended').status, 'suspended');
});

// ════════════════════════════════════════════════════════════════════════
// handler() — auth cron
// ════════════════════════════════════════════════════════════════════════

test('handler : sans en-tête Authorization → 401, aucun accès Supabase tenté', async () => {
  const clubs = [{ id: 'x', name: 'X', status: 'trial', trial_ends_at: isoDaysAgo(100) }];
  const mock = installMock(clubs);
  const res = fakeRes();
  await handler(fakeReq(null), res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(clubs[0].status, 'trial');
});

test('handler : mauvais secret → 401', async () => {
  const clubs = [];
  const mock = installMock(clubs);
  const res = fakeRes();
  await handler(fakeReq('mauvais-secret'), res);
  mock.restore();
  assert.equal(res.statusCode, 401);
});

test('handler : bon secret → 200, exécute réellement le cron', async () => {
  const clubs = [{ id: 'club-expired', name: 'X', status: 'trial', trial_ends_at: isoDaysAgo(GRACE_DAYS + 1) }];
  const mock = installMock(clubs);
  const res = fakeRes();
  await handler(fakeReq('test-cron-secret-do-not-use-in-prod'), res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.suspendedCount, 1);
  assert.equal(clubs[0].status, 'suspended');
});

console.log('\nTests cron-trial-expiration terminés — voir le résumé du test runner ci-dessus (node --test).');
