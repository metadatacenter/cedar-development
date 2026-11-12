import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authoringFieldKeys, authoringInstance, authoringOntology, authoringPropertyIri, authoringTemplate,
  authoringValues,
} from '../authoring-model.js';
import { logSize, upstreamCallsSince } from '../terminology-sample.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const fixture = name => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const terms = Array.from({ length: 7 }, (_, number) => ({
  iri: `http://purl.obolibrary.org/obo/DOID_${number}`, label: `disease ${number}`,
}));

test('the authoring template declares one field of each kind and leaves its fixtures untouched', () => {
  const minimalTemplate = fixture('minimal-template.json');
  const minimalField = fixture('minimal-field.json');
  const template = authoringTemplate(minimalTemplate, minimalField, 'Authoring', 'described');

  assert.equal(template['@id'], null);
  assert.deepEqual(template._ui.order, authoringFieldKeys);
  for (const key of authoringFieldKeys) {
    assert.ok(template.required.includes(key), key);
    assert.deepEqual(template.properties['@context'].properties[key], { enum: [authoringPropertyIri(key)] });
    assert.ok(template.properties['@context'].required.includes(key), key);
  }
  assert.equal(template.properties.Code._valueConstraints.regex, '^[A-Z]{2,5}-[0-9]{1,6}$');
  assert.equal(template.properties.Count._valueConstraints.numberType, 'xsd:int');
  assert.deepEqual(template.properties.Count.required, ['@value', '@type']);

  // A controlled-term field carries an identifier where a literal field carries a value.
  const disease = template.properties.Disease;
  assert.equal(disease._valueConstraints.ontologies[0].acronym, authoringOntology.acronym);
  assert.deepEqual(disease.properties['@id'], { type: 'string', format: 'uri' });
  assert.equal(disease.properties['@value'], undefined);
  assert.equal(disease.required, undefined);
  assert.equal(template.properties.Related.type, 'array');
  assert.equal(template.properties.Related.items._valueConstraints.ontologies.length, 1);

  assert.deepEqual(minimalTemplate._ui.order, []);
  assert.ok(minimalField.properties['@value']);
});

test('authoring values are reproducible, satisfy the template and change with the index', () => {
  const values = authoringValues(terms, 12);
  assert.deepEqual(values, authoringValues(terms, 12));
  assert.match(values.Code['@value'], /^[A-Z]{2,5}-[0-9]{1,6}$/);
  assert.ok(Number(values.Count['@value']) >= 0 && Number(values.Count['@value']) <= 100000);
  assert.equal(values.Count['@type'], 'xsd:int');
  assert.deepEqual(values.Disease, { '@id': terms[12 % 7].iri, 'rdfs:label': terms[12 % 7].label });
  assert.equal(values.Related.length, 2);
  assert.notDeepEqual(authoringValues(terms, 13).Disease, values.Disease);
  // A large index wraps instead of leaving the pattern or the sample.
  const large = authoringValues(terms, 4 * 100003 + 999999);
  assert.match(large.Code['@value'], /^[A-Z]{2,5}-[0-9]{1,6}$/);
  assert.ok(terms.some(term => term.iri === large.Disease['@id']));
  assert.throws(() => authoringValues(terms.slice(0, 2), 0), /at least three/);
});

test('an authoring instance names its template and maps every field in its context', () => {
  const minimalInstance = fixture('minimal-instance.json');
  const values = authoringValues(terms, 3);
  const instance = authoringInstance(minimalInstance, 'https://repo.example/templates/1', 'Record', 'described', values);

  assert.equal(instance['@id'], null);
  assert.equal(instance['schema:isBasedOn'], 'https://repo.example/templates/1');
  for (const key of authoringFieldKeys) {
    assert.equal(instance['@context'][key], authoringPropertyIri(key));
    assert.deepEqual(instance[key], values[key]);
  }
  assert.equal(minimalInstance.Disease, undefined);
});

test('the upstream guard reads only what the terminology server logged after the offset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cedar-rest-perf-'));
  const log = join(directory, 'terminology.log');
  try {
    assert.equal(logSize(join(directory, 'absent.log')), null);
    assert.equal(upstreamCallsSince(join(directory, 'absent.log'), 0), null);
    assert.equal(upstreamCallsSince(log, null), null);

    writeFileSync(log, 'INFO BpClassDAO: Url: https://data.bioontology.org/ontologies/OLD/classes/1\n');
    const offset = logSize(log);
    assert.deepEqual(upstreamCallsSince(log, offset), []);

    appendFileSync(log, 'INFO local lookup of DOID\n'
        + 'INFO BpClassDAO: Url: https://data.bioontology.org/ontologies/DOID/classes/2/tree\n'
        + 'WARN BioPortal answered 404 for https://data.bioontology.org/ontologies/NCIT/classes/3; relaying\n');
    assert.deepEqual(upstreamCallsSince(log, offset), [
      'https://data.bioontology.org/ontologies/DOID/classes/2/tree',
      'https://data.bioontology.org/ontologies/NCIT/classes/3',
    ]);

    // A rotated log is shorter than the offset taken from its predecessor: all of it is new.
    writeFileSync(log, 'INFO Url: https://data.bioontology.org/ontologies/NEW/classes/4\n');
    assert.deepEqual(upstreamCallsSince(log, offset), ['https://data.bioontology.org/ontologies/NEW/classes/4']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
