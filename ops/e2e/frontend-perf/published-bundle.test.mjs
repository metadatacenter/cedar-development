import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {NPMJS, isServed, publishedBundle} from './published-bundle.mjs';

const references = JSON.parse(readFileSync(new URL('./references.json', import.meta.url), 'utf8'));

test('a release base is read from its public package; any other base is rebuilt', () => {
  assert.deepEqual(publishedBundle('ced', {version: '0.1.4'}),
    {package: 'cedar-embeddable-designer', version: '0.1.4', registry: NPMJS, file: 'cedar-embeddable-designer.js'});
  assert.equal(publishedBundle('ced', {version: '0.1.5-dev.20261124.939eb6c2'}), null);
  assert.equal(publishedBundle('designer', {version: '2.9.38'}), null);
});

test('a release base the registry does not serve yet is rebuilt', () => {
  const source = publishedBundle('ced', {version: '0.1.5'});
  assert.equal(isServed(source, () => '0.1.5'), true);
  assert.equal(isServed(source, () => ''), false);
});

test('every published reference names its component package at a release on an https registry', () => {
  for (const component of Object.keys(references.published ?? {})) {
    const source = publishedBundle(component, {references});
    assert.ok(source, component);
    assert.match(references.components[component], /^[0-9a-f]{40}$/, `${component} keeps its source commit`);
  }
});

test('the CEE reference is read from the release whose code its commit carries', () => {
  assert.deepEqual(publishedBundle('cee', {references}),
    {package: 'cedar-embeddable-editor', version: '2.0.33', registry: NPMJS, file: 'cedar-embeddable-editor.js'});
  assert.equal(publishedBundle('ced', {references}), null);
  assert.equal(publishedBundle('designer', {references}), null);
});

test('a malformed published reference is refused rather than rebuilt', () => {
  const bad = entry => ({published: {cee: {package: 'cedar-embeddable-editor', version: '2.0.33', registry: NPMJS, ...entry}}});
  assert.throws(() => publishedBundle('cee', {references: bad({package: 'other'})}), /names other/);
  assert.throws(() => publishedBundle('cee', {references: bad({version: '2.0.34-dev.1'})}), /not a release/);
  assert.throws(() => publishedBundle('cee', {references: bad({registry: 'http://registry'})}), /https/);
});
