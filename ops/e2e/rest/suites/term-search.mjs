// The terminology server's search, read the way the term picker reads it.
//
// The picker in cedar-embeddable-term-picker is tested against answers written by hand. The only
// journey that reaches the real server, the pinned-branch journey, searches for classes and
// branches. A change in the shape of the ontology, value-set or property answers would therefore
// pass every suite and reach an author as "invalid response". This suite asks one live search of
// each kind and holds the answer to the picker's own rule: `validSearchResponse` in
// src/app/search/response-validation.ts for `POST /search`, and the fields `searchProperties` in
// src/app/search/terminology-client.ts maps from `POST /properties/search`. A change to either of
// those belongs here too.
//
// Each search must also find something, since an empty collection satisfies any rule about the
// shape of its hits. The queries are ones DOID and CEDARVS answer, the two vocabularies the freeze
// suite relies on. When the local store does not serve them, as in production by default, the
// suite skips.
import { suite, check, checkStatus, skip, call, TERMINOLOGY } from '../lib.mjs';

export const name = 'term-search';

const SEARCHES = [
  { what: 'DOID classes and branches for "melanoma"', kinds: ['class', 'branch'],
    body: { query: 'melanoma', types: ['class', 'branch'], sources: [{ sourceAcronym: 'DOID' }], limit: 5 } },
  { what: 'the DOID ontology for "disease"', kinds: ['ontology'],
    body: { query: 'disease', types: ['ontology'], sources: [{ sourceAcronym: 'DOID' }], limit: 5 } },
  { what: 'CEDARVS value sets for "type"', kinds: ['valueSet'],
    body: { query: 'type', types: ['valueSet'], sources: [{ sourceAcronym: 'CEDARVS' }], limit: 5 } },
];
const PROPERTY_SEARCH = { query: 'material', sources: [{ sourceAcronym: 'DOID' }], limit: 5 };

const searchChecks = what => [`the search for ${what} answers`,
  `the answer for ${what} is one the picker accepts`, `and it finds ${what}`];
const PROPERTY_CHECKS = ['the property search for DOID "material" answers',
  'its answer carries every field the picker maps', 'and it finds a DOID property'];
