// ════════════════════════════════════════════════════════════════════════
// Tests — tableau de bord des inscrits (api/owner-signups.js)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Ce qui compte : seul le fondateur du BCC (premier lien) voit la liste, un
// co-admin invité plus tard non, et aucun hash de mot de passe ne sort.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken, BCC_CLUB_ID } = await import('../api/_lib.js');
const handler = (await import('../api/owner-signups.js')).default;

const CLUB_X = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

const db = {
  clubs: [
    { id: BCC_CLUB_ID, name: 'BCC', city: 'Paris', status: 'active', plan: 'reseau', admin_pwd_hash: 'secret' },
    { id: CLUB_X, name: 'Club X', city: 'Lyon', status: 'trial', plan: 'essentiel', trial_ends_at: '2026-12-01T00:00:00Z', admin_pwd_hash: 'secret' },
  ],
  admins: [
    { id: 'owner', email: 'owner@bcc.fr', password_hash: 'h1' },
    { id: 'coadmin', email: 'co@bcc.fr', password_hash: 'h2' },
    { id: 'x', email: 'x@club.fr', password_hash: 'h3' },
  ],
  admin_club_links: [
    { admin_id: 'coadmin', club_id: BCC_CLUB_ID, created_at: '2026-09-01T00:00:00Z' },
    { admin_id: 'owner', club_id: BCC_CLUB_ID, created_at: '2026-01-01T00:00:00Z' },
    { admin_id: 'x', club_id: CLUB_X, created_at: '2026-10-20T00:00:00Z' },
  ],
  comedians: [{ club_id: CLUB_X }, { club_id: CLUB_X }, { club_id: BCC_CLUB_ID }],
};

globalThis.fetch = async (url) => {
  const [table, query = ''] = String(url).split('/rest/v1/')[1].split('?');
  const params = new URLSearchParams(query);
  let rows = db[table].slice();
  for (const [k, v] of params) {
    if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === v.slice(3));
  }
  if (params.get('order') === 'created_at.asc') rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (params.get('limit')) rows = rows.slice(0, Number(params.get('limit')));
  return { ok: true, status: 200, json: async () => rows, text: async () => '' };
};

function call(adminId) {
  const req = { method: 'POST', headers: {}, body: {} };
  if (adminId) req.headers.authorization = 'Bearer ' + issueAdminToken(adminId, [{ id: BCC_CLUB_ID, name: 'BCC' }], BCC_CLUB_ID).token;
  const res = { statusCode: 200, setHeader() {}, end() { return res; } };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return handler(req, res).then(() => res);
}

test('sans session : 401', async () => {
  assert.equal((await call(null)).statusCode, 401);
});

test('co-admin du BCC invité après coup : 403', async () => {
  assert.equal((await call('coadmin')).statusCode, 403);
});

test('fondateur du BCC : liste complète, sans aucun hash', async () => {
  const res = await call('owner');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accounts, 3);
  assert.equal(res.body.clubs[0].id, CLUB_X); // plus récent en premier
  const x = res.body.clubs[0];
  assert.deepEqual(x.admins, ['x@club.fr']);
  assert.equal(x.comedians, 2);
  assert.equal(x.signed_up_at, '2026-10-20T00:00:00Z');
  assert.ok(!JSON.stringify(res.body).includes('secret'));
  assert.ok(!JSON.stringify(res.body).includes('password_hash'));
});
