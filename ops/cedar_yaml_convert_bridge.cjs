// A long-lived front for cedar-model-typescript-library's YAML readers and JSON writers, driven
// over stdin and stdout.
//
// It answers one question: what JSON Schema the TypeScript library produces from a YAML document.
// The Java counterpart, ops/cedar_yaml_convert_bridge.java, answers the same question for the Java
// artifact library and validates either library's answer, so the two bridges together let a caller
// compare the renderings the two implementations agree to produce.
//
//     node ops/cedar_yaml_convert_bridge.cjs --lib <path to the library's dist/index.js>
//
// Requests are JSON objects, one per line, in the protocol cedar_validation_bridge.java documents.
// Every request may carry a "seq" the answer echoes.
//
//     {"op": "hello"}
//     {"op": "convert", "kind": "template" | "element" | "field", "yaml": "<document>",
//      "compact": false}
//     {"op": "shutdown"}
//
// A convert answer carries "status": "ok" with the rendered "json", or "error" with the "stage" it
// failed at — "read" for a document the model cannot represent, "render" for a model the JSON
// writer cannot write. The library's readers report a document that diverges from the blueprint
// without refusing it, so an "ok" answer also carries "readErrors" and "readWarnings": what the
// reader had to say about a document it nonetheless read.
//
// ops/cedar_yaml_conversion_audit.py is the caller this exists for.

'use strict';

const path = require('path');
const readline = require('readline');

// The library writes to the console on some paths, and a single stray line on stdout would be read
// as an answer. Everything but an answer goes to stderr, where the caller keeps a log.
for (const level of ['log', 'info', 'warn', 'debug', 'trace']) {
  console[level] = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
}

