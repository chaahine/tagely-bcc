// ════════════════════════════════════════════════════════════════════════
// Tests — plafond d'humoristes du palier Essentiel (chantier tarifs, 2026-09)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Offre unique depuis le 24/10/2026 (49,90 € HT/mois, tout inclus) : plus
// aucun plafond. Ces tests vérifient qu'aucun palier historique ne bride.
//
// Même méthode que les fichiers voisins : le VRAI handler api/admin-write.js
// est exécuté, seul `fetch` est mocké — aucun credential ni réseau réel.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { issueAdminToken, ESSENTIEL_MAX_COMEDIANS, PLAN_CAPS, COMEDIAN_PRIOS } = await import('../api/_lib.js');
const adminWriteHandler = (await import('../api/admin-write.js')).default;

const CLUB_ID = '22222222-2222-4222-a222-222222222222';

// Mock Supabase : répond au club (status/plan) et au comptage d'humoristes.
function installFetchMock({ status = 'active', plan = 'essentiel', existing = 0 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    let canned = [];
    if (call.method === 'GET' && url.includes('/clubs') && url.includes('select=id,status,plan')) {
      canned = [{ id: CLUB_ID, status, plan }];
    } else if (call.method === 'GET' && url.includes('/comedians') && url.includes('select=id')) {
      canned = Array.from({ length: existing }, (_, i) => ({ id: `existing-${i}` }));
    }
    return { ok: true, status: 200, json: async () => canned, text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function comedians(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Humoriste ${i}` }));
}

function fakeReq(token, payload) {
  return { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { action: 'sync', payload } };
}
function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  res.end = () => { res.body = undefined; return res; };
  return res;
}

function tokenForClub() {
  return issueAdminToken(`admin-${CLUB_ID}`, [{ id: CLUB_ID, name: 'Club test' }], CLUB_ID).token;
}

async function sync({ count, existing = 0, plan = 'essentiel', status = 'active' }) {
  const mock = installFetchMock({ status, plan, existing });
  const res = fakeRes();
  await adminWriteHandler(fakeReq(tokenForClub(), { comedians: comedians(count) }), res);
  mock.restore();
  const wrote = mock.calls.some(c => c.method === 'POST' && c.url.includes('/comedians'));
  return { res, wrote, calls: mock.calls };
}

// Offre unique (24/10/2026) : plus aucun plafond d'humoristes, quel que soit
// le palier historique enregistré en base.
test('offre unique : aucun palier ne plafonne les humoristes', () => {
  assert.equal(ESSENTIEL_MAX_COMEDIANS, null);
  for (const plan of ['essentiel', 'pro', 'reseau']) assert.equal(PLAN_CAPS[plan].maxComedians, null, plan);
});

for (const plan of ['essentiel', 'pro', 'reseau']) {
  test(`offre unique : un club actif « ${plan} » enregistre 200 humoristes`, async () => {
    const { res, wrote } = await sync({ count: 200, plan });
    assert.equal(res.statusCode, 200);
    assert.ok(wrote);
  });
}

test("pendant l'essai, aucune limite non plus", async () => {
  const { res, wrote } = await sync({ count: 200, plan: 'essentiel', status: 'trial' });
  assert.equal(res.statusCode, 200);
  assert.ok(wrote);
});

test('un petit club ne paie jamais l\'aller-retour de comptage', async () => {
  const { calls } = await sync({ count: 10 });
  // La vérification d'appartenance (foreignComedianIds, club_id=neq.) part
  // toujours, et c'est voulu : seul le COMPTAGE du plafond doit être évité.
  const counted = calls.some(c => c.method === 'GET' && c.url.includes('/comedians') && !c.url.includes('club_id=neq.'));
  assert.equal(counted, false, 'sous le plafond, aucune requête de comptage ne doit partir');
});

// ── Cohérence offre affichée ↔ offre appliquée ─────────────────────────────
// La carte « Mon abonnement » (index.html) promet tout inclus et sans limite :
// le serveur (PLAN_CAPS) doit l'appliquer, et le client ne doit rien brider.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const indexHtml = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8',
);

test('offre affichée : 49,90 € et « sans limite », ce que le serveur applique', () => {
  assert.match(indexHtml, /const STAGELY_PRICE = '49,90 € HT \/ mois';/);
  assert.match(indexHtml, /Humoristes et équipe sans limite/);
  for (const plan of ['essentiel', 'pro', 'reseau']) {
    assert.deepEqual(PLAN_CAPS[plan], { maxComedians: null, maxClubAdmins: null, tour: true, money: true, accountingExport: false }, plan);
  }
  assert.ok(!/const PLAN_LADDER/.test(indexHtml), "l'ancienne grille à trois paliers ne doit plus être affichée");
});

test("offre unique : fonctions Pro ouvertes à tous, export comptable fermé à tous", () => {
  const fn = (name) => indexHtml.match(new RegExp(`function ${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.match(fn('hasProAccess')[1], /return true;/);
  assert.match(fn('hasAccountingExport')[1], /return false;/);
  assert.ok(!/✓ Export comptable/.test(indexHtml), "l'offre affichée ne doit pas promettre l'export comptable");
});

// ── Priorité d'un humoriste : énumération fermée ───────────────────────────
// Découvert en peuplant le club de démonstration : une priorité hors de
// l'énumération connue arrivait intacte en base et s'affichait « undefined »
// sur la fiche du comédien, parce que l'UI fait un accès direct au
// dictionnaire de libellés. Corrigé des deux côtés — ici on verrouille la
// source.

test('une priorité inconnue est ramenée à "new" plutôt que stockée telle quelle', async () => {
  const mock = installFetchMock({ plan: 'pro' });
  const res = fakeRes();
  await adminWriteHandler(
    fakeReq(tokenForClub(), { comedians: [
      { id: 'c1', name: 'Test A', prio: 'fav' },        // invalide
      { id: 'c2', name: 'Test B', prio: 'headliner' },  // valide
      { id: 'c3', name: 'Test C' },                     // absente
    ] }),
    res,
  );
  mock.restore();
  const post = mock.calls.find(c => c.method === 'POST' && c.url.includes('/comedians'));
  assert.ok(post, 'les fiches doivent être enregistrées');
  assert.deepEqual(post.body.map(r => r.prio), ['new', 'headliner', 'new']);
});

test('les trois priorités affichables sont celles que le serveur accepte', () => {
  assert.deepEqual(COMEDIAN_PRIOS, ['new', 'regular', 'headliner']);
  // Le dictionnaire de libellés de index.html doit couvrir exactement celles-là.
  const dict = indexHtml.match(/\{headliner:'Headliner',regular:'Régulier',new:'Nouveau'\}/);
  assert.ok(dict, 'le dictionnaire de libellés doit exister dans index.html');
  for (const p of COMEDIAN_PRIOS) {
    assert.ok(dict[0].includes(`${p}:`), `le libellé de « ${p} » manque côté client`);
  }
});
