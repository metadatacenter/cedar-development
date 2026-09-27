// Load the actual CEE source bundle, not a reimplementation of its preparation.
const {createRequire} = require('node:module');
const readline = require('node:readline');
const requireCee = createRequire(process.argv[2] + '/package.json');
const jsonld = requireCee('jsonld');
const {Parser, Writer, DataFactory} = requireCee('n3');
const cee = require(process.argv[3]);
const canonical = async (nquads) => jsonld.canonize(nquads, {
  inputFormat: 'application/n-quads', format: 'application/n-quads',
  canonizeOptions: {algorithm: 'RDFC-1.0', maxDeepIterations: 10000},
});
const doubleNormalized = (nquads) => new Promise((resolve, reject) => {
  const writer = new Writer({format: 'N-Quads'});
  const quads = new Parser({format: 'N-Quads', blankNodePrefix: ''}).parse(nquads);
  writer.addQuads(quads.map(q => {
    const o = q.object;
    if (o.termType !== 'Literal' || o.datatype.value !== 'http://www.w3.org/2001/XMLSchema#double'
        || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(o.value)
        || !Number.isFinite(Number(o.value))) return q;
    const value = Number(o.value);
    const text = Object.is(value, -0) ? '-0e+0' : value.toExponential();
    return DataFactory.quad(q.subject, q.predicate, DataFactory.literal(text, o.datatype), q.graph);
  }));
  writer.end((error, output) => error ? reject(error) : resolve(output));
});
const turtleNquads = (turtle) => new Promise((resolve, reject) => {
  const writer = new Writer({format: 'N-Quads'});
  writer.addQuads(new Parser({format: 'Turtle', blankNodePrefix: ''}).parse(turtle));
  writer.end((error, output) => error ? reject(error) : resolve(output));
});
async function convert(source, template) {
  const before = JSON.stringify(source);
  const result = {};
  try { result.ready = cee.toRdfReady(source, template); } catch (e) { result.preparationError = String(e); }
  const start = performance.now();
  try {
    result.nquads = await cee.toNQuads(source, template);
    result.ok = true;
  } catch (e) { result.ok = false; result.error = String(e); }
  result.elapsedMs = performance.now() - start;
  if (result.ok) {
    try { result.canonical = await canonical(result.nquads); }
    catch (e) { result.canonicalError = String(e); }
  }
  try {
    result.turtle = await cee.toTurtle(source, template);
    result.turtleCanonical = await canonical(await turtleNquads(result.turtle));
    result.turtleOk = true;
  } catch (e) { result.turtleOk = false; result.turtleError = String(e); }
  result.inputUnchanged = before === JSON.stringify(source);
  return result;
}
(async () => {
  for await (const line of readline.createInterface({input: process.stdin})) {
    try {
      const request = JSON.parse(line);
      const answer = request.action === 'canonical' ? {canonical: await canonical(
        request.normalizeDouble ? await doubleNormalized(request.nquads) : request.nquads)}
        : await convert(request.source, request.template);
      process.stdout.write(JSON.stringify(answer) + '\n');
    } catch (e) { process.stdout.write(JSON.stringify({bridgeError: String(e)}) + '\n'); }
  }
})();
