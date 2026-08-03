// ════════════════════════════════════════════════════════════════════════
// Tests — chantier multitenant, étape D (logique CLIENT pure)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// index.html et portal.html sont des fichiers HTML monofichiers, pas des
// modules ESM — leurs fonctions ne sont pas importables directement. Pour
// tester le VRAI code shippé (pas une copie qui pourrait diverger), ce
// fichier extrait les blocs pertinents entre marqueurs
// "// ── TEST-EXTRACT-START: <nom> ──" / "// ── TEST-EXTRACT-END: <nom> ──"
// et les exécute dans un sandbox Node (module vm), avec des stubs minimaux
// pour les globals navigateur dont ils dépendent (atob/getAdminSession).
//
// Couvre :
//   - b64urlDecode()/getCurrentClubId() (index.html) : décodage du club_id
//     depuis le token admin, utilisé pour scoper sbFetch() — sans jamais
//     vérifier la signature côté client (le serveur la revérifie déjà pour
//     toute écriture).
//   - buildDaysConfigFromTemplates()/timeToSuffix() (index.html) et
//     buildDaysCfgFromTemplates()/timeToSuffix() (portal.html) : conversion
//     schedule_templates (DB, "HH:MM") -> DAYS_CONFIG/DAYS_CFG (slot suffix
//     "HHhMM") — le format doit rester EXACTEMENT compatible avec le
//     slot_key existant (YYYY-MM-DD-HHhMM), sinon toutes les assignments et
//     dispos déjà en base deviendraient orphelines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractBlock(source, name) {
  const start = `// ── TEST-EXTRACT-START: ${name} ──`;
  const end = `// ── TEST-EXTRACT-END: ${name} ──`;
  const i = source.indexOf(start);
  const j = source.indexOf(end);
  assert.ok(i !== -1 && j !== -1 && j > i, `marqueurs TEST-EXTRACT "${name}" introuvables ou dans le mauvais ordre`);
  return source.slice(i + start.length, j);
}

const indexHtml = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const portalHtml = readFileSync(path.join(__dirname, '../portal.html'), 'utf8');

// ════════════════════════════════════════════════════════════════════════
// index.html — grille (DEFAULT_DAYS_CONFIG / buildDaysConfigFromTemplates)
// ════════════════════════════════════════════════════════════════════════

// Les objets produits dans un vm.Context vivent dans un autre "realm" que ce
// fichier de test : leurs Array/Object ne sont pas === à ceux de ce module,
// ce qui fait échouer assert.deepEqual (comparaison par référence de
// constructeur). On repasse systématiquement par JSON pour comparer des
// structures de données pures, pas des instances.
const plain = (v) => JSON.parse(JSON.stringify(v));

const gridCodeIndex = extractBlock(indexHtml, 'grid');
const gridSandboxIndex = vm.createContext({});
vm.runInContext(gridCodeIndex + '\nthis.__exports = { DEFAULT_DAYS_CONFIG, cloneDefaultDaysConfig, timeToSuffix, buildDaysConfigFromTemplates, eventRowToSlot, mergeMonthSlotsWithEvents };', gridSandboxIndex);
const { DEFAULT_DAYS_CONFIG, cloneDefaultDaysConfig, timeToSuffix, buildDaysConfigFromTemplates, eventRowToSlot, mergeMonthSlotsWithEvents } = gridSandboxIndex.__exports;

test('index.html timeToSuffix : "20:15" -> "20H15" (format slot_key jamais modifié)', () => {
  assert.equal(timeToSuffix('20:15'), '20H15');
  assert.equal(timeToSuffix('09:00'), '09H00');
});

test('index.html DEFAULT_DAYS_CONFIG : grille BCC actuelle inchangée (15 créneaux, contenu exact)', () => {
  const total = DEFAULT_DAYS_CONFIG.reduce((a, d) => a + d.slots.length, 0);
  assert.equal(total, 15);
  const byName = Object.fromEntries(DEFAULT_DAYS_CONFIG.map(d => [d.name, d.slots]));
  assert.deepEqual(plain(byName.MAR), ['20H15', '21H30']);
  assert.deepEqual(plain(byName.VEN), ['19H00', '20H15', '21H30']);
  assert.deepEqual(plain(byName.SAM), ['19H00', '20H30', '21H45', '23H00']);
  assert.deepEqual(plain(byName.DIM), ['20H15', '21H30']);
});

