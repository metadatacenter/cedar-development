// Paging through an external authority, against the live registry it asks.
//
//   npm run smoke:rest:live-authorities
//
// The bridge answers /ext-auth/ror/search-by-name by asking the ROR registry, so a page from it says
// as much about ROR's availability and data as about CEDAR. These checks once ran in the REST tier,
// where a ROR outage, a rate limit or a change in how many organizations match would fail the gate
// that trains and releases require. They run here instead, and gate nothing. The bridge's own
// refusals of a bad limit or offset, or of a page number, which it makes before it asks the registry, stay in the
// REST tier's pagination suite.
//
// Reads only: nothing here creates anything, so there is nothing to clean up.
import { actors, call, check, checkStatus, summary, withSuite, suite, BRIDGE } from './lib.mjs';
import { envelopeProblems } from './paging-envelope.mjs';

const SEARCH = '/ext-auth/ror/search-by-name?q=stanford';
// The links a page from the middle of the results carries. Named here rather than read from the
// answer, so the checks do not change with the registry's data.
const LINKS = ['first', 'prev', 'next', 'last'];

const NAME = 'live-authorities';
const { user1 } = await actors();
await withSuite(NAME, async () => {
  suite('live authorities: a ROR search pages by offset');
  const auth = user1.auth;
  const get = query => call(auth, 'GET', `${SEARCH}&${query}`, undefined, { base: BRIDGE });

  checkStatus(await get('limit=2&offset=0'), 200, 'a ROR search answers its first page by offset');

  const middle = await get('limit=2&offset=2');
  if (checkStatus(middle, 200, 'a ROR search answers a later page by offset')) {
    const problems = envelopeProblems(middle.body, { limit: 2, offset: 2, links: true });
    check(problems.length === 0, 'the later page states its window, total, current offset and links',
        problems.slice(0, 4).join('; '));
    check(middle.body?.found === true, 'and still says whether it found an organization',
        `found was ${JSON.stringify(middle.body?.found)}`);
    check(!('page' in (middle.body ?? {})) && !('pageSize' in (middle.body ?? {})),
        'and states no page number or page size', `page was ${middle.body?.page}, pageSize ${middle.body?.pageSize}`);
    const paging = middle.body?.paging ?? {};
    for (const rel of LINKS) {
      const link = paging[rel];
      if (!check(typeof link === 'string', `the later page carries a ${rel} link`,
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
