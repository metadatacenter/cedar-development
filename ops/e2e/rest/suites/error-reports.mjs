// What a refused artifact write tells its author.
//
// A write the libraries refuse is answered 400, and the answer says where the artifact is wrong and
// what is wrong there: a location in the document as it was sent, and a message about that place.
// An author who sends a template, an element, a field or an instance, as JSON or as YAML, to be
// created, updated or repaired verbatim, can then go to the place named and correct it. This suite
// sends each kind of artifact damaged in one place and checks that the answer names that place, and
// says what is wrong with it, in each form and by each route that writes.
//
// Three refusals used to be told badly. A template child that matches none of the shapes the
// meta-schema allows was reported as every shape's failure, around a hundred errors for one wrong
// value, so the checks below also bound how many errors such a report holds. A YAML key the form does
// not have was dropped without a word, so a misspelled key lost its value. And a key the form has for
// one field type, stated for another, was read and lost too.
import { suite, check, checkStatus, call, updateArtifact, artifactBody, cleanup, enc, RUN } from '../lib.mjs';

export const name = 'error-reports';

/** The errors a refusal reports, wherever the answer carries them, with the answer's own message. */
function reported(response) {
  const body = response.body ?? {};
  const report = body.objects?.validationReport ?? (Array.isArray(body.errors) ? body : null);
  const errors = (report?.errors ?? []).map(error => ({ location: String(error.location ?? ''), message: String(error.message ?? '') }));
  return { errors, message: String(body.message ?? response.text ?? ''), errorKey: body.errorKey };
}

/**
 * Check that `response` refuses the write in a report naming `location` with a message containing
 * every one of `phrases`, and holding at most `limit` errors.
 */
function refusedAt(response, location, phrases, what, limit = 3) {
  if (!checkStatus(response, 400, `${what}: the write is refused`)) return;
  const { errors, message } = reported(response);
  const named = errors.find(error => error.location === location);
  const told = named ? named.message : message;
  check(!!named || message.includes(location), `${what}: the answer names ${location}`,
      JSON.stringify(errors.slice(0, 4)) + ' ' + message.slice(0, 300));
  check(phrases.every(phrase => told.includes(phrase)), `${what}: the answer says what is wrong there`,
      told.slice(0, 300));
  check(errors.length <= limit, `${what}: the report holds no more than ${limit} errors`, String(errors.length));
}

/** The YAML a resource serves, without the identifier a create must not carry. */
const withoutYamlId = text => text.replace(/^id:.*\r?\n/m, '');

/** A template with a numeric field and a text field, built as the other suites build one. */
function measuredTemplate() {
  const template = artifactBody('template', `Error reports ${RUN}`);
  for (const key of ['Measurement', 'Code']) {
    const field = artifactBody('field', key);
    if (key === 'Measurement') {
      field._ui.inputType = 'numeric';
      field._valueConstraints = { requiredValue: false, numberType: 'xsd:int' };
      field.required = ['@value', '@type'];
    }
    template.properties[key] = field;
    template.properties['@context'].properties[key] = { enum: [`https://schema.metadatacenter.org/properties/error-reports-${key}`] };
    template.properties['@context'].required.push(key);
    template.required.push(key);
    template._ui.order.push(key);
    template._ui.propertyLabels[key] = key;
  }
  return template;
}