test('index.html buildDaysConfigFromTemplates : convertit les lignes DB en la même forme que DEFAULT_DAYS_CONFIG (no-op fonctionnel pour le BCC)', () => {
  // Simule exactement le contenu du backfill SQL préparé (stagely-step-d-rls.sql)
  const rows = [
    { id: 't1', weekday: 2, time: '20:15', active: true },
    { id: 't2', weekday: 2, time: '21:30', active: true },
    { id: 't3', weekday: 5, time: '19:00', active: true },
    { id: 't4', weekday: 5, time: '20:15', active: true },
    { id: 't5', weekday: 5, time: '21:30', active: true },
    { id: 't6', weekday: 0, time: '20:15', active: true },
    { id: 't7', weekday: 0, time: '21:30', active: true },
  ];
  const built = buildDaysConfigFromTemplates(rows);
  // Ordre d'affichage historique préservé : MAR avant VEN avant DIM (pas
  // l'ordre calendaire qui mettrait DIM en premier).
  assert.deepEqual(plain(built.map(d => d.name)), ['MAR', 'VEN', 'DIM']);
  const mar = built.find(d => d.name === 'MAR');
  assert.deepEqual(plain(mar.slots), ['20H15', '21H30']);
  assert.equal(mar.slotIds['20H15'], 't1');
  assert.equal(mar.slotIds['21H30'], 't2');
});

test('index.html buildDaysConfigFromTemplates : ignore les lignes inactives et les weekday hors 0-6', () => {
  const rows = [
    { id: 't1', weekday: 2, time: '20:15', active: true },
    { id: 't2', weekday: 2, time: '21:30', active: false },
    { id: 't3', weekday: 9, time: '10:00', active: true },
  ];
  const built = buildDaysConfigFromTemplates(rows);
  assert.equal(built.length, 1);
  assert.deepEqual(plain(built[0].slots), ['20H15']);
});

test('index.html buildDaysConfigFromTemplates : isolation — des lignes déjà pré-filtrées pour un club ne mélangent jamais deux clubs (la fonction ne fait que mettre en forme ce qu\'on lui donne, le scoping réel vient du filtre club_id de sbFetch)', () => {
  // Ce test documente la frontière de responsabilité : buildDaysConfigFromTemplates
  // n'a pas de notion de club_id (les lignes reçues sont déjà scopées en amont
  // par sbFetch). Si sbFetch oubliait le filtre, cette fonction fusionnerait
  // silencieusement les grilles de deux clubs — d'où l'importance du test
  // sbFetch séparé ci-dessous.
  const rowsClubA = [{ id: 'a1', weekday: 1, time: '10:00', active: true }];
  const rowsClubB = [{ id: 'b1', weekday: 1, time: '11:00', active: true }];
  const builtA = buildDaysConfigFromTemplates(rowsClubA);
  const builtB = buildDaysConfigFromTemplates(rowsClubB);
  assert.deepEqual(plain(builtA[0].slots), ['10H00']);
  assert.deepEqual(plain(builtB[0].slots), ['11H00']);
});

test('index.html buildDaysConfigFromTemplates : un jour qui vient de perdre son dernier créneau reste visible (previousDays) au lieu de disparaître de Réglages > Grille', () => {
  const previousDays = plain(cloneDefaultDaysConfig()); // 6 jours, dont MER avec des créneaux
  const rows = [
    { id: 't1', weekday: 2, time: '20:15', active: true }, // MAR seulement — MER/JEU/VEN/SAM/DIM n'ont plus rien en base
  ];
  const built = buildDaysConfigFromTemplates(rows, previousDays);
  const names = built.map(d => d.name);
  assert.ok(names.includes('MER'), 'MER doit rester affiché même sans créneau en base, grâce à previousDays');
  const mer = built.find(d => d.name === 'MER');
  assert.deepEqual(plain(mer.slots), [], 'MER doit être vide, pas halluciné avec d\'anciens créneaux');
});

test('index.html buildDaysConfigFromTemplates : sans previousDays (1er chargement), un jour absent de la base n\'apparaît simplement pas — comportement de base inchangé', () => {
  const rows = [{ id: 't1', weekday: 2, time: '20:15', active: true }];
  const built = buildDaysConfigFromTemplates(rows);
  assert.deepEqual(plain(built.map(d => d.name)), ['MAR']);
});

