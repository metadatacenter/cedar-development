// Pure deterministic scheduling shared by k6 and the backend-free Node tests. A complete cycle
// always contains the original operation multiset, but different actors and cycles see different
// orders. The seed, actor index and iteration therefore identify an operation exactly.

export function hashSeed(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function scheduledValue(values, seed, actorIndex, iteration) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('scheduled values must not be empty');
  if (!Number.isInteger(actorIndex) || actorIndex < 0) throw new Error('actor index must be a non-negative integer');
  if (!Number.isInteger(iteration) || iteration < 0) throw new Error('iteration must be a non-negative integer');

  const cycle = Math.floor(iteration / values.length);
  const slot = iteration % values.length;
  const shuffled = [...values];
  const random = randomGenerator(hashSeed(`${seed}:actor:${actorIndex}:cycle:${cycle}`));
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  const phase = hashSeed(`${seed}:actor:${actorIndex}:phase`) % values.length;
  return shuffled[(slot + phase) % values.length];
}
