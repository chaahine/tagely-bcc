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
