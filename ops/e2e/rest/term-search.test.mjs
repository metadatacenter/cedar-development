import test from 'node:test';
import assert from 'node:assert/strict';
import { refusals, propertyRefusals, hierarchyRefusals } from './suites/term-search.mjs';
import { pickerValidation } from './picker-validation.mjs';

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

const properties = () => ({ totalCount: 1, request: { limit: 5, offset: 0 }, currentOffset: 0, items: [{ sourceAcronym: 'DOID', versionId: 'a1b2',
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
  const legacy = ['the answer lacks its total count, request, current offset or items'];
  // The legacy fields the server no longer answers are not a substitute for the envelope.
  assert.deepEqual(propertyRefusals({ total: 1, page: 1, pageSize: 5, items: [] }), legacy);
  for (const change of [
    body => { delete body.totalCount; },
    body => { delete body.request; },
    body => { body.request.limit = '5'; },
    body => { delete body.currentOffset; },
  ]) {
    const body = properties();
    change(body);
    assert.deepEqual(propertyRefusals(body), legacy);
  }
});

const CLASS = 'http://purl.obolibrary.org/obo/DOID_1909';
const hierarchy = () => ({ sourceAcronym: 'DOID', termIri: CLASS, termLabel: 'melanoma', childCount: 2,
  path: [{ termIri: 'http://purl.obolibrary.org/obo/DOID_0050687', termLabel: 'cell type cancer' }],
  children: [{ termIri: 'http://purl.obolibrary.org/obo/DOID_8923', termLabel: 'skin melanoma' }] });

// Answers that differ from a valid one in a single place, each one a change the picker's rule or the
// copy's could read differently. The IRIs probe the model library's identifier policy, which the copy
// approximates with a scheme test.
const IRIS = [CLASS, 'urn:uuid:6d6b2c51-4c1a-4c76-8d55-9b1c1a7d3a90', 'https://example.org/a#b', 'DOID_1909',
  'http://exa mple.org/x', 'mailto:someone@example.org', 'http://', '', 'ftp://example.org/x',
  'http://example.org/a#b#c', 'http://example.org/<x>', 'http:#x', 'urn:'];
const searchCases = () => {
  const cases = [['as answered', () => {}]];
  for (const value of IRIS) {
    cases.push([`a class IRI of ${JSON.stringify(value)}`, body => { body.results.class.collection[0].termIri = value; }]);
    cases.push([`a path IRI of ${JSON.stringify(value)}`, body => { body.results.class.collection[0].path[0].termIri = value; }]);
  }
  cases.push(['an unknown kind', body => { body.results.term = body.results.class; }]);
  cases.push(['a malformed unknown kind', body => { body.results.term = { totalCount: 'x' }; }]);
  cases.push(['a property hit', body => { body.results.property = { totalCount: 1, collection: [{ type: 'property',
    sourceSystem: 'bioportal', sourceAcronym: 'DOID', termIri: CLASS, termLabel: 'p', versionId: 'v1', propertyKind: 'object' }] }; }]);
  cases.push(['a property hit with no version', body => { body.results.property = { totalCount: 1, collection: [{ type: 'property',
    sourceSystem: 'bioportal', sourceAcronym: 'DOID', termIri: CLASS, termLabel: 'p', propertyKind: 'object' }] }; }]);
  cases.push(['a property hit of another kind', body => { body.results.property = { totalCount: 1, collection: [{ type: 'property',
    sourceSystem: 'bioportal', sourceAcronym: 'DOID', termIri: CLASS, termLabel: 'p', versionId: 'v1', propertyKind: 'relation' }] }; }]);
  cases.push(['an ontology hit', body => { body.results.ontology = { totalCount: 1, collection: [{ type: 'ontology',
    sourceSystem: 'bioportal', sourceAcronym: 'DOID' }] }; }]);
  cases.push(['a negative count', body => { body.results.class.totalCount = -1; }]);
  cases.push(['names that are not labels', body => { body.results.class.collection[0].names = ['melanoma']; }]);
  cases.push(['versions that are not a list', body => { body.sources[0].versions = 'all'; }]);
  return cases;
};
const hierarchyCases = () => {
  const cases = [['as answered', () => {}]];
  for (const value of IRIS) cases.push([`a child IRI of ${JSON.stringify(value)}`, body => { body.children[0].termIri = value; }]);
  cases.push(['another term', body => { body.termIri = 'http://purl.obolibrary.org/obo/DOID_8923'; }]);
  cases.push(['another source', body => { body.sourceAcronym = 'NCIT'; }]);
  cases.push(['no child count', body => { delete body.childCount; }]);
  cases.push(['no path', body => { delete body.path; }]);
  cases.push(['a label that is not text', body => { body.termLabel = 7; }]);
  return cases;
};

test('the copy of the picker\'s rule reaches the picker\'s own verdict on every case', async t => {
  const picker = await pickerValidation();
  if (picker.absent) {
    t.skip(picker.absent);
    return;
  }
  const differ = [];
  for (const [name, change] of searchCases()) {
    const body = answer();
    change(body);
    const copy = refusals(structuredClone(body)).length === 0;
    const own = picker.readSearchResponse(structuredClone(body)) !== null;
    if (copy !== own) differ.push(`search, ${name}: the copy says ${copy}, the picker ${own}`);
  }
  for (const [name, change] of hierarchyCases()) {
    const body = hierarchy();
    change(body);
    const copy = hierarchyRefusals(body, 'DOID', CLASS).length === 0;
    const own = picker.validHierarchy(body, 'DOID', CLASS);
    if (copy !== own) differ.push(`hierarchy, ${name}: the copy says ${copy}, the picker ${own}`);
  }
  assert.deepEqual(differ, []);
});