// GET /search/hierarchy, the picker's second call, which it makes when an author opens a class hit.
// Asked of the first class the melanoma search finds.
const HIERARCHY_CHECKS = ['the hierarchy of a DOID class answers', 'its answer is one the picker accepts',
  'and it places the class below an ancestor'];

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
// The picker applies the model library's identifier policy, which this harness does not carry. This
// keeps the parts of it a change of shape would break: an absolute IRI, with something after its
// scheme other than an empty authority, no space, control or forbidden character, and at most one
// fragment. term-search.test.mjs holds it to the policy on the cases it lists.
const iri = value => text(value) && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`\u007f-\u009f]+$/.test(value)
  && !['', '//'].includes(value.slice(value.indexOf(':') + 1).split('#', 1)[0])
  && value.indexOf('#') === value.lastIndexOf('#');
const refs = value => value === undefined || (Array.isArray(value) && value.every(ref =>
  object(ref) && iri(ref.termIri) && (ref.termLabel === undefined || text(ref.termLabel))));
const labels = value => value === undefined
  || (Array.isArray(value) && value.every(label => object(label) && text(label.label)));
const KINDS = ['class', 'branch', 'ontology', 'valueSet', 'property'];

/**
 * What the picker's readSearchResponse refuses in an answer, one line per reason. The picker leaves
 * out a result kind it does not know rather than refusing the answer, so this does too.
 * term-search.test.mjs feeds the same answers to this and to the picker's own source.
 */
export function refusals(body) {
  if (!object(body) || !text(body.query) || !Array.isArray(body.sources) || !object(body.results)) {
    return ['the answer lacks its query, sources or results'];
  }
  const found = [];
  body.sources.forEach((source, i) => {
    if (!object(source) || !text(source.sourceAcronym) || !text(source.sourceSystem)
        || (source.versions !== undefined && !Array.isArray(source.versions))) {
      found.push(`source ${i} lacks its acronym or system, or its versions are not a list`);
    }
  });
  for (const [kind, result] of Object.entries(body.results)) {
    if (result === undefined || !KINDS.includes(kind)) continue;
    if (!object(result) || !count(result.totalCount) || !Array.isArray(result.collection)) {
      found.push(`the ${kind} results lack a count or a collection`);
      continue;
    }
    result.collection.forEach((hit, i) => {
      const where = `${kind} hit ${i}`;
      if (!object(hit) || hit.type !== kind || !text(hit.sourceAcronym) || !text(hit.sourceSystem)) {
        found.push(`${where} lacks its type, acronym or system`);
        return;
      }
      if (!refs(hit.path) || !refs(hit.examples) || !refs(hit.matchedTerms)) found.push(`${where} has a malformed term reference`);
      if (!labels(hit.matchedLabels) || !labels(hit.names)) found.push(`${where} has a malformed label`);
      if ((kind === 'class' || kind === 'property') && !(iri(hit.termIri) && text(hit.termLabel))) {
        found.push(`${where} lacks its IRI or label`);
      }
      if (kind === 'property' && !(text(hit.versionId) && ['object', 'datatype', 'annotation'].includes(hit.propertyKind))) {
        found.push(`${where} lacks its version or property kind`);
      }
      if ((kind === 'branch' || kind === 'valueSet') && !iri(hit.termBaseIri)) found.push(`${where} lacks its base IRI`);
      if (kind === 'branch' && !text(hit.termBaseLabel)) found.push(`${where} lacks its base label`);
      if (kind === 'valueSet' && hit.termBaseLabel !== undefined && !text(hit.termBaseLabel)) {
        found.push(`${where} has a base label that is not text`);
      }
    });
  }
  return found;
}

/** What the picker's validHierarchy refuses in a hierarchy answer for a term, one line per reason. */
export function hierarchyRefusals(body, acronym, termIri) {
  if (!object(body)) return ['the answer is not an object'];
  const found = [];
  if (body.sourceAcronym !== acronym || body.termIri !== termIri) found.push('it names another source or term');
  if (!text(body.termLabel)) found.push('it lacks the term\'s label');
  if (!count(body.childCount)) found.push('it lacks a child count');
  if (!refs(body.path) || !refs(body.children)) found.push('its path or children hold a malformed term reference');
  return found;
}

/** What searchProperties would map to nothing, one line per reason. */
export function propertyRefusals(body) {
  if (!object(body) || !count(body.total) || !count(body.page) || !count(body.pageSize) || !Array.isArray(body.items)) {
    return ['the answer lacks its total, page, page size or items'];
  }
  const found = [];
  body.items.forEach((item, i) => {
    const property = item?.property;
    if (!object(item) || !text(item.sourceAcronym) || !text(item.versionId) || !object(property)
        || !iri(property.iri) || !text(property.label) || !['object', 'datatype', 'annotation'].includes(property.kind)
        || typeof property.obsolete !== 'boolean' || typeof property.hasChildren !== 'boolean') {
      found.push(`property item ${i} lacks a field the picker maps`);
    }
  });
  return found;
}

/**
 * Whether the local store serves a vocabulary, asked the way the freeze suite asks. Only a 404 means
 * it does not; any other failure is the server's and fails the suite.
 */
async function served(auth, query) {
  const res = await call(auth, 'GET', `/bioportal/${query}`, undefined, { base: TERMINOLOGY });
  if (res.status === 404) return false;
  if (res.status !== 200 || !text(res.body?.id) || !res.body.id.trim()) {
    throw new Error(`Cannot tell whether the local store serves ${query}: HTTP ${res.status}`);
  }
  return true;
}

export async function run({ user1 }) {
  suite('term-search: the terminology server answers each kind of search in the shape the picker reads');

  const doid = await served(user1.auth, 'ontologies/DOID/versions/current');
  const cedarvs = await served(user1.auth, 'vs-collections/version-current?collection=CEDARVS');
  if (!doid || !cedarvs) {
    const reason = `the local terminology store does not serve DOID/CEDARVS (DOID: ${doid}, CEDARVS: ${cedarvs})`;
    for (const what of [...SEARCHES.flatMap(search => searchChecks(search.what)), ...PROPERTY_CHECKS,
      ...HIERARCHY_CHECKS]) skip(what, reason);
    return {};
  }

  let classHit;
  for (const search of SEARCHES) {
    const [answers, accepted, finds] = searchChecks(search.what);
    const res = await call(null, 'POST', '/search', search.body, { base: TERMINOLOGY });
    classHit ??= res.body?.results?.class?.collection?.[0];
    if (!checkStatus(res, 200, answers)) {
      skip(accepted, 'the search did not answer');
      skip(finds, 'the search did not answer');
      continue;
    }
    const refused = refusals(res.body);
    check(refused.length === 0, accepted, refused.slice(0, 5).join('; '));
    const empty = search.kinds.filter(kind => !(res.body?.results?.[kind]?.collection?.length > 0));
    check(empty.length === 0, finds, `no ${empty.join(' or ')} hit`);
  }

  const [answers, accepted, finds] = PROPERTY_CHECKS;
  const res = await call(null, 'POST', '/properties/search', PROPERTY_SEARCH, { base: TERMINOLOGY });
  if (checkStatus(res, 200, answers)) {
    const refused = propertyRefusals(res.body);
    check(refused.length === 0, accepted, refused.slice(0, 5).join('; '));
    check(res.body?.items?.length > 0, finds, 'no property was found');
  } else {
    skip(accepted, 'the search did not answer');
    skip(finds, 'the search did not answer');
  }

  const [hierarchyAnswers, hierarchyAccepted, placed] = HIERARCHY_CHECKS;
  if (!check(iri(classHit?.termIri), 'the class search names a class whose hierarchy to ask',
      'the class search found no class to ask about')) {
    skip(hierarchyAccepted, 'no class was found to ask about');
    skip(placed, 'no class was found to ask about');
    return {};
  }
  const query = new URLSearchParams({ sourceAcronym: classHit.sourceAcronym, termIri: classHit.termIri });
  const tree = await call(null, 'GET', `/search/hierarchy?${query}`, undefined, { base: TERMINOLOGY });
  if (!check(tree.status === 200, hierarchyAnswers, `expected 200, got ${tree.status}: ${(tree.text ?? '').slice(0, 200)}`)) {
    skip(hierarchyAccepted, 'the hierarchy did not answer');
    skip(placed, 'the hierarchy did not answer');
    return {};
  }
  const refused = hierarchyRefusals(tree.body, classHit.sourceAcronym, classHit.termIri);
  check(refused.length === 0, hierarchyAccepted, refused.join('; '));
  check(tree.body?.path?.length > 0, placed, `the path was ${JSON.stringify(tree.body?.path)}`);
  return {};
}
