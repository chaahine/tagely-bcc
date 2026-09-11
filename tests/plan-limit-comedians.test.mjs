// ════════════════════════════════════════════════════════════════════════
// Tests — plafond d'humoristes du palier Essentiel (chantier tarifs, 2026-09)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Règle produit tranchée par Chahine : le palier Essentiel (39,90 EUR) vise
// les petits plateaux et s'arrête à 30 humoristes ; Pro/Réseau n'ont aucune
// limite.
//
// Le point délicat couvert ici est la nuance "croissance seulement" : un club
// qui dépasse DÉJÀ le plafond (ancien Pro redescendu au palier Essentiel, ou
// club antérieur à cette règle) doit continuer à enregistrer son effectif tel
// quel. Sans ça, chaque sync renverrait ses 80 fiches, serait refusé, et le
// club ne pourrait plus rien sauvegarder du tout — planning compris. Le
// gating masque et freine, il ne casse jamais l'existant.
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

test('la grille des plafonds est bien 30 / 150 / illimité', () => {
  assert.equal(ESSENTIEL_MAX_COMEDIANS, 30);
  assert.equal(PLAN_CAPS.essentiel.maxComedians, 30);
  assert.equal(PLAN_CAPS.pro.maxComedians, 150);
  assert.equal(PLAN_CAPS.reseau.maxComedians, null, 'null signifie illimité, jamais zéro');
});

test('Essentiel : 30 humoristes passent (la limite est inclusive)', async () => {
  const { res, wrote } = await sync({ count: 30 });
  assert.equal(res.statusCode, 200);
  assert.ok(wrote, 'les 30 fiches doivent être enregistrées');
});

test('Essentiel : la 31e est refusée en 403, avec un code exploitable par le client', async () => {
  const { res, wrote } = await sync({ count: 31 });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'plan_limit_comedians');
  assert.equal(res.body.limit, 30);
  assert.ok(/palier/i.test(res.body.error), 'le message doit orienter vers le palier supérieur');
  assert.equal(wrote, false, 'RIEN ne doit être écrit : un sync à moitié appliqué corromprait le club');
});

test('Pro : 150 humoristes passent', async () => {
  const { res, wrote } = await sync({ count: 150, plan: 'pro' });
  assert.equal(res.statusCode, 200);
  assert.ok(wrote);
});

test('Pro : la 151e est refusée — le palier a son propre plafond, pas juste Essentiel', async () => {
  const { res, wrote } = await sync({ count: 151, plan: 'pro' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.limit, 150);
  assert.equal(wrote, false);
});

test('Réseau : aucune limite non plus', async () => {
  const { res } = await sync({ count: 200, plan: 'reseau' });
  assert.equal(res.statusCode, 200);
});

test("pendant l'essai, aucune limite quel que soit le plan (on ne bride jamais une démo)", async () => {
  const { res, wrote } = await sync({ count: 200, plan: 'essentiel', status: 'trial' });
  assert.equal(res.statusCode, 200);
  assert.ok(wrote);
});

test('club déjà au-dessus du plafond : il peut continuer à enregistrer son effectif existant', async () => {
  const { res, wrote } = await sync({ count: 80, existing: 80 });
  assert.equal(res.statusCode, 200, 'un downgrade ne doit jamais bloquer toute sauvegarde');
  assert.ok(wrote);
});

test('club déjà au-dessus du plafond : il ne peut pas pour autant en ajouter un de plus', async () => {
  const { res, wrote } = await sync({ count: 81, existing: 80 });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.current, 80);
  assert.equal(wrote, false);
});

test('un petit club ne paie jamais l\'aller-retour de comptage', async () => {
  const { calls } = await sync({ count: 10 });
  const counted = calls.some(c => c.method === 'GET' && c.url.includes('/comedians'));
  assert.equal(counted, false, 'sous le plafond, aucune requête de comptage ne doit partir');
});

// ── Cohérence grille affichée ↔ grille appliquée ───────────────────────────
// PLAN_LADDER (index.html, ce que le client LIT sur sa page de prix) et
// PLAN_CAPS (api/_lib.js, ce que le serveur APPLIQUE) sont deux déclarations
// séparées, par nécessité : l'une est du HTML de présentation, l'autre la
// règle d'autorisation. Une divergence entre les deux est la pire espèce de
// bug — elle ne se découvre qu'après le paiement.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const indexHtml = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8',
);

function planLadderPerks(key) {
  const block = indexHtml.match(/const PLAN_LADDER = \[([\s\S]*?)\];/);
  assert.ok(block, 'PLAN_LADDER doit exister dans index.html');
  const line = block[1].split('\n').find(l => l.includes(`'${key}'`));
  assert.ok(line, `le palier ${key} doit figurer dans PLAN_LADDER`);
  return line;
}

test('grille affichée : Essentiel annonce exactement les plafonds appliqués', () => {
  const line = planLadderPerks('essentiel');
  assert.match(line, new RegExp(`${PLAN_CAPS.essentiel.maxComedians} humoristes`));
  assert.match(line, new RegExp(`${PLAN_CAPS.essentiel.maxClubAdmins} personnes`));
});

test('grille affichée : Pro annonce exactement les plafonds appliqués', () => {
  const line = planLadderPerks('pro');
  assert.match(line, new RegExp(`${PLAN_CAPS.pro.maxComedians} humoristes`));
  assert.match(line, new RegExp(`${PLAN_CAPS.pro.maxClubAdmins} personnes`));
});

test('grille affichée : Réseau annonce "sans limite", ce que le serveur applique bien', () => {
  const line = planLadderPerks('reseau');
  assert.match(line, /sans limite/i);
  assert.equal(PLAN_CAPS.reseau.maxComedians, null);
  assert.equal(PLAN_CAPS.reseau.maxClubAdmins, null);
});

test("l'export comptable est annoncé au seul palier qui l'ouvre côté serveur", () => {
  assert.match(planLadderPerks('reseau'), /export comptable/i);
  assert.equal(PLAN_CAPS.reseau.accountingExport, true);
  assert.equal(PLAN_CAPS.pro.accountingExport, false);
  assert.equal(PLAN_CAPS.essentiel.accountingExport, false);
  // Et le client refuse bien l'accès hors Réseau (hasAccountingExport).
  const fn = indexHtml.match(/function hasAccountingExport\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'hasAccountingExport() doit exister dans index.html');
  assert.match(fn[1], /plan === 'reseau'/);
  assert.match(fn[1], /status === 'trial'/, "l'essai doit toujours donner l'accès complet");
  assert.ok(!/plan === 'pro'/.test(fn[1]), "le palier Pro ne doit PAS ouvrir l'export comptable");
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
