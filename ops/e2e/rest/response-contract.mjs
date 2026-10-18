// A small success-response pilot. Call sites choose an operation explicitly and record one stable
// check; HTTP helpers and polling attempts do not add checks or change the expected inventory.
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CEDAR_ROOT = process.env.CEDAR_HOME ?? fileURLToPath(new URL('../../../../', import.meta.url));
const CONTRACTS = {
  group: { server: 'group', path: '/groups/{id}' },
  permissions: { server: 'resource', path: '/folders/{folder_id}/permissions' },
  listing: { server: 'resource', path: '/folders/{folder_id}/contents' },
};
// OpenAPI 3.0 Schema Objects include annotations outside JSON Schema. Ajv supports their nullable
// keyword; leave annotation strictness off, preserve additionalProperties, and never coerce data.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const documents = new Map();
const validators = new Map();

function validator(name) {
  if (validators.has(name)) return validators.get(name);
  const contract = CONTRACTS[name];
  if (!contract) throw new Error(`Unknown response contract: ${name}`);
  const { server, path } = contract;
  if (!documents.has(server)) {
    const spec = JSON.parse(readFileSync(resolve(CEDAR_ROOT, `cedar-${server}-server`,
        `cedar-${server}-server-application/src/main/resources/assets/swagger-api/swagger.json`), 'utf8'));
    if (!spec.openapi?.startsWith('3.0.')) throw new Error(`${server}: this pilot expects OpenAPI 3.0`);
    documents.set(server, spec);
  }
  const spec = documents.get(server);
  const schema = spec.paths?.[path]?.get?.responses?.['200']?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${server} GET ${path}: no documented 200 JSON schema`);
  // Keep the reference graph intact, including allOf and nested component references.
  const validate = ajv.compile({ ...schema, components: spec.components });
  validators.set(name, validate);
  return validate;
}

/** Null when the response satisfies its documented contract; otherwise a bounded diagnostic. */
export function responseContractProblem(name, response) {
  try {
    const validate = validator(name);
    if (response.status !== 200) return `expected HTTP 200, got ${response.status}`;
    const type = response.headers?.get('content-type') ?? '';
    if (type.split(';')[0].trim().toLowerCase() !== 'application/json') return `expected JSON, got ${type || 'no content type'}`;
    if (validate(response.body)) return null;
    return ajv.errorsText(validate.errors, { dataVar: 'response' }).slice(0, 1500);
  } catch (error) {
    return `response contract ${name}: ${error.message}`;
  }
}
