// Reads snapshot artifacts with cedar-model-typescript-library's strict JSON readers, driven over
// stdin and stdout.
//
// The framing is that of ops/cedar_snapshot_read_bridge.java: one JSON header line, then exactly
// "length" bytes of artifact source as the deployment served it, so one stream can feed both bridges.
//
//     {"seq": 1, "op": "template", "id": "<template IRI>", "length": N}
//     {"seq": 2, "op": "read", "kind": "template" | "element" | "field" | "instance", "templateId": "…", "length": N}
//
// Each request is answered with one JSON line echoing its "seq". A read answer carries a "reader"
// verdict from the strict readers: "read" when the reader reports success; "refused" when it reports
// errors, with the first of them and their count; "unparsable" when JsonSourcePolicy, the parser the
// readers use, refuses the source; and "threw" when the reader refuses by throwing. Warnings are
// counted, since a document can be read and still not be in the form the reader writes.
//
// A strict refusal is not the end of the question. The embeddable editor opens stored templates with
// the FEBRUARY_2024 behavior, which records the production variations the library knows of as
// warnings, so an artifact the strict reader refuses also carries a "lenient" verdict of the same
// shape from that behavior.
//
// A "template" request keeps that template, read the way the embeddable editor reads one, and is
// answered "kept". An instance read naming a kept template in "templateId" also carries the library's
// save decision as "validation": the instance as the reader built it, judged by InstanceValidator and
// summarised by ValidationPolicy, which is what the editor's Save follows. Its "canSave" is the answer
// the Java validator's verdict must equal, and the findings that block saving come with it.
//
//     node ops/cedar_snapshot_read_bridge.cjs <cedar-model-typescript-library>/dist/index.js

'use strict';

const libraryPath = process.argv[2];
if (!libraryPath) {
  process.stderr.write('usage: cedar_snapshot_read_bridge.cjs <library dist/index.js>\n');
  process.exit(2);
}
const library = require(libraryPath);
const { JsonSourcePolicy } = library;
function readersFor(behavior) {
  return {
    template: library.JsonTemplateReader[behavior](),
    element: library.JsonTemplateElementReader[behavior](),
    field: library.JsonTemplateFieldReader[behavior](),
    instance: library.JsonTemplateInstanceReader[behavior](),
  };
}
const strict = readersFor('getStrict');
const lenient = readersFor('getFebruary2024');
const ERROR_LIMIT = 5;
const MESSAGE_LIMIT = 400;
const TEMPLATE_CACHE = 256;
const templates = new Map();

function truncate(value) {
  const text = String(value);
  return text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT)}…`;
}

function describe(error) {
  return {
    location: truncate(error.errorLocation),
    type: error.errorType && typeof error.errorType.getValue === 'function' ? error.errorType.getValue() : String(error.errorType),
    path: error.errorPath && typeof error.errorPath.toPointer === 'function' ? error.errorPath.toPointer() : '',
  };
}

function read(kind, source, templateId) {
  const verdict = readWith(strict, kind, source);
  if (verdict.status === 'refused' || verdict.status === 'threw') verdict.lenient = readWith(lenient, kind, source);
  if (kind === 'instance' && templateId) {
    const kept = templates.get(templateId);
    const template = kept?.model;
    const instance = verdict.instance ?? verdict.lenient?.instance;
    if (!template) verdict.validation = { status: 'no-template' };
    else if (!instance) verdict.validation = { status: 'unreadable', canSave: false };
    else {
      try {
        // Judged against the stored template, as the server judges it.
        const summary = library.InstanceValidator.validateReport(instance, template, kept.stored);
        const blocking = summary.findings.filter((finding) => library.ValidationPolicy.blocksSave(finding, 'instance'));
        verdict.validation = {
          status: 'judged',
          canSave: summary.canSave,
          blocking: blocking.slice(0, ERROR_LIMIT).map((finding) => ({
            code: finding.code,
            category: finding.category,
            path: truncate(finding.path),
            message: truncate(finding.message),
          })),
          blockingCount: blocking.length,
        };
      } catch (error) {
        verdict.validation = { status: 'threw', canSave: false, message: truncate(error && error.message) };
      }
    }
  }
  delete verdict.instance;
  if (verdict.lenient) delete verdict.lenient.instance;
  return verdict;
}

function keepTemplate(id, source) {
  try {
    const stored = JsonSourcePolicy.parse(source);
    const model = lenient.template.readFromObject(stored).template;
    templates.delete(id);
    templates.set(id, { model, stored });
    if (templates.size > TEMPLATE_CACHE) templates.delete(templates.keys().next().value);
    return 'kept';
  } catch (error) {
    return `unreadable: ${truncate(error && error.message)}`;
  }
}

function readWith(readers, kind, source) {
  const reader = readers[kind];
  if (!reader) return { status: 'threw', message: `unknown kind: ${kind}` };
  let parsed;
  try {
    parsed = JsonSourcePolicy.parse(source);
  } catch (error) {
    return { status: 'unparsable', message: truncate(error && error.message) };
  }
  try {
    const result = reader.readFromObject(parsed);
    const parsing = result.parsingResult;
    const warningCount = parsing.getBlueprintComparisonWarningCount();
    const instance = kind === 'instance' ? result.instance : undefined;
    if (parsing.wasSuccessful()) return { status: 'read', warningCount, instance };
    const errors = parsing.getBlueprintComparisonErrors();
    return { status: 'refused', errorCount: errors.length, warningCount, errors: errors.slice(0, ERROR_LIMIT).map(describe), instance };
  } catch (error) {
    return { status: 'threw', exception: error && error.name, message: truncate(error && error.message) };
  }
}

let buffered = Buffer.alloc(0);
const answers = [];

function drain() {
  for (;;) {
    const newline = buffered.indexOf(10);
    if (newline < 0) return;
    const request = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
    const length = Math.max(0, request.length || 0);
    if (buffered.length < newline + 1 + length) return;
    const source = buffered.subarray(newline + 1, newline + 1 + length).toString('utf8');
    buffered = buffered.subarray(newline + 1 + length);
    const answer = { seq: request.seq };
    if (request.op === 'read') answer.reader = read(request.kind, source, request.templateId);
    else answer.status = request.op === 'template' ? keepTemplate(request.id, source) : 'error';
    answers.push(JSON.stringify(answer));
  }
}

process.stdin.on('data', (chunk) => {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
  drain();
  if (answers.length) {
    process.stdout.write(`${answers.join('\n')}\n`);
    answers.length = 0;
  }
});
process.stdin.on('end', () => {
  drain();
  if (answers.length) process.stdout.write(`${answers.join('\n')}\n`);
});
