// ════════════════════════════════════════════════════════════════════════
// Tests — chantier "notifications-stats" (réconcilié avec fix/club-identity-critical)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/notifications-stats.test.mjs
//
// Couvre les chantiers serveur de cette branche :
//  1. Email admin sur annulation/modification (api/portal-write.js,
//     helper sendTransactionalEmail dans api/_lib.js, réutilisé par
//     api/email.js).
//  2. Rappel automatique de dispos (api/cron-dispo-reminders.js), qui lit
//     clubs.dispo_deadline_day directement en base.
//
// La persistance de la deadline dispos elle-même (Réglages > Infos du club)
// est couverte par tests/club-identity.test.mjs (action 'updateClub',
// commune aux deux chantiers réconciliés — voir la note de réconciliation :
// les actions 'getSettings'/'updateDeadline' initialement prévues ici ont
// été éliminées au profit de 'updateClub', qui écrit déjà name/city/
// dispo_deadline_day en un seul appel scopé au club authentifié).
//
// Même honnêteté que les tests multitenant existants : le VRAI code des
// handlers est exécuté, avec `fetch` global mocké (aucun appel réseau réel,
// ni vers Supabase ni vers Brevo). Le widget dashboard (chantier 3, pur
// front) n'a pas de logique serveur à tester ici — voir index.html
// renderDashboardStats(), vérifié par lecture de code + test manuel navigateur.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.BREVO_API_KEY = 'test-brevo-key';
process.env.CRON_SECRET = 'test-cron-secret';

const { issueAdminToken, sendTransactionalEmail, BCC_CLUB_ID } = await import('../api/_lib.js');

