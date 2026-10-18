import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { definitions, byAlias, corpusDigest } from './corpus.mjs';
import { queries, expectedAliases, journeyScenarios, openContracts } from './queries.mjs';

export const actors = ['owner', 'reader'];
export const endpoints = ['search', 'search-deep'];
export const contentMatrix = queries.flatMap(test => actors.flatMap(actor => endpoints.map(endpoint => ({
  id: `content/${test.id}/${actor}/${endpoint}`, test, actor, endpoint, expected: expectedAliases(test, actor),
}))));
export const accessConfigurations = [
  ...['direct', 'group', 'inherited'].flatMap(source => ['viewer', 'editor', 'manager'].map(role => ({ source, role }))),
  { source: 'everybody', role: 'viewer' },
];
export const accessStates = ['private', 'granted', 'revoked'];
export const accessQueries = ['name', 'value'];
export const accessMatrix = accessConfigurations.flatMap(config => accessStates.flatMap(state =>
  actors.flatMap(actor => accessQueries.flatMap(query => endpoints.map(endpoint => ({
    id: `access/${config.source}/${config.role}/${state}/${actor}/${query}/${endpoint}`,
    ...config, state, actor, query, endpoint, visible: actor === 'owner' || state === 'granted',
  }))))));
export const pagingMatrix = ['field-literal', 'field-phrase', 'repeated-alpha', 'metadata-or-content', 'roles-read-content', 'metadata-nonmatch']
  .flatMap(id => actors.flatMap(actor => ['offset', 'continuation'].map(mode => ({
    id: `paging/${id}/${actor}/${mode}`, test: queries.find(test => test.id === id), actor, mode,
  }))));
export const lifecycleChecks = ['rename-new', 'rename-old-gone', 'value-new', 'value-old-gone',
  'term-uri-new', 'term-uri-old-gone', 'term-label-new', 'term-label-old-gone',
  'overlap-granted', 'overlap-group-removed', 'overlap-last-grant-removed',
  'membership-granted', 'membership-removed', 'membership-restored',
  'move-inherited-grant', 'move-private-revocation', 'delete-removes-content', 'delete-read-404',
  'continuation-revocation', 'continuation-cross-user-refused'].map(id => `lifecycle/${id}`);
export const exclusions = [
  'Only two existing test identities are used in this first implementation; independent third-user, administrator and anonymous matrices remain to add.',
  'Publication/version transitions, category/date-filter combinations, OpenView, index rebuilds and worker outages are not implemented in this initial probe.',
  'Everybody manager/editor grants are excluded until their intended public-authority policy is specified.',
  'Run-scoped mode wraps each expression in a unique metadata term; unwrapped semantics and uncontaminated global totals require an isolated stack.',
  'The browser journey uses the reader identity and five scenarios; sharing with a query is asserted at REST against the user guide, not yet through browser navigation.',
];

export function validateInventory() {
  const aliases = definitions.map(item => item.alias);
  assert.equal(new Set(aliases).size, aliases.length, 'Duplicate artifact alias');
  assert.equal(new Set(queries.map(test => test.id)).size, queries.length, 'Duplicate query case');
  const ids = [...contentMatrix, ...accessMatrix, ...pagingMatrix].map(row => row.id).concat(lifecycleChecks);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate matrix cell');
  for (const test of queries) {
    assert.ok(test.query && test.family && test.matches && test.types.length, test.id);
    assert.equal(new Set(test.matches).size, test.matches.length, `Duplicate oracle member in ${test.id}`);
    for (const alias of test.matches) {
      assert.ok(byAlias.has(alias), `Missing expected fixture ${alias}`);
      assert.ok(test.types.includes(byAlias.get(alias).kind), `Wrong expected kind in ${test.id}: ${alias}`);
    }
  }
  return true;
}
export function plan({ isolated = false, tier = 'rest' } = {}) {
  validateInventory();
  const inputHashes = Object.fromEntries(readdirSync(new URL('./', import.meta.url)).filter(name => /\.(mjs|json)$/.test(name)).sort()
    .map(name => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')]));
  for (const name of ['minimal-template.json', 'minimal-element.json', 'minimal-field.json', 'minimal-instance.json'])
    inputHashes[`../../fixtures/${name}`] = createHash('sha256').update(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url))).digest('hex');
  const harnessDigest = createHash('sha256').update(JSON.stringify(inputHashes)).digest('hex');
  return { status: 'OFFLINE_PLAN_NOT_EXECUTED', corpusDigest, harnessDigest, inputHashes, scope: isolated ? 'isolated-unwrapped' : 'unique-run-token', tier,
    artifacts: Object.fromEntries(['field', 'element', 'template', 'instance'].map(kind => [kind, definitions.filter(item => item.kind === kind).length])),
    queries: queries.length, matrixCells: { content: contentMatrix.length, access: accessMatrix.length,
      paging: pagingMatrix.length, lifecycle: lifecycleChecks.length, journey: journeyScenarios.length },
    plannedWrites: { coreArtifacts: definitions.length, transitionInstances: tier === 'journey' ? 0 : 14,
      folders: tier === 'journey' ? 3 : 23, groups: 1, newUsers: 0,
      cleanup: 'Delete only identities recorded by this run; preserve a ledger of unresolved creates and failed cleanup.' },
    dimensions: { actors, endpoints, accessConfigurations, accessStates, accessQueries },
    families: Object.fromEntries([...new Set(queries.map(test => test.family))].map(family =>
      [family, queries.filter(test => test.family === family).length])),
    openContracts, exclusions,
    cells: { content: contentMatrix.map(({ test, ...row }) => ({ ...row, query: test.query, family: test.family, types: test.types, parameters: test.parameters ?? {} })),
      access: accessMatrix, paging: pagingMatrix.map(({ test, ...row }) => ({ ...row, query: test.query })),
      lifecycle: lifecycleChecks, journey: journeyScenarios } };
}