function parseArguments(argv) {
  const options = { lib: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--lib' && index + 1 < argv.length) {
      options.lib = argv[index + 1];
      index += 1;
    } else {
      process.stderr.write(`usage: cedar_yaml_convert_bridge.cjs --lib <library entry point>\n`);
      process.exit(2);
    }
  }
  if (!options.lib) {
    process.stderr.write('--lib is required\n');
    process.exit(2);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const libraryPath = path.resolve(options.lib);

let library;
try {
  library = require(libraryPath);
} catch (error) {
  process.stderr.write(`cannot load ${libraryPath}: ${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
}

for (const name of ['CedarYamlReaders', 'CedarJsonReaders', 'CedarWriters']) {
  if (!library[name]) {
    process.stderr.write(`${libraryPath} does not export ${name}; it is not a CEDAR model library build\n`);
    process.exit(2);
  }
}

const { CedarYamlReaders, CedarJsonReaders, CedarWriters } = library;
const readers = CedarYamlReaders.getStrict();
const compactReaders = CedarYamlReaders.getStrictForCompact();
const writers = CedarWriters.json().getStrict();
const jsonReaders = CedarJsonReaders.getStrict();
const yamlWriters = CedarWriters.yaml().getStrict();

/** What the reader had to say about a document it read anyway. */
function readerReport(parsingResult) {
  if (!parsingResult) {
    return { errors: [], warnings: [] };
  }
  const describe = (item) => {
    if (item === null || item === undefined) {
      return String(item);
    }
    if (typeof item === 'string') {
      return item;
    }
    if (typeof item.toString === 'function' && item.toString !== Object.prototype.toString) {
      return item.toString();
    }
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  };
  return {
    errors: (parsingResult.getBlueprintComparisonErrors() || []).map(describe),
    warnings: (parsingResult.getBlueprintComparisonWarnings() || []).map(describe),
  };
}

/**
 * Read a YAML document into the model and write it back out as JSON Schema.
 *
 * Reading and writing fail for different reasons and the caller counts them apart, so each step
 * reports the stage it was at rather than a single conversion failure.
 */
/**
 * Read a JSON Schema document into the artifact model and render it back out as YAML.
 *
 * The inverse of convert, reporting the same stages apart. It exists so a caller can start from
 * the document a deployment stores rather than from one a deployment rendered, which is the only
 * way this library's YAML writer is put under test rather than merely used.
 */
function render(request, answer) {
  const kind = request.kind;
  if (request.json === null || typeof request.json !== 'object' || Array.isArray(request.json)) {
    answer.status = 'error';
    answer.stage = 'parse';
    answer.message = 'render needs an object json document';
    return;
  }
  const compact = request.compact === true;

  let artifact;
  let report;
  try {
    if (kind === 'template') {
      const result = jsonReaders.getTemplateReader().readFromObject(request.json);
      artifact = result.template;
      report = readerReport(result.parsingResult);
    } else if (kind === 'element') {
      const result = jsonReaders.getTemplateElementReader().readFromObject(request.json);
      artifact = result.element;
      report = readerReport(result.parsingResult);
    } else if (kind === 'instance') {
      const result = jsonReaders.getTemplateInstanceReader().readFromObject(request.json);
      artifact = result.instance;
      report = readerReport(result.parsingResult);
    } else if (kind === 'field') {
      const result = jsonReaders.getTemplateFieldReader().readFromObject(request.json);
      artifact = result.field;
      report = readerReport(result.parsingResult);
    } else {
      answer.status = 'error';
      answer.stage = 'request';
      answer.message = `unknown kind: ${kind}`;
      return;
    }
  } catch (error) {
    answer.status = 'error';
    answer.stage = 'read';
    answer.exception = error && error.constructor ? error.constructor.name : typeof error;
    answer.message = error && error.message ? error.message : String(error);
    return;
  }

  try {
    const writer = kind === 'template' ? yamlWriters.getTemplateWriter()
      : kind === 'element' ? yamlWriters.getTemplateElementWriter()
        : kind === 'instance' ? yamlWriters.getTemplateInstanceWriter()
        : yamlWriters.getFieldWriterForField(artifact);
    answer.yaml = writer.getAsYamlString(artifact, compact);
    answer.status = 'ok';
    answer.readErrors = report.errors;
    answer.readWarnings = report.warnings;
  } catch (error) {
    answer.status = 'error';
    answer.stage = 'render';
    answer.exception = error && error.constructor ? error.constructor.name : typeof error;
    answer.message = error && error.message ? error.message : String(error);
  }
}

function convert(request, answer) {
  const kind = request.kind;
  if (typeof request.yaml !== 'string') {
    answer.status = 'error';
    answer.stage = 'request';
    answer.message = 'convert needs a textual yaml document';
    return;
  }
  const source = request.compact ? compactReaders : readers;

  let artifact;
  let report;
  try {
    if (kind === 'template') {
      const result = source.getTemplateReader().readFromString(request.yaml);
      artifact = result.template;
      report = readerReport(result.parsingResult);
    } else if (kind === 'element') {
      const result = source.getTemplateElementReader().readFromString(request.yaml);
      artifact = result.element;
      report = readerReport(result.parsingResult);
    } else if (kind === 'instance') {
      const result = source.getTemplateInstanceReader().readFromString(request.yaml);
      artifact = result.instance;
      report = readerReport(result.parsingResult);
    } else if (kind === 'field') {
      const result = source.getTemplateFieldReader().readFromString(request.yaml);
      artifact = result.field;
      report = readerReport(result.parsingResult);
    } else {
      answer.status = 'error';
      answer.stage = 'request';
      answer.message = `unknown kind: ${kind}`;
      return;
    }
  } catch (error) {
    answer.status = 'error';
    answer.stage = 'read';
    answer.exception = error && error.constructor ? error.constructor.name : typeof error;
    answer.message = error && error.message ? error.message : String(error);
    return;
  }

  try {
    const writer = kind === 'template' ? writers.getTemplateWriter()
      : kind === 'element' ? writers.getTemplateElementWriter()
        : kind === 'instance' ? writers.getTemplateInstanceWriter()
        : writers.getFieldWriterForField(artifact);
    const jsonText = writer.getAsJsonString(artifact);
    answer.json = JSON.parse(jsonText);
    // Parsing and re-stringifying in JS moves numeric property names ahead of other keys.
    // Audits of generated order must observe the writer's original text.
    if (request.includeJsonText) answer.jsonText = jsonText;
    answer.status = 'ok';
    answer.readErrors = report.errors;
    answer.readWarnings = report.warnings;
  } catch (error) {
    answer.status = 'error';
    answer.stage = 'render';
    answer.exception = error && error.constructor ? error.constructor.name : typeof error;
    answer.message = error && error.message ? error.message : String(error);
  }
}

const MESSAGE_LIMIT = 1000;

function truncate(answer) {
  if (typeof answer.message === 'string' && answer.message.length > MESSAGE_LIMIT) {
    answer.message = answer.message.slice(0, MESSAGE_LIMIT) + '…';
  }
  return answer;
}

function answerFor(line) {
  const answer = {};
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    answer.status = 'error';
    answer.message = `request is not JSON: ${error.message}`;
    return answer;
  }
  if ('seq' in request) {
    answer.seq = request.seq;
  }
  answer.op = request.op;
  const started = process.hrtime.bigint();
  try {
    switch (request.op) {
      case 'hello':
        answer.status = 'ok';
        answer.library = libraryPath;
        answer.libraryVersion = libraryVersion();
        answer.node = process.versions.node;
        break;
      case 'render':
        render(request, answer);
        break;
      case 'convert':
        convert(request, answer);
        break;
      case 'shutdown':
        answer.status = 'ok';
        break;
      default:
        answer.status = 'error';
        answer.message = `unknown op: ${request.op}`;
    }
  } catch (error) {
    // A malformed artifact can make the library throw rather than report, and one such document
    // must not end the run. The caller records the exception as that artifact's verdict.
    answer.status = 'error';
    answer.exception = error && error.constructor ? error.constructor.name : typeof error;
    answer.message = error && error.message ? error.message : String(error);
  }
  answer.millis = Number((process.hrtime.bigint() - started) / 1000000n);
  return truncate(answer);
}

/** The version the loaded build declares, so a run records which library produced its renderings. */
function libraryVersion() {
  for (const candidate of [path.join(path.dirname(libraryPath), 'package.json'),
    path.join(path.dirname(libraryPath), '..', 'package.json')]) {
    try {
      const declared = require(candidate);
      if (declared && declared.version) {
        return declared.version;
      }
    } catch {
      // Try the next location; a build without a package.json beside it is still usable.
    }
  }
  return null;
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  const answer = answerFor(line);
  process.stdout.write(JSON.stringify(answer) + '\n');
  if (answer.op === 'shutdown') {
    lines.close();
    process.exit(0);
  }
});
lines.on('close', () => process.exit(0));