// ── Petit harnais de mock fetch — identique à celui de multitenant-scoping.test.mjs ──
function installFetchMock(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const canned = responder ? responder(call) : undefined;
    return { ok: true, status: 200, json: async () => (canned !== undefined ? canned : []), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function fakeReq({ token, body }) {
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

// ════════════════════════════════════════════════════════════════════════
// 1. sendTransactionalEmail() — helper partagé Brevo (api/_lib.js)
// ════════════════════════════════════════════════════════════════════════

test('sendTransactionalEmail : construit le payload Brevo attendu (sender = club, to, subject, htmlContent)', async () => {
  const mock = installFetchMock((call) => {
    assert.equal(call.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(call.method, 'POST');
    assert.equal(call.body.sender.name, 'Beer Comedy Club');
    assert.equal(call.body.to[0].email, 'admin@bcc.fr');
    assert.equal(call.body.subject, 'Sujet test');
    assert.equal(call.body.htmlContent, '<p>hello</p>');
    assert.equal(call.body.replyTo, undefined, 'pas de replyTo si replyToEmail absent');
    return {};
  });
  const result = await sendTransactionalEmail({ to: 'admin@bcc.fr', subject: 'Sujet test', html: '<p>hello</p>', senderName: 'Beer Comedy Club' });
  mock.restore();
  assert.equal(result.success, true);
});

test('sendTransactionalEmail : ajoute replyTo quand replyToEmail est fourni', async () => {
  const mock = installFetchMock((call) => {
    assert.deepEqual(call.body.replyTo, { email: 'contact@bcc.fr', name: 'Beer Comedy Club' });
    return {};
  });
  await sendTransactionalEmail({ to: 'x@x.fr', subject: 's', html: '<p>h</p>', senderName: 'Beer Comedy Club', replyToEmail: 'contact@bcc.fr' });
  mock.restore();
});

test('sendTransactionalEmail : une erreur Brevo (data.code présent) renvoie success:false sans lever d\'exception', async () => {
  const mock = installFetchMock(() => ({ code: 'invalid_parameter', message: 'sender not valid' }));
  const result = await sendTransactionalEmail({ to: 'x@x.fr', subject: 's', html: '<p>h</p>' });
  mock.restore();
  assert.equal(result.success, false);
  assert.equal(result.error, 'sender not valid');
});

test('sendTransactionalEmail : paramètres manquants (to/subject/html) → success:false, aucun appel réseau', async () => {
  const mock = installFetchMock();
  const result = await sendTransactionalEmail({ to: '', subject: 's', html: 'h' });
  mock.restore();
  assert.equal(result.success, false);
  assert.equal(mock.calls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 2. api/email.js — regression après refactor vers sendTransactionalEmail()
// ════════════════════════════════════════════════════════════════════════

const emailHandler = (await import('../api/email.js')).default;

test('email.js : envoi réussi utilise le nom du club (lu en base) comme expéditeur et son admin_email comme Reply-To', async () => {
  // Chantier "multi-club-admin" : token à un seul club (BCC_CLUB_ID à la
  // fois accessible_clubs[0] et active_club_id) — suffisant ici, email.js
  // lit auth.active_club_id.
  const { token } = issueAdminToken('admin-bcc', [{ id: BCC_CLUB_ID, name: 'BCC' }], BCC_CLUB_ID);
  const mock = installFetchMock((call) => {
    if (call.url.includes('/clubs')) return [{ name: 'Beer Comedy Club', admin_email: 'bruce@bcc.fr' }];
    if (call.url.includes('brevo.com')) {
      assert.equal(call.body.sender.name, 'Beer Comedy Club');
      assert.deepEqual(call.body.replyTo, { email: 'bruce@bcc.fr', name: 'Beer Comedy Club' });
      return {};
    }
    return [];
  });
  const req = fakeReq({ token, body: { to: 'humoriste@test.fr', subject: 'Test', html: '<p>hi</p>' } });
  const res = fakeRes();
  await emailHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

test('email.js : sans token admin → 401, aucun appel Brevo', async () => {
  const mock = installFetchMock();
  const req = fakeReq({ body: { to: 'x@x.fr', subject: 's', html: 'h' } });
  const res = fakeRes();
  await emailHandler(req, res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(mock.calls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 3. api/portal-write.js — cancelDates envoie désormais un email admin EN
//    PLUS du message chat_messages existant (chantier 1)
// ════════════════════════════════════════════════════════════════════════

const portalWriteHandler = (await import('../api/portal-write.js')).default;

function withClubsAndComedianMock({ portalCode = 'BCCD25', clubId = BCC_CLUB_ID, adminEmail = 'bruce@bcc.fr', clubName = 'Beer Comedy Club' } = {}) {
  return installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      if (call.url.includes(`portal_code=eq.${portalCode}`)) return [{ id: clubId, status: 'active' }];
      // 2e lecture clubs (par id, pour name/admin_email) déclenchée par l'envoi d'email
      if (call.url.includes(`id=eq.${encodeURIComponent(clubId)}`)) return [{ name: clubName, admin_email: adminEmail }];
      return [];
    }
    if (call.url.includes('/comedians') && call.method === 'GET') return [{ id: 'c1', name: 'Test Humoriste' }];
    if (call.url.includes('brevo.com')) return {};
    return [];
  });
}

test('cancelDates : insère toujours le message chat_messages existant (AJOUT, pas remplacement)', async () => {
  const mock = withClubsAndComedianMock();
  const req = fakeReq({ body: { action: 'cancelDates', payload: {
    code: 'BCCD25', comedianId: 'c1', comedianName: 'Test Humoriste', slotKeys: ['2026-09-11-20h15'],
  } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  mock.restore();

  const chatPost = mock.calls.find(c => c.method === 'POST' && c.url.includes('/chat_messages'));
  assert.ok(chatPost, 'le message chat_messages doit toujours être créé');
  assert.match(chatPost.body.text, /🚨 ANNULATION/);
  assert.equal(res.body.success, true);
});

test('cancelDates : envoie AUSSI un vrai email à clubs.admin_email, en plus du chat', async () => {
  const mock = withClubsAndComedianMock({ adminEmail: 'bruce@bcc.fr', clubName: 'Beer Comedy Club' });
  const req = fakeReq({ body: { action: 'cancelDates', payload: {
    code: 'BCCD25', comedianId: 'c1', comedianName: 'Test Humoriste', slotKeys: ['2026-09-11-20h15'], details: 'Vendredi 11 septembre à 20:15',
  } } });
  await portalWriteHandler(req, fakeRes());
  mock.restore();

  const brevoCall = mock.calls.find(c => c.url.includes('brevo.com'));
  assert.ok(brevoCall, 'un email Brevo doit être envoyé à l\'admin du club');
  assert.equal(brevoCall.body.to[0].email, 'bruce@bcc.fr');
  assert.match(brevoCall.body.subject, /Test Humoriste/);
  assert.match(brevoCall.body.subject, /annulé/);
});

test('cancelDates : mode "modify" produit un sujet d\'email différent (📝 modification, pas 🚨 annulation)', async () => {
  const mock = withClubsAndComedianMock();
  const req = fakeReq({ body: { action: 'cancelDates', payload: {
    code: 'BCCD25', comedianId: 'c1', comedianName: 'Test Humoriste', slotKeys: ['2026-09-11-20h15'], mode: 'modify',
  } } });
  await portalWriteHandler(req, fakeRes());
  mock.restore();

  const brevoCall = mock.calls.find(c => c.url.includes('brevo.com'));
  assert.match(brevoCall.body.subject, /modifié/);
});

test('cancelDates : le club n\'a pas d\'admin_email → aucun email tenté, mais l\'annulation réussit quand même', async () => {
  const mock = installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      if (call.url.includes('portal_code=eq.BCCD25')) return [{ id: BCC_CLUB_ID, status: 'active' }];
      return [{ name: 'Beer Comedy Club', admin_email: null }]; // pas d'admin_email
    }
    if (call.url.includes('/comedians') && call.method === 'GET') return [{ id: 'c1', name: 'Test' }];
    return [];
  });
  const req = fakeReq({ body: { action: 'cancelDates', payload: {
    code: 'BCCD25', comedianId: 'c1', comedianName: 'Test', slotKeys: ['2026-09-11-20h15'],
  } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  mock.restore();

  assert.equal(mock.calls.some(c => c.url.includes('brevo.com')), false);
  assert.equal(res.body.success, true, 'cancelDates doit rester un succès même sans email possible');
});

test('cancelDates : un échec Brevo (exception réseau) ne fait jamais échouer l\'annulation elle-même', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('brevo.com')) throw new Error('Brevo indisponible');
    if (String(url).includes('/clubs')) {
      const isPortalLookup = String(url).includes('portal_code=eq.BCCD25');
      return { ok: true, status: 200, json: async () => (isPortalLookup ? [{ id: BCC_CLUB_ID, status: 'active' }] : [{ name: 'BCC', admin_email: 'bruce@bcc.fr' }]), text: async () => '' };
    }
    if (String(url).includes('/comedians')) return { ok: true, status: 200, json: async () => [{ id: 'c1', name: 'Test' }], text: async () => '' };
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  const req = fakeReq({ body: { action: 'cancelDates', payload: {
    code: 'BCCD25', comedianId: 'c1', comedianName: 'Test', slotKeys: ['2026-09-11-20h15'],
  } } });
  const res = fakeRes();
  await portalWriteHandler(req, res);
  globalThis.fetch = original;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

// ════════════════════════════════════════════════════════════════════════
// 4. api/cron-dispo-reminders.js
// ════════════════════════════════════════════════════════════════════════

const { default: cronHandler, isTargetDay, targetMonth, runDispoReminders } = await import('../api/cron-dispo-reminders.js');

function fakeCronReq(bearer) {
  return { method: 'GET', headers: bearer ? { authorization: `Bearer ${bearer}` } : {} };
}

test('isTargetDay : vrai seulement le 1er, le 5 et le 8 du mois', () => {
  assert.equal(isTargetDay(new Date(2026, 7, 1)), true);
  assert.equal(isTargetDay(new Date(2026, 7, 5)), true);
  assert.equal(isTargetDay(new Date(2026, 7, 8)), true);
  assert.equal(isTargetDay(new Date(2026, 7, 2)), false);
  assert.equal(isTargetDay(new Date(2026, 7, 15)), false);
  assert.equal(isTargetDay(new Date(2026, 7, 31)), false);
});

test('targetMonth : mois cible = TOUJOURS le mois calendaire suivant (même convention que index.html getDispoTargetMonth)', () => {
  assert.deepEqual(targetMonth(new Date(2026, 0, 15)), { year: 2026, month: 1 }); // janvier -> février
  assert.deepEqual(targetMonth(new Date(2026, 0, 1)), { year: 2026, month: 1 });  // même le 1er du mois, pas de seuil au 20
  assert.deepEqual(targetMonth(new Date(2026, 11, 25)), { year: 2027, month: 0 }); // décembre -> janvier année+1
});

test('cron handler : CRON_SECRET absent côté serveur → 500, route désactivée par sécurité', async () => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const mock = installFetchMock();
  const res = fakeRes();
  await cronHandler(fakeCronReq('whatever'), res);
  mock.restore();
  process.env.CRON_SECRET = saved;
  assert.equal(res.statusCode, 500);
  assert.equal(mock.calls.length, 0);
});

test('cron handler : mauvais secret → 401, aucun appel Supabase/Brevo', async () => {
  const mock = installFetchMock();
  const res = fakeRes();
  await cronHandler(fakeCronReq('mauvais-secret'), res);
  mock.restore();
  assert.equal(res.statusCode, 401);
  assert.equal(mock.calls.length, 0);
});

// Fige `new Date()`/`Date.now()` le temps d'exécuter fn(), pour tester
// déterministement le branchement date-dépendant du handler (isTargetDay)
// indépendamment du jour réel d'exécution des tests.
async function withFixedNow(fixedDate, fn) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) { super(fixedDate.getTime()); return; }
      super(...args);
    }
    static now() { return fixedDate.getTime(); }
  }
  globalThis.Date = FixedDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

test('cron handler : bon secret, mais pas un jour de rappel (le 15) → skipped, aucun appel Supabase/Brevo', async () => {
  const mock = installFetchMock();
  const res = fakeRes();
  await withFixedNow(new Date(2026, 7, 15), () => cronHandler(fakeCronReq('test-cron-secret'), res));
  mock.restore();
  assert.equal(res.body.skipped, true);
  assert.equal(mock.calls.length, 0);
});

test('cron handler : bon secret + jour de rappel (le 5) → exécute réellement runDispoReminders (appels Supabase déclenchés)', async () => {
  const mock = installFetchMock(() => []); // aucun club actif -> boucle vide, mais les appels doivent avoir lieu
  const res = fakeRes();
  await withFixedNow(new Date(2026, 7, 5), () => cronHandler(fakeCronReq('test-cron-secret'), res));
  mock.restore();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(mock.calls.some(c => c.url.includes('/clubs')), 'le handler doit interroger clubs quand c\'est un jour cible');
});

test('runDispoReminders : filtre les clubs suspendus, ignore les comédiens sans email, n\'envoie rien à qui a déjà répondu pour le mois cible, envoie aux autres', async () => {
  const now = new Date(2026, 7, 1); // 1er août 2026 -> mois cible = septembre 2026
  const mock = installFetchMock((call) => {
    if (call.url.includes('/clubs') && call.method === 'GET') {
      assert.ok(call.url.includes('status=neq.suspended'), 'doit filtrer les clubs suspendus');
      return [{ id: BCC_CLUB_ID, name: 'Beer Comedy Club', admin_email: 'bruce@bcc.fr', portal_code: 'BCCD25', dispo_deadline_day: null }];
    }
    if (call.url.includes('/comedians') && call.method === 'GET') {
      assert.ok(call.url.includes('active=eq.true'));
      return [
        { id: 'c1', name: 'Sans Email', email: '' },
        { id: 'c2', name: 'A Déjà Répondu', email: 'c2@test.fr' },
        { id: 'c3', name: 'Pas Répondu', email: 'c3@test.fr' },
      ];
    }
    if (call.url.includes('/dispos') && call.method === 'GET') {
      assert.ok(call.url.includes('slot_key=gte.2026-09-01') && call.url.includes('slot_key=lt.2026-10-01'), 'plage mois cible = septembre 2026');
      if (call.url.includes('comedian_id=eq.c2')) return [{ slot_key: '2026-09-05-20h15' }];
      return [];
    }
    if (call.url.includes('brevo.com')) return {};
    return [];
  });

  const result = await runDispoReminders(now);
  mock.restore();

  assert.equal(result.targetMonth, '2026-09');
  assert.equal(result.report.length, 1);
  const clubReport = result.report[0];
  assert.equal(clubReport.noEmail, 1);
  assert.equal(clubReport.alreadyReplied, 1);
  assert.equal(clubReport.sent, 1);

  const brevoCalls = mock.calls.filter(c => c.url.includes('brevo.com'));
  assert.equal(brevoCalls.length, 1);
  assert.equal(brevoCalls[0].body.to[0].email, 'c3@test.fr');
  assert.match(brevoCalls[0].body.subject, /septembre 2026/);
  // deadline par défaut (12) car dispo_deadline_day est NULL pour ce club
  assert.match(brevoCalls[0].body.htmlContent, /12 août 2026/);
});

console.log('\nTests notifications-stats terminés — voir le résumé du test runner ci-dessus (node --test).');
