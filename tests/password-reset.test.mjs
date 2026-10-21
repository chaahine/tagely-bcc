// ════════════════════════════════════════════════════════════════════════
// Tests — mot de passe oublié (api/password-reset.js)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Ce qui compte : la demande ne révèle jamais si un email a un compte, le
// lien ne sert qu'une fois, et un token d'un autre type n'est pas accepté.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.BREVO_API_KEY = 'test-brevo-key';
process.env.STAGELY_PUBLIC_URL = 'https://stagely.test';

const { sha256Hex, issueResetToken, issueInviteToken, verifyAdminToken } = await import('../api/_lib.js');
const handler = (await import('../api/password-reset.js')).default;

const db = { admins: [{ id: 'a1', email: 'patron@club.fr', password_hash: sha256Hex('ancien') }] };
const mails = [];

globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.brevo.com')) {
    mails.push(JSON.parse(opts.body));
    return { ok: true, status: 201, json: async () => ({ messageId: 'x' }), text: async () => '' };
  }
  const [table, query = ''] = String(url).split('/rest/v1/')[1].split('?');
  const params = new URLSearchParams(query);
  const match = r => [...params].every(([k, v]) => !v.startsWith('eq.') || String(r[k]) === v.slice(3));
  if ((opts.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => db[table].filter(match), text: async () => '' };
  if (opts.method === 'PATCH') { db[table].filter(match).forEach(r => Object.assign(r, JSON.parse(opts.body))); return { ok: true, status: 204, text: async () => '' }; }
  return { ok: false, status: 405, text: async () => '' };
};

function call(body) {
  const res = { statusCode: 200, setHeader() {}, end() { return res; } };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return handler({ method: 'POST', headers: {}, body }, res).then(() => res);
}

test('demande : même réponse que le compte existe ou non, email seulement si il existe', async () => {
  const inconnu = await call({ action: 'request', email: 'personne@nulle.part' });
  assert.equal(mails.length, 0);
  const connu = await call({ action: 'request', email: 'Patron@Club.fr' });
  assert.equal(mails.length, 1);
  assert.deepEqual(inconnu.body, connu.body);
  assert.equal(mails[0].to[0].email, 'patron@club.fr');
  assert.match(mails[0].htmlContent, /https:\/\/stagely\.test\/mot-de-passe\.html\?token=/);
});

test('confirmation : change le mot de passe, puis le même lien ne marche plus', async () => {
  const token = issueResetToken('a1', db.admins[0].password_hash).token;
  const ok = await call({ action: 'confirm', token, password: 'nouveau1' });
  assert.equal(ok.statusCode, 200);
  assert.equal(db.admins[0].password_hash, sha256Hex('nouveau1'));
  const again = await call({ action: 'confirm', token, password: 'pirate99' });
  assert.equal(again.statusCode, 400);
  assert.equal(db.admins[0].password_hash, sha256Hex('nouveau1'));
});

test('lien expiré, falsifié ou token d\'invitation : refusé', async () => {
  const expired = issueResetToken('a1', db.admins[0].password_hash, Date.now() - 2 * 3600 * 1000).token;
  assert.equal((await call({ action: 'confirm', token: expired, password: 'abcdef' })).statusCode, 400);
  const good = issueResetToken('a1', db.admins[0].password_hash).token;
  assert.equal((await call({ action: 'confirm', token: good.slice(0, -2) + 'xx', password: 'abcdef' })).statusCode, 400);
  const invite = issueInviteToken('club', 'patron@club.fr').token;
  assert.equal((await call({ action: 'confirm', token: invite, password: 'abcdef' })).statusCode, 400);
  // Et un token de reset ne vaut pas session admin.
  assert.equal(verifyAdminToken({ headers: { authorization: 'Bearer ' + good } }), null);
});

test('mot de passe trop court : refusé', async () => {
  const token = issueResetToken('a1', db.admins[0].password_hash).token;
  assert.equal((await call({ action: 'confirm', token, password: '123' })).statusCode, 400);
});