test('index.html cloneDefaultDaysConfig : renvoie une copie profonde (mutation ne contamine pas DEFAULT_DAYS_CONFIG)', () => {
  const clone = cloneDefaultDaysConfig();
  clone[0].slots.push('99H99');
  assert.notEqual(DEFAULT_DAYS_CONFIG[0].slots.length, clone[0].slots.length);
});

// ════════════════════════════════════════════════════════════════════════
// index.html — mode tournée : fusion grille + events (chantier 2026-08)
// ════════════════════════════════════════════════════════════════════════
// eventRowToSlot()/mergeMonthSlotsWithEvents() : voir commentaire dans
// index.html juste avant getMonthSlots(). Couvre exactement les 4 points
// demandés par le chantier "mode tournée" côté génération de planning :
// no-op pour un club sans events (zéro régression BCC), ajout d'une date
// hors grille, annulation d'une occurrence de grille via events.cancelled,
// et dédoublonnage si une date manuelle coïncide avec un créneau de grille.

test('eventRowToSlot : convertit une ligne events en la même forme qu\'un créneau de grille', () => {
  const slot = eventRowToSlot({ id: 'ev1', slot_key: '2026-08-15-18H30', label: 'Tournée Marseille' });
  assert.ok(slot);
  assert.equal(slot.key, '2026-08-15-18H30');
  assert.equal(slot.slot, '18H30');
  assert.equal(slot.day, 15);
  assert.equal(slot.date.getFullYear(), 2026);
  assert.equal(slot.date.getMonth(), 7); // 0-indexé -> août
  assert.equal(slot.dayName, DAY_NAMES_BY_WD_FOR_TEST(slot.date));
  assert.equal(slot.eventId, 'ev1');
  assert.equal(slot.label, 'Tournée Marseille');
  assert.equal(slot.manual, true);
});
// Petit utilitaire de test uniquement (pas de dépendance à un export
// supplémentaire) : recalcule le nom de jour attendu depuis Date native pour
// ne pas dupliquer en dur une table jour/semaine dans ce fichier de test.
function DAY_NAMES_BY_WD_FOR_TEST(date) {
  return ['DIM','LUN','MAR','MER','JEU','VEN','SAM'][date.getDay()];
}

test('eventRowToSlot : renvoie null pour un slot_key malformé (jamais une exception qui casserait tout le planning)', () => {
  assert.equal(eventRowToSlot({ id: 'ev1', slot_key: 'pas-un-slot-key' }), null);
  assert.equal(eventRowToSlot({ id: 'ev1', slot_key: null }), null);
  assert.equal(eventRowToSlot(null), null);
});

test('mergeMonthSlotsWithEvents : sans aucune ligne events (cas du BCC aujourd\'hui), renvoie EXACTEMENT gridSlots — zéro régression', () => {
  const gridSlots = [
    { key: '2026-08-04-20H15', date: new Date(2026,7,4), day:4, dayName:'MAR', dayLabel:'Mardi', slot:'20H15' },
    { key: '2026-08-04-21H30', date: new Date(2026,7,4), day:4, dayName:'MAR', dayLabel:'Mardi', slot:'21H30' },
  ];
  const merged = mergeMonthSlotsWithEvents(gridSlots, [], 2026, 7);
  assert.deepEqual(plain(merged.map(s => s.key)), gridSlots.map(s => s.key));
  assert.equal(merged.length, gridSlots.length);
});

test('mergeMonthSlotsWithEvents : une ligne events source=manual ajoute une date hors grille, triée à la bonne place', () => {
  const gridSlots = [
    { key: '2026-08-04-20H15', date: new Date(2026,7,4), day:4, dayName:'MAR', dayLabel:'Mardi', slot:'20H15' },
    { key: '2026-08-20-20H15', date: new Date(2026,7,20), day:20, dayName:'JEU', dayLabel:'Jeudi', slot:'20H15' },
  ];
  const events = [
    { id: 'ev1', slot_key: '2026-08-10-18H30', source: 'manual', cancelled: false, label: 'Tournée Marseille' },
  ];
  const merged = mergeMonthSlotsWithEvents(gridSlots, events, 2026, 7);
  assert.equal(merged.length, 3);
  assert.deepEqual(plain(merged.map(s => s.key)), ['2026-08-04-20H15', '2026-08-10-18H30', '2026-08-20-20H15']);
  const manual = merged.find(s => s.key === '2026-08-10-18H30');
  assert.equal(manual.manual, true);
  assert.equal(manual.eventId, 'ev1');
  assert.equal(manual.label, 'Tournée Marseille');
});

