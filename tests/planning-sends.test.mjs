import test from 'node:test';
import assert from 'node:assert/strict';
import { publishedSlotFilter, parisMonth } from '../api/data-read.js';

test('portail : mois passés toujours visibles, mois courant/futurs seulement si envoyés', () => {
  assert.equal(publishedSlotFilter([], '2026-10'), 'or=(slot_key.lt.2026-10)');
  assert.equal(
    publishedSlotFilter(['2026-09', '2026-10', '2026-11', 'x'], '2026-10'),
    'or=(slot_key.lt.2026-10,slot_key.like.2026-10-*,slot_key.like.2026-11-*)',
  );
});

test('parisMonth suit le fuseau de Paris', () => {
  assert.equal(parisMonth(new Date('2026-10-31T23:30:00Z')), '2026-11');
  assert.equal(parisMonth(new Date('2026-10-15T12:00:00Z')), '2026-10');
});

// ── Envoi à un seul humoriste (remplaçant après une annulation) ────────────
// Le VRAI code de index.html (sendPlanningToAll → fallbackCopy) est exécuté
// dans un bac à sable ; seuls l'email et l'écriture serveur sont simulés.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sendCode = html.slice(html.indexOf('async function sendPlanningToAll()'), html.indexOf('function fallbackCopy('));

function sendSandbox() {
  const sb = vm.createContext({
    emails: [], marked: [], writes: [],
    COMEDIANS: [{ id: 'a', name: 'ALICE X', email: 'a@x.fr' }, { id: 'b', name: 'BOB Y', email: 'b@y.fr' }],
    EMAIL_CONFIG: { configured: true },
    currentClub: { name: 'BCC' },
    exportMonthOverride: '2026-11',
    getTargetMonthPrefix: () => '2026-11',
    getAssignmentsByComedian: () => ({ a: ['2026-11-06-20H15'], b: ['2026-11-07-20H15', '2026-11-14-20H15'] }),
    buildPlanningMessage: (id, keys) => `${id}:${keys.join(',')}`,
    closeModal() {}, autoSave() {}, renderPlanSendStatus() {}, toast() {}, _renderSendPlanningList() {},
  });
  vm.runInContext(`
    async function sendEmail(to, subject, body) { emails.push({ to, body }); return { success: true }; }
    function markEmailSent(id, month) { marked.push(id + '@' + month); }
    async function adminWrite(action, payload) { writes.push({ action, payload }); return true; }
  ` + sendCode, sb);
  return sb;
}

test('envoi à un seul humoriste : seul le remplaçant reçoit ses dates', async () => {
  const sb = sendSandbox();
  await vm.runInContext(`sendPlanningToOne('b', null)`, sb);
  assert.deepEqual([...sb.emails.map(e => e.to)], ['b@y.fr']);
  assert.equal(sb.emails[0].body, 'b:2026-11-07-20H15,2026-11-14-20H15', 'toutes ses dates du mois, remplacement compris');
  assert.deepEqual([...sb.marked], ['b@2026-11']);
  assert.equal(JSON.stringify(sb.writes[0].payload), JSON.stringify({ month: '2026-11', comedian_ids: ['b'] }));
});

test('envoyer à tous prévient toujours tout le monde', async () => {
  const sb = sendSandbox();
  await vm.runInContext(`sendPlanningToAll()`, sb);
  assert.deepEqual([...sb.emails.map(e => e.to)].sort(), ['a@x.fr', 'b@y.fr']);
});
