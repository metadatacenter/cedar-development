import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lost, readRetired, unretiredDrops } from './inventory.mjs';

const id = (...parts) => parts.join('\u001f');
const a = id('sharing', 'sharing: grants', 'editor: refused');
const b = id('errors', 'errors: resource', 'resource: refused');
const c = id('versioning', 'versioning: lifecycle', 'ordinary editing cannot change lifecycle metadata');

test('a lost identity is counted as often as it is short, so one lost repetition is seen', () => {
  assert.deepEqual(lost([a, b, c, c, c], [a, b, c, c]), [c]);
  assert.deepEqual(lost([a, b], [b, a]), []);
  assert.deepEqual(lost([a, b], [a]), [b]);
});

test('an update may drop only the identities the retired list names', () => {
  const retired = new Map([[b, 'merged into the anonymous probe']]);
  assert.deepEqual(unretiredDrops([a, b], [a], retired), []);
  assert.deepEqual(unretiredDrops([a, b], [b], retired), [a]);
  // A rename is a drop of the old name and an addition of the new one.
  assert.deepEqual(unretiredDrops([a], [id('sharing', 'sharing: grants', 'editor: is refused')], retired), [a]);
});

test('the retired list needs a suite, section, name and reason in every entry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cedar-retired-'));
  const path = join(directory, 'retired.json');
  try {
    writeFileSync(path, JSON.stringify({ version: 1, checks: [{ suite: 's', section: 'x', name: 'n', reason: 'why' }] }));
    assert.deepEqual([...readRetired(path)], [[id('s', 'x', 'n'), 'why']]);
    writeFileSync(path, JSON.stringify({ version: 1, checks: [{ suite: 's', section: 'x', name: 'n', reason: ' ' }] }));
    assert.throws(() => readRetired(path), /without a suite, section, name and reason/);
    writeFileSync(path, JSON.stringify({ checks: [] }));
    assert.throws(() => readRetired(path), /not a version 1 list/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the committed retired list is well formed', () => {
  readRetired(fileURLToPath(new URL('./retired-checks.json', import.meta.url)));
});
