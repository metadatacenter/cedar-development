import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CEE_CONSUMERS,
  dependencySpec,
  inspectConsumer,
  validateVersion,
} from './propagate-cee-release.mjs';

test('consumer inventory includes Workspace and all seven embedding manifests', () => {
  assert.equal(CEE_CONSUMERS.length, 7);
  assert.equal(CEE_CONSUMERS.filter(consumer => consumer.directory === 'cedar-workspace').length, 1);
});

test('stable releases resolve from npmjs and dev releases use the scoped Nexus alias', () => {
  assert.equal(dependencySpec('2.0.0'), '2.0.0');
  assert.equal(
    dependencySpec('2.0.0-dev.20260820.a8cc4cc'),
    'npm:@org.metadatacenter/cedar-embeddable-editor@2.0.0-dev.20260820.a8cc4cc');
  assert.equal(
    dependencySpec('2.0.2-dev.20260827.1711.gab718c87781a'),
    'npm:@org.metadatacenter/cedar-embeddable-editor@2.0.2-dev.20260827.1711.gab718c87781a');
  assert.throws(() => validateVersion('../2.0.0'));
});

test('consumer inspection checks manifest, lock pin, installed version, and registry', () => {
  const cedarHome = mkdtempSync(join(tmpdir(), 'cee-consumers-'));
  const directory = 'cedar-workspace';
  const root = join(cedarHome, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { 'cedar-embeddable-editor': '2.0.0' },
  }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    packages: {
      '': { dependencies: { 'cedar-embeddable-editor': '2.0.0' } },
      'node_modules/cedar-embeddable-editor': {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/cedar-embeddable-editor/-/cedar-embeddable-editor-2.0.0.tgz',
      },
    },
  }));
  assert.deepEqual(inspectConsumer(cedarHome, { directory }, '2.0.0').errors, []);

  const mismatch = inspectConsumer(cedarHome, { directory }, '2.1.0').errors;
  assert.equal(mismatch.length, 3);
});
