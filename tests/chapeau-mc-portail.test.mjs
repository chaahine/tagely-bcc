// ════════════════════════════════════════════════════════════════════════
// Tests — chapeau saisi par le MC depuis son téléphone (2026-08)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node tests/chapeau-mc-portail.test.mjs
//
// Contexte : jusqu'ici hvSaveChapeau() (index.html) n'écrivait que dans
// localStorage['stagely_chapeau'], un stockage devenu mort depuis le passage
// du chapeau en persistance serveur — le MC voyait "✓ Chapeau enregistré !"
// alors que le montant n'atteignait jamais le serveur. La saisie passe
// désormais par api/portal-write.js, action 'saveChapeauEntry'.
//
// Couvre :
//  1. sanitizeChapeauEntry() — fonction pure, api/_lib.js (factorisée pour
//     que la route admin et la route MC calculent le même total).
//  2. api/portal-write.js, action saveChapeauEntry : code club invalide,
//     comédien inconnu du club, non-assigné au créneau, club non-Pro,
//     slot_key/montant invalides, et le cas nominal (upsert scopé club_id).
//
// Même méthode que tests/cachet-export-comptable.test.mjs : exécute le VRAI
// handler, `fetch` global mocké (jamais de vrai réseau ni de credential).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { sanitizeChapeauEntry } = await import('../api/_lib.js');
const portalWriteHandler = (await import('../api/portal-write.js')).default;

const PRO_CLUB_ID = '22222222-2222-4222-a222-222222222222';
const ESSENTIEL_CLUB_ID = '33333333-3333-4333-a333-333333333333';
const PRO_CODE = 'PROX25';
const ESSENTIEL_CODE = 'ESSX25';

const CLUBS_BY_ID = {
  [PRO_CLUB_ID]: { id: PRO_CLUB_ID, status: 'active', plan: 'pro', name: 'Club Pro' },
  [ESSENTIEL_CLUB_ID]: { id: ESSENTIEL_CLUB_ID, status: 'active', plan: 'essentiel', name: 'Club Essentiel' },
};
const CLUBS_BY_CODE = {
  [PRO_CODE]: CLUBS_BY_ID[PRO_CLUB_ID],
  [ESSENTIEL_CODE]: CLUBS_BY_ID[ESSENTIEL_CLUB_ID],
};

const MC_ID = 'marie_d';
const SLOT = '2026-08-12-20H15';

// Répond aux lectures Supabase du handler :
//  - GET /clubs?portal_code=eq.<code>  (résolution du code portail)
//  - GET /clubs?id=eq.<id>             (requireProAccess)
//  - GET /comedians?id=eq.<id>         (le comédien existe dans ce club)
//  - GET /assignments?slot_key=...     (le comédien est assigné à ce créneau)
function responder({ assignedSlots = [SLOT], knownComedians = [MC_ID] } = {}) {
  return (call) => {
    if (call.method !== 'GET') return undefined;
    if (call.url.includes('/clubs')) {
      const byCode = call.url.match(/portal_code=eq\.([^&]+)/);
      if (byCode) {
        const club = CLUBS_BY_CODE[decodeURIComponent(byCode[1])];
        return club ? [club] : [];
      }
      const byId = call.url.match(/id=eq\.([^&]+)/);
      if (byId) {
        const club = CLUBS_BY_ID[decodeURIComponent(byId[1])];
        return club ? [club] : [];
      }
    }
    if (call.url.includes('/comedians')) {
      const m = call.url.match(/id=eq\.([^&]+)/);
      const id = m ? decodeURIComponent(m[1]) : null;
      return knownComedians.includes(id) ? [{ id, name: 'Marie D.' }] : [];
    }
    if (call.url.includes('/assignments')) {
      const m = call.url.match(/slot_key=eq\.([^&]+)/);
      const key = m ? decodeURIComponent(m[1]) : null;
      return assignedSlots.includes(key) ? [{ comedian_id: MC_ID }] : [];
    }
    return undefined;
  };
}

