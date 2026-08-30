// The OpenAPI docs. Each API-serving server generates its spec from the code's swagger-core annotations
// at build time (swagger-maven-plugin-jakarta, bound to prepare-package) and serves it statically at
// /swagger-api/swagger.json, which the Swagger UI at /api reads. Nothing verified the served result, so
// a broken or empty generation — after an annotation change or a swagger-library bump — would ship as a
// blank doc page and go unnoticed. This checks each spec is present, valid OpenAPI 3, populated, and
// actually reflects the API.
//
// Resource, Terminology, Value Recommender and User are the four servers that publish a generated
// spec. The other API servers intentionally return 404 at this path.
import {
  suite, check, checkStatus, call, RESOURCE, TERMINOLOGY, VALUERECOMMENDER, USER_SERVER,
} from '../lib.mjs';

export const name = 'apidocs';

// minPaths sits comfortably below each server's current count (resource ~68, terminology ~40, user
// 5), so a broken or half-generated spec trips it while normal endpoint growth does not.
// mustDocument anchors the spec to the real API: an exact path that must be present if generation
// actually read the resources. Matching on a prefix would let a spec missing whole resource classes
// pass, which is how terminology's two version-aware search routes went unpublished — every path it
// generated began "/bioportal", so the omission satisfied the check.
const API_SERVERS = [
  { label: 'resource', base: RESOURCE, minPaths: 40, mustDocument: '/templates' },
  { label: 'terminology', base: TERMINOLOGY, minPaths: 20, mustDocument: '/search/hierarchy' },
  {
    label: 'valuerecommender', base: VALUERECOMMENDER, minPaths: 5,
    mustDocument: '/command/recommend',
  },
  { label: 'user', base: USER_SERVER, minPaths: 5, mustDocument: '/users/{id}/api-keys' },
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
    check(Object.hasOwn(paths, s.mustDocument),
        `${s.label}: it documents the real API (${s.mustDocument} is present)`,
        `no path was exactly "${s.mustDocument}"; paths began ${Object.keys(paths).slice(0, 5).join(', ')}`);

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
      const move = paths['/command/move-resource-to-folder']?.post;
      check(move?.parameters?.some(parameter => parameter?.$ref === '#/components/parameters/IfMatch'),
          'resource: move documents its required source If-Match header',
          'POST /command/move-resource-to-folder omitted the shared IfMatch parameter');
      check(!!move?.responses?.['412'] && !!move?.responses?.['428'],
          'resource: move documents stale and missing preconditions',
          'POST /command/move-resource-to-folder omitted 412 or 428');
      check(!!move?.responses?.['201']?.headers?.ETag,
          'resource: move documents the resulting source ETag',
          'POST /command/move-resource-to-folder response 201 omitted ETag');
      check(!!paths['/categories']?.post?.responses?.['409'],
          'resource: duplicate category creation documents its conflict response',
          'POST /categories omitted 409');

      for (const command of [
        'make-artifact-open', 'make-artifact-not-open', 'make-folder-open', 'make-folder-not-open',
      ]) {
        const operation = paths[`/command/${command}`]?.post;
        check(operation?.parameters?.some(parameter =>
          parameter?.$ref === '#/components/parameters/IfMatch'),
        `resource: ${command} documents its required If-Match header`,
        `POST /command/${command} omitted the shared IfMatch parameter`);
        check(!!operation?.responses?.['412'] && !!operation?.responses?.['428'],
            `resource: ${command} documents stale and missing preconditions`,
            `POST /command/${command} omitted 412 or 428`);
        check(!!operation?.responses?.['200']?.headers?.ETag,
            `resource: ${command} documents the resulting ETag`,
            `POST /command/${command} response 200 omitted ETag`);
      }

      for (const detailsPath of [
        '/templates/{template_id}/details',
        '/template-elements/{template_element_id}/details',
        '/template-fields/{template_field_id}/details',
        '/template-instances/{template_instance_id}/details',
      ]) {
        check(!!paths[detailsPath]?.get?.responses?.['200']?.headers?.ETag,
            `resource: ${detailsPath} documents its graph ETag`,
            `GET ${detailsPath} response 200 omitted ETag`);
      }

      for (const artifactPath of [
        '/templates/{template_id}',
        '/template-elements/{template_element_id}',
        '/template-fields/{template_field_id}',
        '/template-instances/{template_instance_id}',
      ]) {
        const operation = paths[artifactPath]?.delete;
        check(operation?.parameters?.some(parameter =>
          parameter?.$ref === '#/components/parameters/IfMatch'),
        `resource: DELETE ${artifactPath} documents its required If-Match header`,
        `DELETE ${artifactPath} omitted the shared IfMatch parameter`);
        check(!!operation?.responses?.['412'] && !!operation?.responses?.['428'],
            `resource: DELETE ${artifactPath} documents stale and missing preconditions`,
            `DELETE ${artifactPath} omitted 412 or 428`);
        check(!!operation?.responses?.['202'] && !!operation?.responses?.['204'],
            `resource: DELETE ${artifactPath} distinguishes pending and complete cleanup`,
            `DELETE ${artifactPath} omitted 202 or 204`);
      }
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
