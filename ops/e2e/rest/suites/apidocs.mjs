// The OpenAPI docs. Each API-serving server generates its spec from the code's swagger-core annotations
// at build time (swagger-maven-plugin-jakarta, bound to prepare-package) and serves it statically at
// /swagger-api/swagger.json, which the Swagger UI at /api reads. Nothing verified the served result, so
// a broken or empty generation — after an annotation change or a swagger-library bump — would ship as a
// blank doc page and go unnoticed. This checks each spec is present, valid OpenAPI 3, populated, and
// actually reflects the API.
//
// Resource, Terminology and Value Recommender are the three servers that publish a generated spec.
// The other API servers intentionally return 404 at this path.
import {
  suite, check, checkStatus, call, RESOURCE, TERMINOLOGY, VALUERECOMMENDER,
} from '../lib.mjs';

export const name = 'apidocs';

// minPaths sits comfortably below each server's current count (resource ~68, terminology ~37), so a
// broken or half-generated spec trips it while normal endpoint growth does not. mustDocument anchors
// the spec to the real API: a path that must be present if generation actually read the resources.
const API_SERVERS = [
  { label: 'resource', base: RESOURCE, minPaths: 40, mustDocument: '/templates' },
  { label: 'terminology', base: TERMINOLOGY, minPaths: 20, mustDocument: '/bioportal' },
  {
    label: 'valuerecommender', base: VALUERECOMMENDER, minPaths: 5,
    mustDocument: '/command/recommend',
  },
];

function hasProperties(spec, schemaName, expected) {
  const properties = spec.components?.schemas?.[schemaName]?.properties ?? {};
  return expected.every(name => Object.hasOwn(properties, name));
}

export async function run() {
  suite('apidocs: each API server serves a valid, populated OpenAPI 3 spec');

  for (const s of API_SERVERS) {
    // The spec is a public static asset — no auth needed.
    const res = await call(null, 'GET', '/swagger-api/swagger.json', undefined, { base: s.base });
    if (!checkStatus(res, 200, `${s.label}: serves /swagger-api/swagger.json`)) continue;

    const spec = res.body ?? {};
    check(typeof spec.openapi === 'string' && spec.openapi.startsWith('3.'),
        `${s.label}: it is an OpenAPI 3 document`, `openapi was ${JSON.stringify(spec.openapi)}`);
    check(!!spec.info?.title && !!spec.info?.version,
        `${s.label}: it carries an info title and version`, `info was ${JSON.stringify(spec.info)}`);

    const paths = spec.paths ?? {};
    const count = Object.keys(paths).length;
    check(count >= s.minPaths, `${s.label}: it documents a populated set of paths (>= ${s.minPaths})`,
        `only ${count} path(s) — a near-empty spec means generation broke`);
    check(Object.keys(paths).some(p => p.includes(s.mustDocument)),
        `${s.label}: it documents the real API (a ${s.mustDocument} path is present)`,
        `no path contained "${s.mustDocument}"; paths began ${Object.keys(paths).slice(0, 5).join(', ')}`);

    // A documented path with no operations is a generation glitch, not a real endpoint.
    const emptyPath = Object.entries(paths).find(([, ops]) => !ops || Object.keys(ops).length === 0);
    check(!emptyPath, `${s.label}: every documented path carries at least one operation`,
        `path ${emptyPath?.[0]} had no operations`);

    // Population alone cannot catch a stale, otherwise-valid generated file. Anchor the contract to
    // the model and response annotations whose omission prompted this coverage.
    if (s.label === 'terminology') {
      check(hasProperties(spec, 'BranchValueConstraint', ['iri', 'maxDepth', 'name', 'source']),
          'terminology: branch constraints document their complete wire shape',
          'BranchValueConstraint omitted one or more of iri, maxDepth, name, source');
      check(hasProperties(spec, 'ValueConstraints', [
        'defaultValue', 'multipleChoice', 'recommendedValue', 'requiredValue',
      ]), 'terminology: field constraints document defaults and selection rules',
      'ValueConstraints omitted one or more default/selection properties');
    }

    if (s.label === 'resource') {
      const rename = paths['/command/rename-resource']?.post;
      const renameParameters = rename?.parameters ?? [];
      check(renameParameters.some(parameter => parameter?.$ref === '#/components/parameters/IfMatch'),
          'resource: rename documents its required If-Match header',
          'POST /command/rename-resource omitted the shared IfMatch parameter');
      check(!!rename?.responses?.['412'] && !!rename?.responses?.['428'],
          'resource: rename documents stale and missing preconditions',
          'POST /command/rename-resource omitted 412 or 428');
      check(!!paths['/categories']?.post?.responses?.['409'],
          'resource: duplicate category creation documents its conflict response',
          'POST /categories omitted 409');
    }

    if (s.label === 'valuerecommender') {
      const unavailable = path => paths[path]?.post?.responses?.['503']?.description;
      check(unavailable('/command/can-generate-recommendations') === 'OpenSearch unavailable',
          'valuerecommender: capability checks document OpenSearch unavailability',
          'the capability endpoint did not document its 503 response');
      check(unavailable('/command/recommend') === 'OpenSearch unavailable',
          'valuerecommender: recommendations document OpenSearch unavailability',
          'the recommendation endpoint did not document its 503 response');
    }
  }

  // A valid spec is only useful if a human can read it. /api/ is the Swagger UI, served statically
  // (nginx aliases it to the cedar-swagger-ui directory, the same bundle for every server). The spec
  // is OpenAPI 3, so the UI must be Swagger UI 3+; the 2.x line boots `new SwaggerUi(...)`, cannot
  // parse an OpenAPI 3 document, and hangs forever at "fetching resource list". The spec checks above
  // all pass against a 2.x UI, so nothing here caught that the page never rendered — this closes it.
  suite('apidocs: the Swagger UI can render the OpenAPI 3 spec');
  const ui = await call(null, 'GET', '/api/', undefined, { base: RESOURCE });
  if (checkStatus(ui, 200, 'the Swagger UI is served at /api/')) {
    const html = ui.text ?? '';
    check(/SwaggerUIBundle/.test(html) && !/new\s+SwaggerUi\b/.test(html),
        'the UI is Swagger UI 3+ (SwaggerUIBundle), able to render an OpenAPI 3 document',
        'the page still boots the 2.x "new SwaggerUi(...)", which cannot parse OpenAPI 3 — /api/ hangs at "fetching resource list"');
  }

  return {};
}
