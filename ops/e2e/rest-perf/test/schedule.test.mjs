import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduledValue } from '../schedule.js';

const operations = Array.from({ length: 24 }, (_, index) => `operation-${index}`);

function sequence(seed, actor, count = 48) {
  return Array.from({ length: count }, (_, iteration) => scheduledValue(operations, seed, actor, iteration));
}

test('a seed, actor and iteration reproduce the same schedule exactly', () => {
  assert.deepEqual(sequence('repeat-me', 7), sequence('repeat-me', 7));
});

test('every complete cycle preserves the operation multiset', () => {
  const expected = [...operations].sort();
  const values = sequence('balanced', 3);
  assert.deepEqual(values.slice(0, 24).sort(), expected);
  assert.deepEqual(values.slice(24, 48).sort(), expected);
});

test('actors and seeds do not march through the same order', () => {
  assert.notDeepEqual(sequence('one-seed', 0, 24), sequence('one-seed', 1, 24));
  assert.notDeepEqual(sequence('one-seed', 0, 24), sequence('another-seed', 0, 24));
});

test('invalid scheduling inputs are rejected', () => {
  assert.throws(() => scheduledValue([], 'seed', 0, 0), /must not be empty/);
  assert.throws(() => scheduledValue(operations, 'seed', -1, 0), /actor index/);
  assert.throws(() => scheduledValue(operations, 'seed', 0, -1), /iteration/);
});
