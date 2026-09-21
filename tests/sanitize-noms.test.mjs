// ════════════════════════════════════════════════════════════════════════
// Tests — assainissement des textes libres (audit du 22/09/2026)
// ════════════════════════════════════════════════════════════════════════
// Exécution : node --test tests/*.test.mjs
//
// Le nom d'un humoriste est réinjecté dans du HTML construit par
// interpolation, à plus de quarante endroits. Et il n'est pas toujours écrit
// par l'admin : api/portal-write.js (action 'ensureComedian') laisse
// QUICONQUE possède le code portail du club créer une fiche avec le nom de
// son choix — or ce code circule par email et par QR auprès de tous les
// humoristes du club.
//
// Comme le jeton de session admin vit dans localStorage, un nom piégé
// s'exécutant dans le navigateur de l'admin permettrait de voler sa session.
// On neutralise donc à l'ÉCRITURE, des deux côtés, plutôt que de compter sur
// un échappement correct à chaque point d'affichage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { stripMarkup, issueAdminToken } = await import('../api/_lib.js');
const adminWriteHandler = (await import('../api/admin-write.js')).default;

const CLUB = '33333333-3333-4333-a333-333333333333';

function installFetchMock() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const canned = String(url).includes('/clubs') && (opts.method || 'GET') === 'GET'
      ? [{ id: CLUB, status: 'active', plan: 'pro' }] : [];
    return { ok: true, status: 200, json: async () => canned, text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {}; res.end = () => res;
  return res;
}

test('stripMarkup retire les chevrons et respecte la longueur maximale', () => {
  assert.equal(stripMarkup('<script>alert(1)</script>Bob'), 'scriptalert(1)/scriptBob');
  assert.equal(stripMarkup('<img src=x onerror=alert(1)>'), 'img src=x onerror=alert(1)');
  assert.equal(stripMarkup('Jean-Éric Ngô'), 'Jean-Éric Ngô', 'un nom normal doit traverser intact');
  assert.equal(stripMarkup('a'.repeat(300), 200).length, 200);
  assert.equal(stripMarkup(null), '');
  assert.equal(stripMarkup(42), '', 'une valeur non textuelle ne doit jamais ressortir telle quelle');
});

test("les chevrons sont retires, pas encodes : le nom reste lisible en email, PDF et CSV", () => {
  // Encoder produirait « &lt;b&gt; » dans des sorties qui ne sont pas du HTML.
  assert.ok(!stripMarkup('<b>Bob</b>').includes('&'));
});

test('un nom piege ecrit par le chemin admin est neutralise avant la base', async () => {
  const mock = installFetchMock();
  const res = fakeRes();
  const { token } = issueAdminToken('admin-1', [{ id: CLUB, name: 'Club' }], CLUB);
  await adminWriteHandler(
    { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: { action: 'sync', payload: { comedians: [
        { id: 'c1', name: '<img src=x onerror=alert(document.cookie)>', phone: '<b>06</b>', notes: '<script>x</script>' },
      ] } } },
    res,
  );
  mock.restore();
  const post = mock.calls.find(c => c.method === 'POST' && c.url.includes('/comedians'));
  assert.ok(post, 'la fiche doit bien être enregistrée');
  const row = post.body[0];
  for (const champ of ['name', 'phone', 'notes']) {
    assert.ok(!row[champ].includes('<'), `${champ} ne doit plus contenir de chevron ouvrant`);
    assert.ok(!row[champ].includes('>'), `${champ} ne doit plus contenir de chevron fermant`);
  }
});

test("le portail assainit aussi : c'est le chemin ouvert a quiconque a le code", async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync('api/portal-write.js', 'utf8'));
  assert.match(src, /name: stripMarkup\(nc\.name, 200\)/,
    "ensureComedian doit passer le nom par stripMarkup — c'est le chemin non authentifie");
  assert.match(src, /phone: stripMarkup\(nc\.phone, 40\)/);
});
