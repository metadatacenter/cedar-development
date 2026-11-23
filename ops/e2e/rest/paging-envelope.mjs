// The paging envelope every offset-paged CEDAR route answers, and what an answer lacks of it.
//
// A page states the window it answers: `request` holds the limit and offset that were sent,
// `totalCount` how many rows match and `currentOffset` where this page starts. A GET also answers a
// `paging` block of links a client follows to walk the pages: `first` always, `prev` past the first
// page, `next` while rows remain, and `last` unless the total is a capped window (`countCapped`). A
// POST has no address to link to, so it answers no links.

const count = value => Number.isSafeInteger(value) && value >= 0;
// The limit a link asks for, or null when it names none.
const linkLimit = link => {
  const named = /[?&]limit=(\d+)(?:&|#|$)/.exec(link);
  return named ? Number(named[1]) : null;
};

/**
 * What `block` lacks of the envelope for the page asked for with `limit` and `offset`, one line per
 * reason. `links` says whether the route is a GET and so must carry the `paging` links.
 */
export function envelopeProblems(block, { limit, offset, links }) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ['the answer is not an object'];
  const found = [];
  const request = block.request;
  if (request?.limit !== limit || request?.offset !== offset) {
    found.push(`request was ${JSON.stringify(request)}, not the limit ${limit} and offset ${offset} sent`);
  }
  if (!count(block.totalCount)) found.push(`totalCount was ${JSON.stringify(block.totalCount)}`);
  if (block.currentOffset !== offset) {
    found.push(`currentOffset was ${JSON.stringify(block.currentOffset)}, not the offset ${offset} sent`);
  }
  if (!links) return found;
  const paging = block.paging;
  if (!paging || typeof paging !== 'object') return [...found, `paging was ${JSON.stringify(paging)}`];
  const expected = ['first'];
  if (offset > 0) expected.push('prev');
  if (count(block.totalCount) && offset + limit < block.totalCount) expected.push('next');
  if (block.countCapped !== true) expected.push('last');
  for (const rel of expected) {
    const link = paging[rel];
    if (typeof link !== 'string' || linkLimit(link) !== limit) {
      found.push(`the ${rel} link was ${JSON.stringify(link)}, not one at the limit ${limit}`);
    }
  }
  if (block.countCapped === true && paging.last !== undefined && paging.last !== null) {
    found.push('a capped count carries a last link');
  }
  return found;
}
