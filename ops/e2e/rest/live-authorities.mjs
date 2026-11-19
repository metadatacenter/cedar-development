// Paging through an external authority, against the live registry it asks.
//
//   npm run smoke:rest:live-authorities
//
// The bridge answers /ext-auth/ror/search-by-name by asking the ROR registry, so a page from it says
// as much about ROR's availability and data as about CEDAR. These checks once ran in the REST tier,
// where a ROR outage, a rate limit or a change in how many organizations match would fail the gate
// that trains and releases require. They run here instead, and gate nothing. The bridge's own
// refusals of a bad limit, offset or page, which it makes before it asks the registry, stay in the
// REST tier's pagination suite.
//
// Reads only: nothing here creates anything, so there is nothing to clean up.
import { actors, call, check, checkStatus, summary, withSuite, suite, BRIDGE } from './lib.mjs';

const SEARCH = '/ext-auth/ror/search-by-name?q=stanford';
// The links a page from the middle of the results carries. Named here rather than read from the
// answer, so the checks do not change with the registry's data.
const LINKS = ['first', 'prev', 'next', 'last'];

const NAME = 'live-authorities';
const { user1 } = await actors();
await withSuite(NAME, async () => {
  suite('live authorities: a ROR search pages by offset and by number');
  const auth = user1.auth;
  const get = query => call(auth, 'GET', `${SEARCH}&${query}`, undefined, { base: BRIDGE });

  checkStatus(await get('limit=2&offset=0'), 200, 'a ROR search answers a valid page by offset');

  const numbered = await get('page=1&pageSize=2');
  if (checkStatus(numbered, 200, 'a ROR search answers a page asked for by number')) {
    const paging = numbered.body?.paging ?? {};
    for (const rel of LINKS) {
      const link = paging[rel];
      if (!check(typeof link === 'string', `the page by number carries a ${rel} link`,
          `paging was ${JSON.stringify(paging).slice(0, 160)}`)) continue;
      const followed = await call(auth, 'GET', link.replace(/^https?:[/][/][^/]+/, ''), undefined, { base: BRIDGE });
      check(followed.status === 200, `its ${rel} link can be followed`,
          `${link} answered ${followed.status}: ${(followed.text ?? '').slice(0, 120)}`);
    }
  }
});

const { passed, failed } = summary([NAME]);
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
