import test from 'node:test';
import assert from 'node:assert/strict';
import { refusals, propertyRefusals } from './suites/term-search.mjs';

// Trimmed from what the terminology server answered on 2026-11-11.
const answer = () => ({
  query: 'melanoma',
  sources: [{ sourceSystem: 'bioportal', sourceAcronym: 'DOID', served: 'local', pinnable: true }],
  results: {
    class: { totalCount: 1, countCapped: false, page: 1, pageSize: 5, collection: [{
      type: 'class', sourceSystem: 'bioportal', sourceAcronym: 'DOID', termIri: 'http://purl.obolibrary.org/obo/DOID_1909',
      termType: 'class', termLabel: 'melanoma', obsolete: false, hasChildren: true, descendantCount: 6,
      path: [{ termIri: 'http://purl.obolibrary.org/obo/DOID_0050687', termLabel: 'cell type cancer' }],
      names: [{ label: 'malignant melanoma', language: 'en' }] }] },
    branch: { totalCount: 1, countCapped: false, page: 1, pageSize: 5, collection: [{
      type: 'branch', sourceSystem: 'bioportal', sourceAcronym: 'DOID', termBaseIri: 'http://purl.obolibrary.org/obo/DOID_1909',
      termBaseLabel: 'melanoma', descendantCount: 6, obsolete: false }] },
    valueSet: { totalCount: 1, countCapped: false, page: 1, pageSize: 5, collection: [{
      type: 'valueSet', sourceSystem: 'bioportal', sourceAcronym: 'CEDARVS', termCount: 4,
      termBaseIri: 'http://www.semanticweb.org/jgraybeal/ontologies/2015/7/cedarvaluesets#Study_Type' }] },
  },
});

const properties = () => ({ total: 1, page: 1, pageSize: 5, items: [{ sourceAcronym: 'DOID', versionId: 'a1b2',
  property: { iri: 'http://purl.obolibrary.org/obo/RO_0001025', kind: 'object', label: 'located in', obsolete: false,
    hasChildren: false } }] });

test('an answer in the shape the picker reads raises nothing', () => {
  assert.deepEqual(refusals(answer()), []);
  assert.deepEqual(propertyRefusals(properties()), []);
});

test('the shape changes the picker would refuse are each named', () => {
  const cases = [
    [body => { delete body.results.class.collection[0].termIri; }, 'class hit 0 lacks its IRI or label'],
    [body => { body.results.branch.collection[0].termBaseLabel = 7; }, 'branch hit 0 lacks its base label'],
    [body => { body.results.valueSet.collection[0].termBaseIri = 'Study_Type'; }, 'valueSet hit 0 lacks its base IRI'],
    [body => { body.results.class.collection[0].path = [{ termLabel: 'cell type cancer' }]; },
      'class hit 0 has a malformed term reference'],
    [body => { body.results.class.collection[0].type = 'term'; }, 'class hit 0 lacks its type, acronym or system'],
    [body => { body.results.term = body.results.class; delete body.results.class; }, 'the results name an unknown kind, term'],
    [body => { body.results.class.totalCount = '1'; }, 'the class results lack a count or a collection'],
    [body => { delete body.sources[0].sourceSystem; }, 'source 0 lacks its acronym or system, or its versions are not a list'],
    [body => { delete body.results; }, 'the answer lacks its query, sources or results'],
  ];
  for (const [change, expected] of cases) {
    const body = answer();
    change(body);
    assert.deepEqual(refusals(body), [expected]);
  }
});

test('a property answer missing a field the picker maps is refused', () => {
  for (const change of [
    body => { delete body.items[0].versionId; },
    body => { body.items[0].property.kind = 'relation'; },
    body => { delete body.items[0].property.hasChildren; },
  ]) {
    const body = properties();
    change(body);
    assert.deepEqual(propertyRefusals(body), ['property item 0 lacks a field the picker maps']);
  }
  assert.deepEqual(propertyRefusals({ total: 1, items: [] }), ['the answer lacks its total, page, page size or items']);
});