async function schemaReports(auth, admin, folderId) {
  suite('error-reports: templates, elements and fields');
  const at = path => `${path}?folder_id=${enc(folderId)}`;
  const template = measuredTemplate();
  const created = await call(auth, 'POST', at('/templates'), template);
  if (!checkStatus(created, 201, 'create the template the damaged copies are made from')) return null;
  const path = `/templates/${enc(created.body['@id'])}`;
  cleanup('template', path, template['schema:name']);

  // A child that is no field or element, and a field with one wrong value, each by every route.
  const damaged = [
    ['a child without an input type', body => { body.properties.Code._ui = {}; },
      '/properties/Code/_ui', ["'Code' is not a field or element", 'no inputType']],
    ['a child of an unknown input type', body => { body.properties.Code._ui.inputType = 'bogus'; },
      '/properties/Code/_ui/inputType', ["'bogus'", 'is not an input type']],
    ['a child without a type', body => { delete body.properties.Code['@type']; },
      '/properties/Code', ["'Code' is not a field or element", 'it has no @type']],
    ['a field with one wrong value', body => { body.properties.Code._valueConstraints.requiredValue = 'yes'; },
      '/properties/Code/_valueConstraints/requiredValue', ['boolean']],
  ];
  for (const [what, damage, location, phrases] of damaged) {
    const copy = structuredClone(template);
    damage(copy);
    refusedAt(await call(auth, 'POST', at('/templates'), copy), location, phrases, `template JSON create, ${what}`);
    const current = await call(auth, 'GET', path);
    const update = structuredClone(current.body);
    damage(update);
    refusedAt(await updateArtifact(auth, path, update, { current }), location, phrases, `template JSON update, ${what}`);
    if (admin) {
      refusedAt(await call(admin.auth, 'PUT', `${path}?verbatim=true`, update, { headers: { 'If-Match': current.headers.get('etag') } }),
          location, phrases, `template JSON verbatim write, ${what}`);
    }
  }

  // A YAML key the form does not have, a misspelling in a child's configuration, and a key of
  // another field type, by create and by update.
  const served = await call(auth, 'GET', path, undefined, { accept: 'application/yaml' });
  if (!checkStatus(served, 200, 'read the template as YAML')) return null;
  const yaml = withoutYamlId(served.text);
  const yamlDamaged = [
    ['an unknown key', text => `${text}bogusKey: 1\n`, ['unknown key', 'bogusKey']],
    ['a misspelled configuration key', text => text.replace(/^(\s+)configuration:\n/m, '$1configuration:\n$1  requird: true\n'),
      ['unknown key', 'requird']],
    ["a numeric field's unit on a text field", text => text.replace(/^(\s+)name: "?Code"?\n/m, '$1name: "Code"\n$1unit: "cm"\n'),
      ['unknown key', 'unit']],
  ];
  for (const [what, damage, phrases] of yamlDamaged) {
    const damagedYaml = damage(yaml);
    check(damagedYaml !== yaml, `template YAML, ${what}: the damage applies`, 'the YAML did not change');
    const create = await call(auth, 'POST', at('/templates'), damagedYaml, { contentType: 'application/yaml' });
    if (checkStatus(create, 400, `template YAML create, ${what}: the write is refused`)) {
      const { message } = reported(create);
      check(phrases.every(phrase => message.includes(phrase)), `template YAML create, ${what}: the answer names the key`, message.slice(0, 300));
    }
    const update = await updateArtifact(auth, path, damage(served.text), { contentType: 'application/yaml' });
    if (checkStatus(update, 400, `template YAML update, ${what}: the write is refused`)) {
      const { message } = reported(update);
      check(phrases.every(phrase => message.includes(phrase)), `template YAML update, ${what}: the answer names the key`, message.slice(0, 300));
    }
  }
  check((await call(auth, 'GET', path)).body?.properties?.Code?.['schema:name'] === 'Code',
      'a refused write leaves the stored template as it was', 'the template changed');

  // An element and a field, each damaged once in JSON and once in YAML.
  const element = artifactBody('element', `Error reports element ${RUN}`);
  const inner = artifactBody('field', 'Inner');
  element.properties.Inner = inner;
  element.properties['@context'].properties.Inner = { enum: ['https://schema.metadatacenter.org/properties/error-reports-Inner'] };
  (element.properties['@context'].required ??= []).push('Inner');
  element.required.push('Inner');
  element._ui.order.push('Inner');
  element._ui.propertyLabels.Inner = 'Inner';
  const brokenElement = structuredClone(element);
  brokenElement.properties.Inner._ui = {};
  refusedAt(await call(auth, 'POST', at('/template-elements'), brokenElement), '/properties/Inner/_ui',
      ["'Inner' is not a field or element", 'no inputType'], 'element JSON create, a child without an input type');
  const field = artifactBody('field', `Error reports field ${RUN}`);
  refusedAt(await call(auth, 'POST', at('/template-fields'), { ...field, _valueConstraints: { ...field._valueConstraints, minLength: -1 } }),
      '/_valueConstraints/minLength', [], 'field JSON create, a negative minimum length');
  const madeField = await call(auth, 'POST', at('/template-fields'), field);
  if (checkStatus(madeField, 201, 'create a field to read as YAML')) {
    const fieldPath = `/template-fields/${enc(madeField.body['@id'])}`;
    cleanup('field', fieldPath, field['schema:name']);
    const fieldYaml = withoutYamlId((await call(auth, 'GET', fieldPath, undefined, { accept: 'application/yaml' })).text);
    const misspelled = await call(auth, 'POST', at('/template-fields'), `${fieldYaml}descripton: "lost"\n`, { contentType: 'application/yaml' });
    if (checkStatus(misspelled, 400, 'field YAML create, a misspelled key: the write is refused')) {
      check(reported(misspelled).message.includes('descripton'), 'field YAML create, a misspelled key: the answer names the key',
          reported(misspelled).message.slice(0, 300));
    }
  }
  return created.body['@id'];
}

