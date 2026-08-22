import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  servedTreeSha256,
  writeBuildInfo,
} from './write-native-frontend-build-info.mjs';

function fixture() {
  const cedarHome = mkdtempSync(join(tmpdir(), 'native-split-'));
  const root = join(cedarHome, 'cedar-workspace');
  mkdirSync(join(root, 'app/config'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '3.0.0-rc.1' }));
  writeFileSync(join(root, 'app/index.html'), '<main>Workspace</main>\n');
  writeFileSync(join(root, 'app/config/version.js'), 'window.version="3.0.0-rc.1";\n');
  return { cedarHome, root };
}

test('served-tree identity ignores its own generated metadata but changes with payload bytes', () => {
  const { root } = fixture();
  const initial = servedTreeSha256(root);
  writeFileSync(join(root, 'app/config/build-info.json'), '{"old":true}\n');
  assert.equal(servedTreeSha256(root), initial);
  writeFileSync(join(root, 'app/index.html'), '<main>Changed</main>\n');
  assert.notEqual(servedTreeSha256(root), initial);
});

test('native build info records version, source identity, modifier, and served hash', () => {
  const { cedarHome, root } = fixture();
  const sourceCommit = 'a'.repeat(40);
  const info = writeBuildInfo({
    cedarHome,
    target: 'workspace',
    sourceCommit,
    sourceDirty: 'false',
    environment: { CEDAR_VERSION_MODIFIER: '-staging-1' },
  });
  const written = JSON.parse(readFileSync(join(root, 'app/config/build-info.json'), 'utf8'));

  assert.deepEqual(written, info);
  assert.equal(info.application, 'cedar-workspace');
  assert.equal(info.version, '3.0.0-rc.1');
  assert.equal(info.versionModifier, '-staging-1');
  assert.equal(info.sourceCommit, sourceCommit);
  assert.equal(info.sourceDirty, false);
  assert.match(info.bundleSha256, /^[0-9a-f]{64}$/);
});

test('native build info rejects an unknown target and abbreviated source identity', () => {
  const { cedarHome } = fixture();
  assert.throws(() => writeBuildInfo({
    cedarHome,
    target: 'other',
    sourceCommit: 'a'.repeat(40),
    sourceDirty: 'false',
    environment: {},
  }), /Unknown split frontend target/);
  assert.throws(() => writeBuildInfo({
    cedarHome,
    target: 'workspace',
    sourceCommit: 'abc1234',
    sourceDirty: 'false',
    environment: {},
  }), /full Git SHA/);
});
