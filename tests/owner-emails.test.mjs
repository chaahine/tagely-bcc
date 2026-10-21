// ════════════════════════════════════════════════════════════════════════
// Tests — bloc Emails de /projets.html (api/owner-emails.js)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Ce qui compte : réservé au fondateur du BCC, et chaque email affiche son
// état le plus avancé — un rebond l'emporte toujours sur « délivré ».

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.BREVO_API_KEY = 'test-brevo-key';

const { issueAdminToken, BCC_CLUB_ID } = await import('../api/_lib.js');
const { default: handler, summarizeEvents } = await import('../api/owner-emails.js');

const events = [
  { messageId: 'a', email: 'x@club.fr', subject: 'Rappel dispos', date: '2026-10-20T10:00:02Z', event: 'opened' },
  { messageId: 'a', email: 'x@club.fr', subject: 'Rappel dispos', date: '2026-10-20T10:00:01Z', event: 'delivered' },
  { messageId: 'a', email: 'x@club.fr', subject: 'Rappel dispos', date: '2026-10-20T10:00:00Z', event: 'requests' },
  { messageId: 'b', email: 'y@club.fr', subject: 'Invitation', date: '2026-10-21T09:00:00Z', event: 'requests' },
  { messageId: 'b', email: 'y@club.fr', subject: 'Invitation', date: '2026-10-21T09:00:01Z', event: 'hardBounces' },
];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('aggregatedReport')) return { ok: true, status: 200, json: async () => ({ requests: 2, delivered: 1, uniqueOpens: 1, uniqueClicks: 0, hardBounces: 1 }) };
  if (u.includes('/events')) return { ok: true, status: 200, json: async () => ({ events }) };
  const rows = [{ admin_id: 'owner', club_id: BCC_CLUB_ID, created_at: '2026-01-01T00:00:00Z' }];
  return { ok: true, status: 200, json: async () => rows, text: async () => '' };
};

function call(adminId) {
  const headers = adminId ? { authorization: 'Bearer ' + issueAdminToken(adminId, [{ id: BCC_CLUB_ID, name: 'BCC' }], BCC_CLUB_ID).token } : {};
  const res = { statusCode: 200, setHeader() {}, end() { return res; } };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return handler({ method: 'POST', headers, body: {} }, res).then(() => res);
}

test('un email = son état le plus avancé, le rebond l\'emporte', () => {
  const out = summarizeEvents(events);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(m => m.status), ['hardBounces', 'opened']); // plus récent d'abord
});

test('sans session : 401 ; autre admin : 403', async () => {
  assert.equal((await call(null)).statusCode, 401);
  assert.equal((await call('quelqu-un')).statusCode, 403);
});

test('fondateur : totaux et emails récents', async () => {
  const res = await call('owner');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totals.sent, 2);
  assert.equal(res.body.totals.bounced, 1);
  assert.equal(res.body.recent[0].email, 'y@club.fr');
});
