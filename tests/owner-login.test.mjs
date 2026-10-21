// ════════════════════════════════════════════════════════════════════════
// Tests — connexion « mot de passe seul » de /projets.html (api/owner-login.js)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Ce qui compte : seul le mot de passe du FONDATEUR du BCC ouvre le tableau
// de bord ; celui d'un co-admin, même valide pour Stagely, est refusé.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { sha256Hex, verifyAdminToken, BCC_CLUB_ID } = await import('../api/_lib.js');
const handler = (await import('../api/owner-login.js')).default;

const db = {
  admins: [
    { id: 'owner', password_hash: sha256Hex('patron123') },
    { id: 'coadmin', password_hash: sha256Hex('assistant1') },
  ],
  admin_club_links: [
    { admin_id: 'coadmin', club_id: BCC_CLUB_ID, created_at: '2026-09-01T00:00:00Z' },
    { admin_id: 'owner', club_id: BCC_CLUB_ID, created_at: '2026-01-01T00:00:00Z' },
  ],
  clubs: [{ id: BCC_CLUB_ID, name: 'BCC' }],
};

globalThis.fetch = async (url) => {
  const [table, query = ''] = String(url).split('/rest/v1/')[1].split('?');
  const params = new URLSearchParams(query);
  let rows = db[table].slice();
  for (const [k, v] of params) {
    if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === v.slice(3));
    if (v.startsWith('in.(')) { const ids = v.slice(4, -1).split(','); rows = rows.filter(r => ids.includes(String(r[k]))); }
  }
  if (params.get('order') === 'created_at.asc') rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (params.get('limit')) rows = rows.slice(0, Number(params.get('limit')));
  return { ok: true, status: 200, json: async () => rows, text: async () => '' };
};

function call(password) {
  const res = { statusCode: 200, setHeader() {}, end() { return res; } };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return handler({ method: 'POST', headers: {}, body: { password } }, res).then(() => res);
}

test('mot de passe du fondateur : token valide pour son compte', async () => {
  const res = await call('patron123');
  assert.equal(res.statusCode, 200);
  const claims = verifyAdminToken({ headers: { authorization: 'Bearer ' + res.body.token } });
  assert.equal(claims.admin_id, 'owner');
  assert.equal(claims.active_club_id, BCC_CLUB_ID);
});

test('mot de passe du co-admin ou faux : 401, même message', async () => {
  const co = await call('assistant1');
  const faux = await call('nimportequoi');
  assert.equal(co.statusCode, 401);
  assert.equal(faux.statusCode, 401);
  assert.deepEqual(co.body, faux.body);
});