async function instanceReports(auth, admin, folderId, templateId) {
  suite('error-reports: instances');
  const at = path => `${path}?folder_id=${enc(folderId)}`;
  const instance = artifactBody('instance', `Error reports instance ${RUN}`, { 'schema:isBasedOn': templateId });
  Object.assign(instance['@context'], {
    Measurement: 'https://schema.metadatacenter.org/properties/error-reports-Measurement',
    Code: 'https://schema.metadatacenter.org/properties/error-reports-Code',
  });
  instance.Measurement = { '@value': '7', '@type': 'xsd:int' };
  instance.Code = { '@value': 'ok' };
  const created = await call(auth, 'POST', at('/template-instances'), instance);
  if (!checkStatus(created, 201, 'create the instance the damaged copies are made from')) return;
  const path = `/template-instances/${enc(created.body['@id'])}`;
  cleanup('instance', path, instance['schema:name']);

  const damaged = [
    ['a number that is not one', body => { body.Measurement['@value'] = 'abc'; }, '/Measurement/@value', []],
    // A property the schema does not allow is reported where it is, and named.
    ['a key the template does not have', body => { body.Ghost = { '@value': 'x' }; }, '/Ghost', ["'Ghost'"]],
    ['a literal field given an IRI', body => { body.Code = { '@id': 'https://example.org/x' }; }, '/Code', []],
  ];
  for (const [what, damage, location, phrases] of damaged) {
    const copy = structuredClone(instance);
    damage(copy);
    refusedAt(await call(auth, 'POST', at('/template-instances'), copy), location, phrases, `instance JSON create, ${what}`);
    const current = await call(auth, 'GET', path);
    const update = structuredClone(current.body);
    damage(update);
    refusedAt(await updateArtifact(auth, path, update, { current }), location, phrases, `instance JSON update, ${what}`);
    if (admin) {
      refusedAt(await call(admin.auth, 'PUT', `${path}?verbatim=true`, update, { headers: { 'If-Match': current.headers.get('etag') } }),
          location, phrases, `instance JSON verbatim write, ${what}`);
    }
  }

  const served = await call(auth, 'GET', path, undefined, { accept: 'application/yaml' });
  if (!checkStatus(served, 200, 'read the instance as YAML')) return;
  const yaml = withoutYamlId(served.text);
  refusedAt(await call(auth, 'POST', at('/template-instances'), yaml.replace(/value: "?7"?/, 'value: "abc"'), { contentType: 'application/yaml' }),
      '/Measurement/@value', [], 'instance YAML create, a number that is not one');
  for (const [what, damaged, key] of [
    ['a scalar beside its children', `${yaml}bogusKey: 1\n`, 'bogusKey'],
    ["a misspelled key in a field's value", yaml.replace(/^(\s+)value: "?ok"?\n/m, '$1value: "ok"\n$1labl: "x"\n'), 'labl'],
  ]) {
    check(damaged !== yaml, `instance YAML, ${what}: the damage applies`, 'the YAML did not change');
    const create = await call(auth, 'POST', at('/template-instances'), damaged, { contentType: 'application/yaml' });
    if (checkStatus(create, 400, `instance YAML create, ${what}: the write is refused`)) {
      const { message } = reported(create);
      check(message.includes('unknown key') && message.includes(key), `instance YAML create, ${what}: the answer names the key`, message.slice(0, 300));
    }
  }
}

export async function run({ user1, admin, folderId }) {
  const templateId = await schemaReports(user1.auth, admin, folderId);
  if (templateId) await instanceReports(user1.auth, admin, folderId, templateId);
}
