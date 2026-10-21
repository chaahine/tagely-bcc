// ════════════════════════════════════════════════════════════════════════
// Tests — relais Fairy Tails de /projets.html (api/owner-fairytails.js)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Ce qui compte : seul le fondateur du BCC peut s'en servir, et un mauvais
// mot de passe Fairy Tails est signalé comme tel (code ft_key) pour que la
// page le redemande au lieu de déconnecter la session Stagely.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken, BCC_CLUB_ID } = await import('../api/_lib.js');
const handler = (await import('../api/owner-fairytails.js')).default;

const links = [
  { admin_id: 'owner', club_id: BCC_CLUB_ID, created_at: '2026-01-01T00:00:00Z' },
  { admin_id: 'coadmin', club_id: BCC_CLUB_ID, created_at: '2026-09-01T00:00:00Z' },
];
const ftCalls = [];

globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://fairytails.fr/')) {
    ftCalls.push(String(url));
    const ok = new URL(url).searchParams.get('secret') === 'bon';
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { ventes: { total: { nombre: 3 } } } : { error: 'Unauthorized' }) };
  }
  const rows = links.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 1);
  return { ok: true, status: 200, json: async () => rows, text: async () => '' };
};

function call(adminId, key) {
  const headers = {};
  if (adminId) headers.authorization = 'Bearer ' + issueAdminToken(adminId, [{ id: BCC_CLUB_ID, name: 'BCC' }], BCC_CLUB_ID).token;
  if (key) headers['x-ft-key'] = key;
  const res = { statusCode: 200, setHeader() {}, end() { return res; } };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return handler({ method: 'POST', headers, body: {} }, res).then(() => res);
}

test('sans session Stagely : 401, Fairy Tails jamais appelé', async () => {
  assert.equal((await call(null, 'bon')).statusCode, 401);
  assert.equal(ftCalls.length, 0);
});

test('co-admin du BCC : 403, Fairy Tails jamais appelé', async () => {
  assert.equal((await call('coadmin', 'bon')).statusCode, 403);
  assert.equal(ftCalls.length, 0);
});

test('fondateur, mauvais mot de passe Fairy Tails : 401 avec code ft_key', async () => {
  const res = await call('owner', 'faux');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'ft_key');
});

test('fondateur, bon mot de passe : JSON de Fairy Tails relayé', async () => {
  const res = await call('owner', 'bon');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ventes.total.nombre, 3);
});