test('mergeMonthSlotsWithEvents : une ligne events cancelled=true supprime l\'occurrence de grille correspondante, sans toucher cancelledSlots (mécanisme localStorage séparé, inchangé)', () => {
  const gridSlots = [
    { key: '2026-08-04-20H15', date: new Date(2026,7,4), day:4, dayName:'MAR', dayLabel:'Mardi', slot:'20H15' },
    { key: '2026-08-04-21H30', date: new Date(2026,7,4), day:4, dayName:'MAR', dayLabel:'Mardi', slot:'21H30' },
  ];
  const events = [
    { id: 'ev1', slot_key: '2026-08-04-20H15', source: 'template', cancelled: true },
  ];
  const merged = mergeMonthSlotsWithEvents(gridSlots, events, 2026, 7);
  assert.deepEqual(plain(merged.map(s => s.key)), ['2026-08-04-21H30']);
});

test('mergeMonthSlotsWithEvents : une date manuelle qui coïncide avec un créneau de grille déjà présent n\'est jamais dupliquée', () => {
  const gridSlots = [
    { key: '2026-08-04-20H15', date: new Date(2026,7,4), day:4, dayName:'MAR', dayLabel:'Mardi', slot:'20H15' },
  ];
  const events = [
    { id: 'ev1', slot_key: '2026-08-04-20H15', source: 'manual', cancelled: false, label: 'Doublon' },
  ];
  const merged = mergeMonthSlotsWithEvents(gridSlots, events, 2026, 7);
  assert.equal(merged.length, 1, 'pas de doublon de clé');
  assert.equal(merged[0].manual, undefined, 'la version grille garde la priorité (pas remplacée par la version manuelle)');
});

test('mergeMonthSlotsWithEvents : une date manuelle en dehors du mois demandé n\'apparaît pas (filtrage par year/month)', () => {
  const events = [
    { id: 'ev1', slot_key: '2026-09-10-18H30', source: 'manual', cancelled: false },
  ];
  const merged = mergeMonthSlotsWithEvents([], events, 2026, 7); // août (7), la ligne est en septembre
  assert.equal(merged.length, 0);
});

test('mergeMonthSlotsWithEvents : isolation — cette fonction ne fait que fusionner ce qu\'on lui donne (le scoping club vient de EVENTS déjà filtré par sbFetch, comme pour buildDaysConfigFromTemplates)', () => {
  const eventsClubA = [{ id: 'a1', slot_key: '2026-08-10-18H30', source: 'manual', cancelled: false, label: 'Club A' }];
  const eventsClubB = [{ id: 'b1', slot_key: '2026-08-11-19H00', source: 'manual', cancelled: false, label: 'Club B' }];
  const mergedA = mergeMonthSlotsWithEvents([], eventsClubA, 2026, 7);
  const mergedB = mergeMonthSlotsWithEvents([], eventsClubB, 2026, 7);
  assert.deepEqual(plain(mergedA.map(s => s.key)), ['2026-08-10-18H30']);
  assert.deepEqual(plain(mergedB.map(s => s.key)), ['2026-08-11-19H00']);
});

// ════════════════════════════════════════════════════════════════════════
// index.html — décodage club_id depuis le token admin (sbFetch scoping)
// ════════════════════════════════════════════════════════════════════════

const clubIdCode = extractBlock(indexHtml, 'club-id-decode');

function runGetCurrentClubId(session) {
  const sandbox = vm.createContext({
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    getAdminSession: () => session,
  });
  vm.runInContext(clubIdCode + '\nthis.__result = getCurrentClubId();', sandbox);
  return sandbox.__result;
}

function issueTestToken(clubId, secret = 'x') {
  // Reproduit le format réel émis par issueAdminToken() (_lib.js) depuis le
  // chantier "multi-club-admin" — payload base64url portant active_club_id
  // (plus club_id direct comme avant ce chantier). On n'a pas besoin d'une
  // vraie signature ici puisque getCurrentClubId() ne la revérifie jamais
  // (c'est le point testé).
  const payload = Buffer.from(JSON.stringify({
    role: 'admin', admin_id: 'admin-test', accessible_clubs: [{ id: clubId, name: 'Club' }],
    active_club_id: clubId, exp: Date.now() + 100000,
  })).toString('base64url');
  return `${payload}.fake-signature`;
}