function installFetchMock(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const canned = respond ? respond(call) : undefined;
    return { ok: true, status: 200, json: async () => (canned !== undefined ? canned : []), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
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

async function saveAsMc(payload, opts) {
  const mock = installFetchMock(responder(opts));
  const res = fakeRes();
  try {
    await portalWriteHandler(
      { method: 'POST', headers: {}, body: { action: 'saveChapeauEntry', payload } },
      res,
    );
  } finally {
    mock.restore();
  }
  const writes = mock.calls.filter((c) => c.method === 'POST' && c.url.includes('chapeau_entries'));
  return { res, calls: mock.calls, writes };
}

const NOMINAL = { code: PRO_CODE, comedianId: MC_ID, slot_key: SLOT, amount_especes: 120, amount_cb: 80, amount_total: 200 };

// ════════════════════════════════════════════════════════════════════════
// sanitizeChapeauEntry() — règle de calcul partagée admin / MC
// ════════════════════════════════════════════════════════════════════════

test('sanitizeChapeauEntry : total = espèces + CB', () => {
  const row = sanitizeChapeauEntry({ slot_key: SLOT, amount_especes: 120, amount_cb: 80, amount_total: 999 });
  assert.equal(row.amount_total, 200, 'le total est recalculé, jamais celui envoyé par le client');
});

test('sanitizeChapeauEntry : repli sur le montant au forfait quand espèces et CB sont à zéro', () => {
  const row = sanitizeChapeauEntry({ slot_key: SLOT, amount_especes: 0, amount_cb: 0, amount_total: 30 });
  assert.equal(row.amount_total, 30);
  assert.equal(row.amount_especes, 0);
  assert.equal(row.amount_cb, 0);
});

test('sanitizeChapeauEntry : slot_key mal formé ou montant nul -> rejet', () => {
  assert.equal(sanitizeChapeauEntry({ slot_key: 'pas-une-cle', amount_especes: 50 }), null);
  assert.equal(sanitizeChapeauEntry({ slot_key: SLOT, amount_especes: 0, amount_cb: 0, amount_total: 0 }), null);
  assert.equal(sanitizeChapeauEntry(null), null);
});

test('sanitizeChapeauEntry : montants négatifs neutralisés, jamais un total négatif', () => {
  assert.equal(sanitizeChapeauEntry({ slot_key: SLOT, amount_especes: -500, amount_cb: -500, amount_total: -500 }), null);
  const row = sanitizeChapeauEntry({ slot_key: SLOT, amount_especes: -500, amount_cb: 80 });
  assert.equal(row.amount_total, 80, 'la part négative est ramenée à 0');
});

// ════════════════════════════════════════════════════════════════════════
// api/portal-write.js — action saveChapeauEntry
// ════════════════════════════════════════════════════════════════════════

test('cas nominal : le MC assigné au créneau enregistre, upsert scopé sur son club', async () => {
  const { res, writes } = await saveAsMc(NOMINAL);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(writes.length, 1, 'une seule écriture chapeau_entries');
  assert.match(writes[0].url, /on_conflict=club_id,slot_key/, 'upsert, pas un insert qui doublonnerait');
  const row = writes[0].body[0];
  assert.equal(row.club_id, PRO_CLUB_ID, 'club_id imposé par le serveur, jamais reçu du client');
  assert.equal(row.slot_key, SLOT);
  assert.equal(row.amount_total, 200);
});

test('le club_id ne peut pas être forcé depuis le payload du client', async () => {
  const { writes } = await saveAsMc({ ...NOMINAL, club_id: ESSENTIEL_CLUB_ID });
  assert.equal(writes[0].body[0].club_id, PRO_CLUB_ID, 'seul le code portail décide du club');
});

test('code club inconnu -> 403, aucune écriture', async () => {
  const { res, writes } = await saveAsMc({ ...NOMINAL, code: 'INCONNU' });
  assert.equal(res.statusCode, 403);
  assert.equal(writes.length, 0);
});

test('comédien inconnu de ce club -> 404, aucune écriture', async () => {
  const { res, writes } = await saveAsMc({ ...NOMINAL, comedianId: 'intrus' }, { knownComedians: [MC_ID] });
  assert.equal(res.statusCode, 404);
  assert.equal(writes.length, 0);
});

test('comédien connu mais NON assigné à ce créneau -> 403, aucune écriture', async () => {
  const { res, writes } = await saveAsMc(NOMINAL, { assignedSlots: ['2026-08-13-21H30'] });
  assert.equal(res.statusCode, 403);
  assert.equal(writes.length, 0, 'on n’invente pas la recette d’une soirée où l’on ne jouait pas');
});

test('club non-Pro -> 403 (même verrou de palier que côté admin), aucune écriture', async () => {
  const { res, writes } = await saveAsMc({ ...NOMINAL, code: ESSENTIEL_CODE });
  assert.equal(res.statusCode, 403);
  assert.equal(writes.length, 0);
});

test('slot_key invalide -> 400 avant toute lecture de comédien', async () => {
  const { res, calls, writes } = await saveAsMc({ ...NOMINAL, slot_key: 'bidon' });
  assert.equal(res.statusCode, 400);
  assert.equal(writes.length, 0);
  assert.equal(calls.filter((c) => c.url.includes('/comedians')).length, 0);
});

test('montant nul -> 400, aucune écriture', async () => {
  const { res, writes } = await saveAsMc({ ...NOMINAL, amount_especes: 0, amount_cb: 0, amount_total: 0 });
  assert.equal(res.statusCode, 400);
  assert.equal(writes.length, 0);
});

test('comedianId manquant -> 400, aucune écriture', async () => {
  const { res, writes } = await saveAsMc({ code: PRO_CODE, slot_key: SLOT, amount_especes: 50 });
  assert.equal(res.statusCode, 400);
  assert.equal(writes.length, 0);
});
