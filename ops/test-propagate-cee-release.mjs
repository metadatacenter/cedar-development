import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CEE_CONSUMERS,
  ceeConsumers,
  dependencySpec,
  inspectConsumer,
  validateVersion,
} from './propagate-cee-release.mjs';

test('the consumer inventory is every CEE consumer the train configuration declares', () => {
  const configPath = join(import.meta.dirname, 'frontend-train.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const declared = config.frontends.filter(frontend => frontend.ceeConsumer).length
    + config.additionalCeeConsumers.length;

  assert.equal(CEE_CONSUMERS.length, declared);
  for (const directory of ['cedar-workspace', 'cedar-template-editor', 'cedar-template-designer']) {
    assert.equal(
      CEE_CONSUMERS.filter(consumer => consumer.directory === directory).length, 1,
      `${directory} is a declared CEE consumer and must be propagated to`);
  }
});

test('a consumer directory is the repository joined to the manifest that declares it', () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'cee-consumers-')), 'frontend-train.json');
  writeFileSync(configPath, JSON.stringify({
    frontends: [
      { repository: 'cedar-workspace', id: 'workspace', ceeConsumer: { manifest: 'package.json' } },
      {
        repository: 'cedar-bridging',
        id: 'bridging',
        ceeConsumer: { manifest: 'cedar-bridging-src/package.json', legacyPeerDeps: true },
      },
      { repository: 'cedar-content-distribution', id: 'content' },
    ],
    additionalCeeConsumers: [
      { repository: 'cedar-component-demo', label: 'react-demo', manifest: 'cedar-cee-demo-react/package.json' },
    ],
  }));

  assert.deepEqual(ceeConsumers(configPath).map(consumer => consumer.directory), [
    'cedar-workspace',
    'cedar-bridging/cedar-bridging-src',
    'cedar-component-demo/cedar-cee-demo-react',
  ]);
  assert.equal(ceeConsumers(configPath)[1].legacyPeerDeps, true);
  assert.equal(ceeConsumers(configPath)[0].legacyPeerDeps, false);
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