test('getCurrentClubId : décode l\'active_club_id réel depuis un token de session valide', () => {
  const clubId = '22222222-2222-4222-a222-222222222222';
  const result = runGetCurrentClubId({ token: issueTestToken(clubId) });
  assert.equal(result, clubId);
});

test('getCurrentClubId : deux clubs différents décodent bien deux club_id différents (pas de valeur figée)', () => {
  const a = runGetCurrentClubId({ token: issueTestToken('club-a') });
  const b = runGetCurrentClubId({ token: issueTestToken('club-b') });
  assert.notEqual(a, b);
});

test('getCurrentClubId : repli sur BCC_CLUB_ID si pas de session (portail intégré legacy, session absente)', () => {
  const result = runGetCurrentClubId(null);
  assert.equal(result, '00000000-0000-4000-a000-0000000000bc');
});

test('getCurrentClubId : repli sur BCC_CLUB_ID si le token est malformé (pas de ".", JSON invalide)', () => {
  assert.equal(runGetCurrentClubId({ token: 'not-a-real-token' }), '00000000-0000-4000-a000-0000000000bc');
  assert.equal(runGetCurrentClubId({ token: 'not-base64.sig' }), '00000000-0000-4000-a000-0000000000bc');
});

// ════════════════════════════════════════════════════════════════════════
// portal.html — grille (DEFAULT_DAYS_CFG / buildDaysCfgFromTemplates)
// ════════════════════════════════════════════════════════════════════════

const gridCodePortal = extractBlock(portalHtml, 'grid');
// buildDaysCfgFromTemplates() référence DAYS (déclaré juste avant le bloc
// extrait dans portal.html) — fourni ici comme le fichier réel le déclare.
const portalPreamble = "const DAYS = ['DIM','LUN','MAR','MER','JEU','VEN','SAM'];\n"
  + "const DAY_LABELS_BY_WD = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];\n";
const gridSandboxPortal = vm.createContext({});
vm.runInContext(portalPreamble + gridCodePortal + '\nthis.__exports = { DEFAULT_DAYS_CFG, buildDaysCfgFromTemplates, timeToSuffix: typeof timeToSuffix !== "undefined" ? timeToSuffix : null };', gridSandboxPortal);
const { DEFAULT_DAYS_CFG, buildDaysCfgFromTemplates } = gridSandboxPortal.__exports;

test('portal.html DEFAULT_DAYS_CFG : identique à DEFAULT_DAYS_CONFIG (index.html) — même grille BCC, deux fichiers', () => {
  const totalPortal = DEFAULT_DAYS_CFG.reduce((a, d) => a + d.s.length, 0);
  const totalIndex = DEFAULT_DAYS_CONFIG.reduce((a, d) => a + d.slots.length, 0);
  assert.equal(totalPortal, totalIndex);
  const byNamePortal = Object.fromEntries(DEFAULT_DAYS_CFG.map(d => [d.n, d.s]));
  const byNameIndex = Object.fromEntries(DEFAULT_DAYS_CONFIG.map(d => [d.name, d.slots]));
  for (const name of Object.keys(byNameIndex)) {
    assert.deepEqual(plain(byNamePortal[name]), plain(byNameIndex[name]), `grille divergente pour ${name} entre index.html et portal.html`);
  }
});

test('portal.html buildDaysCfgFromTemplates : même conversion HH:MM -> HHhMM et même ordre d\'affichage que côté index.html', () => {
  const rows = [
    { id: 't1', weekday: 6, time: '19:00', active: true },
    { id: 't2', weekday: 6, time: '20:30', active: true },
    { id: 't3', weekday: 3, time: '20:15', active: true },
  ];
  const built = buildDaysCfgFromTemplates(rows);
  assert.deepEqual(plain(built.map(d => d.n)), ['MER', 'SAM']);
  const sam = built.find(d => d.n === 'SAM');
  assert.deepEqual(plain(sam.s), ['19H00', '20H30']);
});

console.log('\nTests étape D (client) terminés — voir le résumé du test runner ci-dessus (node --test).');
