// Paging, across the listings that offer it. Thirty-one endpoints declare limit and offset; almost
// nothing exercises them, and a paging bug is the kind that hides — an off-by-one drops or repeats one
// row per page, invisible until someone notices a record that will not show up anywhere.
//
// Two listings are covered directly: a folder's contents, which nothing else touches, and search,
// which the search suite reaches for propagation but not for the shape of a page. Every other listing
// that pages, on every service, is held to the same refusal of a bad limit or offset, and those that
// also page by number to the rule that a request pages one way or the other.
import {
  suite, check, checkStatus, skip, call, mutate, updateArtifact, cleanup, artifactBody, permissions, everybodyGroup,
  poll, enc, RUN, ARTIFACT_SERVER, MESSAGING, MONITOR, BRIDGE,
} from '../lib.mjs';
import { cedarErrorProblem } from './errors.mjs';
import { responseContractProblem } from '../response-contract.mjs';

export const name = 'pagination';

const PAGE_TAG = `Paging${RUN.replace(/[^0-9]/g, '')}`;
const MODIFIED_TAG = `Modified${RUN.replace(/[^0-9]/g, '')}`;
const N = 5;

function badQuery(res, what) {
  checkStatus(res, 400, what);
  const problem = cedarErrorProblem(res);
  check(!problem && res.body?.status === 'BAD_REQUEST', `${what}: the refusal is a CedarError`,
      problem ?? `status was ${res.body?.status}`);
}

export async function run({ user1, user2, admin, folderId }) {
  const auth = user1.auth;

  suite('pagination: a folder\'s contents page correctly');

  // A folder with a known number of children, so every count below is exact.
  const boxName = `Pagination ${RUN}`;
  const box = await call(auth, 'POST', '/folders',
      { folderId, name: boxName, description: 'Created by the REST suites' });
  if (!checkStatus(box, 201, 'a folder is created to fill')) return {};
  const boxId = box.body['@id'];
  const contents = `/folders/${enc(boxId)}/contents`;
  cleanup('folder', `/folders/${enc(boxId)}`, boxName);

  let created = 0;
  for (let i = 1; i <= N; i++) {
    const label = `${PAGE_TAG} ${String(i).padStart(2, '0')}`;
    const post = await call(auth, 'POST', `/templates?folder_id=${enc(boxId)}`, artifactBody('template', label));
    if (post.status === 201) {
      created++;
      cleanup('template', `/templates/${enc(post.body['@id'])}`, label);
    }
  }
  if (!check(created === N, `all ${N} templates are created in it`, `only ${created} were created`)) return {};

  const full = await call(auth, 'GET', `${contents}?limit=100`);
  const contractProblem = responseContractProblem('listing', full);
  check(!contractProblem, 'the folder listing matches its OpenAPI response schema', contractProblem);
  if (checkStatus(full, 200, 'the folder lists its contents')) {
    check(full.body?.totalCount === N, `totalCount is ${N}`, `it was ${full.body?.totalCount}`);
    check((full.body?.resources ?? []).length === N, `and all ${N} rows come back in one large page`,
        `${(full.body?.resources ?? []).length} rows came back`);
  }

  // Walk the whole listing two rows at a time and reassemble it. Every row must appear exactly once.
  const seen = [];
  let overlap = false;
  for (let offset = 0; offset < N + 2; offset += 2) {
    const page = await call(auth, 'GET', `${contents}?limit=2&offset=${offset}`);
    if (page.status !== 200) { check(false, `page at offset ${offset} returns`, `got ${page.status}`); break; }
    const ids = (page.body?.resources ?? []).map(r => r['@id']);
    if (ids.some(id => seen.includes(id))) overlap = true;
    seen.push(...ids);
    check(page.body?.totalCount === N, `page at offset ${offset} reports the full count of ${N}`,
        `it reported ${page.body?.totalCount}`);
    const expected = Math.max(0, Math.min(2, N - offset)); // 2 while rows remain, the tail, then 0
    check(ids.length === expected, `the page at offset ${offset} holds ${expected} row(s)`,
        `it held ${ids.length}`);
  }
  const unique = new Set(seen);
  check(!overlap && unique.size === N,
      'walking the listing two at a time reassembles every row exactly once',
      `saw ${seen.length} rows, ${unique.size} distinct, overlap=${overlap}`);

  const beyond = await call(auth, 'GET', `${contents}?limit=10&offset=1000`);
  if (checkStatus(beyond, 200, 'a page past the end still answers 200')) {
    check((beyond.body?.resources ?? []).length === 0, 'and holds no rows',
        `it held ${(beyond.body?.resources ?? []).length}`);
    check(beyond.body?.totalCount === N, 'while still reporting the true total',
        `it reported ${beyond.body?.totalCount}`);
  }

  // The paging link block is the contract the UI follows to walk pages. First and last must be there
  // and must carry the limit that was asked for.
  const firstPage = await call(auth, 'GET', `${contents}?limit=2&offset=0`);
  const paging = firstPage.body?.paging ?? {};
  check(typeof paging.first === 'string' && paging.first.includes('limit=2'),
      'the response carries a first-page link at the requested limit',
      `paging was ${JSON.stringify(paging).slice(0, 200)}`);
  check(typeof paging.last === 'string' && paging.last.includes('limit=2'),
      'and a last-page link', `paging was ${JSON.stringify(paging).slice(0, 200)}`);

  suite('pagination: the contents-extract projection pages the same way');

  // contents-extract is the same listing in a lighter projection, through the same validator and
  // paging block. Walk the same box and confirm it, too, reassembles every row exactly once.
  const extract = `/folders/${enc(boxId)}/contents-extract`;
  const fullExtract = await call(auth, 'GET', `${extract}?limit=100`);
  if (checkStatus(fullExtract, 200, 'the folder lists its contents-extract')) {
    check(fullExtract.body?.totalCount === N, `contents-extract reports totalCount ${N}`,
        `it was ${fullExtract.body?.totalCount}`);
  }
  const seenX = [];
  let overlapX = false;
  for (let offset = 0; offset < N + 2; offset += 2) {
    const page = await call(auth, 'GET', `${extract}?limit=2&offset=${offset}`);
    if (page.status !== 200) { check(false, `contents-extract page at offset ${offset} returns`, `got ${page.status}`); break; }
    const ids = (page.body?.resources ?? []).map(r => r['@id']);
    if (ids.some(id => seenX.includes(id))) overlapX = true;
    seenX.push(...ids);
  }
  check(!overlapX && new Set(seenX).size === N,
      'walking contents-extract two at a time reassembles every row exactly once',
      `saw ${seenX.length}, ${new Set(seenX).size} distinct, overlap=${overlapX}`);

  suite('pagination: search pages the same way');

  // Indexing is asynchronous, so wait for the five to arrive before asserting on how they page.
  let indexed = 0;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await call(auth, 'GET', `/search?q=${enc(PAGE_TAG)}&limit=20`);
    indexed = res.body?.totalCount ?? 0;
    if (indexed >= N) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  if (check(indexed >= N, `all ${N} reach the search index`, `only ${indexed} were indexed after ~18s`)) {
    const walk = [];
    let dup = false;
    for (let offset = 0; offset < N + 2; offset += 2) {
      const page = await call(auth, 'GET', `/search?q=${enc(PAGE_TAG)}&limit=2&offset=${offset}`);
      const ids = (page.body?.resources ?? []).map(r => r['@id']);
      if (ids.some(id => walk.includes(id))) dup = true;
      walk.push(...ids);
    }
    check(!dup && new Set(walk).size === N, 'search paging reassembles every row exactly once',
        `saw ${walk.length}, ${new Set(walk).size} distinct, overlap=${dup}`);
  }

  suite('pagination: the category listing pages the same way');

  // The category listing is flat and paged like the rest. Populating it deterministically needs an
  // administrator — only they may write the tree — so this needs the admin key, whose absence is a
  // failure rather than a silent skip. The listing is graph-backed, so no indexing wait.
  if (check(!!admin, 'the administrator key is configured, so the category listing can be paged',
      'CEDAR_ADMIN_USER_API_KEY is unset; the admin-gated category paging cannot run')) {
    const adm = admin.auth;
    const rootId = (await call(adm, 'GET', '/categories/root')).body?.['@id'];
    const catIds = [];
    for (let i = 1; i <= N; i++) {
      const label = `${PAGE_TAG} cat ${String(i).padStart(2, '0')}`;
      const made = await call(adm, 'POST', '/categories',
          { 'schema:name': label, 'schema:description': 'Created by the REST suites', parentCategoryId: rootId });
      if (made.status === 201) { catIds.push(made.body['@id']); cleanup('category', `/categories/${enc(made.body['@id'])}`, label, adm); }
    }
    if (check(catIds.length === N, `${N} categories are created to page over`, `only ${catIds.length} were created`)) {
      // Read the total from a page, not a large-limit fetch: the shared validator caps limit at the
      // configured maximum, so an oversized limit is a 400 rather than one big page.
      const total = (await call(adm, 'GET', '/categories?limit=2&offset=0')).body?.totalCount ?? 0;
      // Only an assertion about the categories this suite created — the tree also holds whatever else
      // exists, so the walk is checked for no overlap and for each of the new rows appearing once,
      // rather than against a fixed total.
      const seenC = [];
      let overlapC = false;
      let pageFailure = null;
      let totalsStable = true;
      for (let offset = 0; offset < total + 2; offset += 2) {
        const page = await call(adm, 'GET', `/categories?limit=2&offset=${offset}`);
        if (page.status !== 200) { pageFailure = `offset ${offset} returned ${page.status}`; break; }
        const ids = (page.body?.categories ?? []).map(c => c['@id']);
        if (ids.some(id => seenC.includes(id))) overlapC = true;
        seenC.push(...ids);
        if (page.body?.totalCount !== total) {
          totalsStable = false;
          pageFailure ??= `offset ${offset} reported ${page.body?.totalCount} vs ${total}`;
        }
      }
      check(!pageFailure && totalsStable, 'every category page returns and reports the stable total',
          pageFailure ?? 'the total changed while walking the category listing');
      const mineOnce = catIds.every(id => seenC.filter(x => x === id).length === 1);
      check(!overlapC && mineOnce,
          'walking the category listing reassembles every row once, the new ones included',
          `overlap=${overlapC}, each new category present exactly once=${mineOnce}`);
    }
  }

  suite('pagination: an invalid limit or offset is refused with 400');

  // Both listings share one paging validator. It used to throw without marking the error a bad
  // request, so every one of these answered 500; a non-numeric limit faulted even earlier, in Jersey's
  // param conversion, and fell through the exception mapper to 500. Each is a client mistake and now
  // answers 400. The excessive limit is capped at the configured maximum (500) rather than being an
  // unbounded page size.
  const badArgs = [
    { what: 'a limit of zero', qs: 'limit=0' },
    { what: 'a negative limit', qs: 'limit=-1' },
    { what: 'a negative offset', qs: 'offset=-5' },
    { what: 'an excessive limit', qs: 'limit=100000' },
    { what: 'a fractional limit', qs: 'limit=1.5' },
    { what: 'a fractional offset', qs: 'offset=0.25' },
    { what: 'an overflowing limit', qs: 'limit=999999999999999999' },
    { what: 'an overflowing offset', qs: 'offset=2147483648' },
    { what: 'a non-numeric offset', qs: 'offset=null' },
  ];
  const endpoints = [
    { name: 'folder contents', path: contents },
    { name: 'folder contents-extract', path: extract },
    { name: 'search', path: `/search?q=${enc(PAGE_TAG)}` },
    { name: 'the category listing', path: '/categories' },
  ];
  for (const endpoint of endpoints) {
    const sep = endpoint.path.includes('?') ? '&' : '?';
    for (const bad of badArgs) {
      const res = await call(auth, 'GET', `${endpoint.path}${sep}${bad.qs}`);
      badQuery(res, `${endpoint.name} with ${bad.what} is refused with 400`);
    }
    // A non-numeric limit fails Jersey's parameter conversion before the request reaches the
    // application. Jersey reports that as 404. The shared exception mapper reclassifies a failed query
    // parameter as 400, which matches the validator's answer to a numeric limit out of range.
    const nonNumeric = await call(auth, 'GET', `${endpoint.path}${sep}limit=abc`);
    badQuery(nonNumeric,
        `${endpoint.name} with a non-numeric limit is a client error, not a server fault`);
  }

  suite('pagination: every other listing refuses an invalid limit or offset with 400');

  // The listings above are the ones whose rows this suite can count. Every other service that pages
  // by limit and offset reads the arguments through the same validator, or one of its own, and each
  // used to be checked by nothing. The administrator's listings are the monitor's, which only an
  // administrator may read; a run without the key fails rather than leaving them unread.
  const listings = [
    { name: 'search-deep', path: `/search-deep?q=${enc(PAGE_TAG)}` },
    { name: "the artifact server's templates", base: ARTIFACT_SERVER, path: '/templates' },
    { name: "the artifact server's elements", base: ARTIFACT_SERVER, path: '/template-elements' },
    { name: "the artifact server's fields", base: ARTIFACT_SERVER, path: '/template-fields' },
    { name: "the artifact server's instances", base: ARTIFACT_SERVER, path: '/template-instances' },
    { name: 'messages', base: MESSAGING, path: '/messages' },
    { name: 'an authority search', base: BRIDGE, path: '/ext-auth/ror/search-by-name?q=stanford' },
  ];
  if (check(!!admin, 'the administrator key is configured, so the monitor listings can be paged',
      'CEDAR_ADMIN_USER_API_KEY is unset; the admin-only monitor listings cannot run')) {
    for (const path of ['/logs/explorer/requests', '/logs/explorer/cypher', '/logs/explorer/outliers/requests',
      '/logs/explorer/outliers/cypher', '/logs/usage/endpoints', '/logs/usage/cypher', '/logs/usage/users']) {
      listings.push({ name: `the monitor's ${path}`, base: MONITOR, path, auth: admin.auth });
    }
  }
  for (const listing of listings) {
    const sep = listing.path.includes('?') ? '&' : '?';
    const get = qs => call(listing.auth ?? auth, 'GET', `${listing.path}${sep}${qs}`, undefined, { base: listing.base });
    const valid = await get('limit=2&offset=0');
    if (!checkStatus(valid, 200, `${listing.name} answers a valid page`)) continue;
    for (const bad of badArgs) {
      const res = await get(bad.qs);
      badQuery(res, `${listing.name} with ${bad.what} is refused with 400`);
    }
    const nonNumeric = await get('limit=abc');
    badQuery(nonNumeric,
        `${listing.name} with a non-numeric limit is a client error, not a server fault`);
  }

  suite('pagination: typed listings refuse invalid sorting and filters');

  // These routes declare the same typed query. Unknown parameters and arbitrary search text are
  // not invalid by definition; probe only values the declared sort and filter contracts reject.
  // The modification-time bounds are epoch milliseconds, and a value before March 1973 is refused as
  // most likely a time in seconds. A window that closes before it opens is refused, and so is a bound
  // given twice, even when the two values agree. Each of those refusals identifies the parameter at
  // fault, which the third entry names.
  const typedListings = [...endpoints.slice(0, 3), { name: 'search-deep', path: `/search-deep?q=${enc(PAGE_TAG)}` }];
  const NOON = 1_794_571_200_000; // 13 November 2026, 12:00 UTC
  const badFilters = [
    ['an unknown sort field', 'sort=not-a-sort'],
    ['a delimiter-bearing sort field', `sort=${enc('name;DROP TABLE')}`],
    ['a compound sort with an unknown field', 'sort=name,not-a-sort'],
    ['an unknown resource type', 'resource_types=template,not-a-type'],
    ['an unknown version filter', 'version=not-a-version'],
    ['a delimiter-only version filter', 'version=,'],
    ['an unknown publication filter', 'publication_status=not-a-status'],
    ['a delimiter-only publication filter', 'publication_status=,'],
    ['a reversed modification-time window', `modified_after=${NOON + 1}&modified_before=${NOON}`,
      ['modified_after', 'modified_before']],
    ['modified_after given twice', `modified_after=${NOON}&modified_after=${NOON}`, ['modified_after']],
    ['modified_before given twice', `modified_before=${NOON}&modified_before=${NOON}`, ['modified_before']],
    ['a modified_after in seconds', `modified_after=${NOON / 1000}`, ['modified_after']],
    ['a modified_before that is not a number', 'modified_before=yesterday', ['modified_before']],
  ];
  for (const listing of typedListings) {
    const sep = listing.path.includes('?') ? '&' : '?';
    checkStatus(await call(auth, 'GET', `${listing.path}${sep}sort=name&resource_types=template&version=all&publication_status=all`),
        200, `${listing.name} accepts valid sorting and filters`);
    // The HTTP Optional<String> binding treats an empty value as absent, before validation. Pin
    // that existing behavior separately from nonempty values outside the supported enumerations.
    const defaults = await call(auth, 'GET', `${listing.path}${sep}resource_types=&version=&publication_status=`);
    checkStatus(defaults, 200, `${listing.name} accepts empty optional filters as absent`);
    check(defaults.body?.request?.version === 'all' && defaults.body?.request?.publicationStatus === 'all' &&
        ['folder', 'field', 'element', 'template', 'instance'].every(kind =>
          defaults.body?.request?.resource_types?.includes(kind)),
    `${listing.name} uses the unfiltered defaults for empty optional filters`, 'empty filters changed the defaults');
    for (const [what, qs, named] of badFilters) {
      const res = await call(auth, 'GET', `${listing.path}${sep}${qs}`);
      badQuery(res, `${listing.name} with ${what} is refused with 400`);
      if (!named) continue;
      const identified = Object.keys(res.body?.parameters ?? {}).sort();
      check(JSON.stringify(identified) === JSON.stringify([...named].sort()),
          `${listing.name} with ${what}: the refusal identifies ${named.join(' and ')}`,
          `it identified ${JSON.stringify(identified)}`);
    }
  }

  suite('pagination: typed listings filter by modification time');

  // The two templates carry a term of their own, so the paging corpus keeps its exact counts. The
  // second is updated in a later second than it was created. Its modification time then differs from
  // its creation time, and a filter that read the creation time would fail at the bounds.
  const dated = [];
  for (const slug of ['first', 'second']) {
    const label = `${MODIFIED_TAG} ${slug}`;
    const post = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', label));
    if (post.status === 201) {
      dated.push({ id: post.body['@id'], at: `/templates/${enc(post.body['@id'])}`, body: post.body });
      cleanup('template', `/templates/${enc(post.body['@id'])}`, label);
    }
  }
  const modifiedOn = resource => Date.parse(resource?.['pav:lastUpdatedOn']);

  // These are the four typed listings, with search also read in two of its graph-backed modes. Folder
  // contents and a search with no term filter in the graph query, a term search filters in the index,
  // and a search by id compares the one resource it found. The extract reports only the fields it is
  // asked for, so it is asked for the modification time.
  const views = [
    { name: 'folder contents', path: () => `/folders/${enc(folderId)}/contents?limit=100` },
    { name: 'folder contents-extract',
      path: () => `/folders/${enc(folderId)}/contents-extract?field_names=${enc('pav:lastUpdatedOn')}&limit=100` },
    { name: 'search', path: () => `/search?q=${enc(MODIFIED_TAG)}&limit=20` },
    { name: 'search-deep', path: () => `/search-deep?q=${enc(MODIFIED_TAG)}&limit=20` },
    { name: 'search by id', path: id => `/search?id=${enc(id)}` },
    { name: 'search with no term', path: () => '/search?resource_types=template&sort=-lastUpdatedOnTS&limit=100' },
  ];
  // This reads what a view answers about one artifact under the given bounds, as the view's own user.
  // An absence counts only in a page the view served, so a refused request never passes for a filtered
  // one.
  const read = async (view, id, bounds = '') => {
    const res = await call(view.auth ?? auth, 'GET', `${view.path(id)}${bounds}`);
    return { status: res.status, row: (res.body?.resources ?? []).find(r => r['@id'] === id) };
  };
  const listed = answer => answer.status === 200 && !!answer.row;
  const absent = answer => answer.status === 200 && !answer.row;
  const said = (answer, kind = 'template') => (answer.status !== 200 ? `the request answered ${answer.status}`
    : `the ${kind} was ${answer.row ? 'listed' : 'not listed'}`);

  // A modification time is a whole second. The update is repeated until one lands in a later second
  // than the given time, which takes one second at most.
  const modifyAfter = (item, time) => poll(async attempt => {
    const current = await call(auth, 'GET', item.at);
    const put = await updateArtifact(auth, item.at,
        { ...current.body, 'schema:description': `Updated by the REST suites (${RUN}), attempt ${attempt}` },
        { current });
    const on = modifiedOn(put.body);
    return { done: put.status === 200 && on > time, status: put.status, on };
  }, { tries: 8, delayMs: 300 });

  // This holds a view to the window, given two artifacts it lists, the second modified in a later second
  // than the first. The view is read until it reports the time of the later modification, since the
  // index follows an update through a queue, and the bounds are taken from the times the view itself
  // reports. The window opens a millisecond after the first artifact's modification time and closes a
  // millisecond after the second's.
  async function checkWindow(view, first, second, modifiedAt) {
    const { kind = 'template', one = 'a template' } = view;
    const seen = await poll(async () => {
      const from = modifiedOn((await read(view, first.id)).row);
      const to = modifiedOn((await read(view, second.id)).row);
      return { done: to > from && to >= modifiedAt, from, to };
    });
    if (!check(seen.done, `${view.name} reports the second ${kind} as modified after the first`,
        `it reported ${seen.from} and ${seen.to} after ${seen.attempts} attempts`)) return;
    const { from, to } = seen;
    const window = `&modified_after=${from + 1}&modified_before=${to + 1}`;
    const inside = await read(view, second.id, window);
    check(listed(inside), `${view.name} lists ${one} modified inside the window`, said(inside, kind));
    const earlier = await read(view, first.id, window);
    check(absent(earlier), `${view.name} does not list ${one} modified before the window`, said(earlier, kind));
    const atLower = await read(view, second.id, `&modified_after=${to}`);
    check(listed(atLower), `${view.name} lists ${one} modified exactly at modified_after`, said(atLower, kind));
    const atUpper = await read(view, second.id, `&modified_before=${to}`);
    check(absent(atUpper), `${view.name} does not list ${one} modified exactly at modified_before`,
        said(atUpper, kind));
  }

  if (check(dated.length === 2, 'two templates are created to filter by modification time',
      `only ${dated.length} were created`)) {
    const [first, second] = dated;
    const apart = await modifyAfter(second, modifiedOn(second.body));
    if (check(apart.done, 'the second is then modified in a later second than either was created',
        `the last update answered ${apart.status} after ${apart.attempts} attempts`)) {
      for (const view of views) await checkWindow(view, first, second, apart.on);

      // The sharing views and a search by template apply the same graph condition as folder contents.
      // What differs is how each passes the window on to its query, so each is read with fixtures of its
      // own. A template shared with everybody leaves the shared-with-me view, so the two templates are
      // shared with the second user first and with everybody after. Sharing leaves a modification time
      // unchanged, and each view reports the times it filters on in any case.
      const u1 = user1.profile['@id'];
      const shareBoth = async grants => {
        const answers = [];
        for (const item of dated) {
          answers.push(await mutate(auth, 'PUT', `${item.at}/permissions`, permissions(u1, grants)));
        }
        return answers.find(res => res.status !== 200) ?? answers[0];
      };
      const sharedView = sharing => ({ name: `shared with ${sharing}`, auth: user2.auth,
        path: () => `/search?sharing=shared-with-${sharing}&resource_types=template&sort=-lastUpdatedOnTS&limit=100` });

      if (checkStatus(await shareBoth({ users: [[user2.profile['@id'], 'viewer']] }), 200,
          'the two templates are shared with the second user')) {
        await checkWindow(sharedView('me'), first, second, apart.on);
      }
      const everybody = await everybodyGroup(auth);
      if (checkStatus(await shareBoth({ groups: [[everybody['@id'], 'viewer']] }), 200,
          'the two templates are shared with everybody')) {
        await checkWindow(sharedView('everybody'), first, second, apart.on);
      }

      const instances = [];
      for (const slug of ['first', 'second']) {
        const label = `${MODIFIED_TAG} instance ${slug}`;
        const post = await call(auth, 'POST', `/template-instances?folder_id=${enc(folderId)}`,
            artifactBody('instance', label, { 'schema:isBasedOn': first.id }));
        if (post.status === 201) {
          instances.push({ id: post.body['@id'], at: `/template-instances/${enc(post.body['@id'])}`, body: post.body });
          cleanup('instance', `/template-instances/${enc(post.body['@id'])}`, label);
        }
      }
      if (check(instances.length === 2, 'two instances of the first template are created',
          `only ${instances.length} were created`)) {
        const later = await modifyAfter(instances[1], Math.max(...instances.map(i => modifiedOn(i.body))));
        if (check(later.done, 'the second instance is then modified in a later second than either was created',
            `the last update answered ${later.status} after ${later.attempts} attempts`)) {
          await checkWindow({ name: 'instances of a template', kind: 'instance', one: 'an instance',
            path: () => `/search?is_based_on=${enc(first.id)}&limit=100` }, instances[0], instances[1], later.on);
        }
      }
    }
  }

  // No API marks a folder special: a deployment's special folders are marked in the graph by hand. The
  // view is therefore read against a special folder the deployment already has, and a deployment with
  // none skips these checks. SearchByIdPermissionTest in the resource server marks a folder itself and
  // holds the view to the same window.
  const specials = await call(auth, 'GET', '/search?mode=special-folders&resource_types=folder&limit=100');
  checkStatus(specials, 200, 'special folders are listed without a window');
  const special = (specials.body?.resources ?? []).find(row => !Number.isNaN(modifiedOn(row)));
  const specialView = { name: 'special folders', path: () => '/search?mode=special-folders&resource_types=folder&limit=100' };
  const specialChecks = [
    ['lists a folder modified inside the window', at => `&modified_after=${at - 1}&modified_before=${at + 1}`, true],
    ['does not list a folder modified before the window', at => `&modified_after=${at + 1}`, false],
    ['lists a folder modified exactly at modified_after', at => `&modified_after=${at}`, true],
    ['does not list a folder modified exactly at modified_before', at => `&modified_before=${at}`, false],
  ];
  for (const [what, bounds, holds] of specialChecks) {
    if (!special) {
      skip(`special folders ${what}`, 'the deployment has no special folder this user can see');
      continue;
    }
    const answer = await read(specialView, special['@id'], bounds(modifiedOn(special)));
    check(holds ? listed(answer) : absent(answer), `special folders ${what}`, said(answer, 'folder'));
  }

  suite('pagination: a listing that pages by number as well refuses both at once');

  // Terminology and the external authorities still take a page number and a page size, for clients
  // that predate limit and offset. A request may page one way or the other. A link a page answers
  // with pages by offset, so a client paging by number can follow it; the authority search's links
  // used to carry the page number too, and every one of them was refused.
  const byNumber = [
    { name: 'an authority search', base: BRIDGE, path: '/ext-auth/ror/search-by-name?q=stanford' },
  ];
  for (const listing of byNumber) {
    const sep = listing.path.includes('?') ? '&' : '?';
    const both = await call(auth, 'GET', `${listing.path}${sep}page=1&pageSize=2&offset=2`, undefined,
        { base: listing.base });
    check(both.status === 400, `${listing.name} refuses a page number sent with an offset`,
        `expected 400, got ${both.status}: ${(both.text ?? '').slice(0, 120)}`);
    const numbered = await call(auth, 'GET', `${listing.path}${sep}page=1&pageSize=2`, undefined,
        { base: listing.base });
    if (!checkStatus(numbered, 200, `${listing.name} answers a page asked for by number`)) continue;
    const links = Object.entries(numbered.body?.paging ?? {}).filter(([, link]) => typeof link === 'string');
    check(links.length > 0, `${listing.name} answers a page by number with paging links`,
        `paging was ${JSON.stringify(numbered.body?.paging ?? null).slice(0, 160)}`);
    for (const [rel, link] of links) {
      const followed = await call(auth, 'GET', link.replace(/^https?:[/][/][^/]+/, ''), undefined,
          { base: listing.base });
      check(followed.status === 200, `${listing.name}'s ${rel} link from a page by number can be followed`,
          `${link} answered ${followed.status}: ${(followed.text ?? '').slice(0, 120)}`);
    }
  }

  suite('pagination: a window the search index cannot serve is refused with 400');

  // /search asks OpenSearch for offset+limit rows in one request, and OpenSearch refuses a window
  // wider than index.max_result_window (10,000). That refusal used to reach the caller as a 500 for
  // what is a client mistake. /search-deep walks to the offset instead, so the same depth is fine
  // there — which is the whole reason the second endpoint exists.
  const overWindow = await call(auth, 'GET', `/search?q=${enc(PAGE_TAG)}&offset=10000&limit=100`);
  check(overWindow.status === 400, 'search past the index result window is refused with 400',
      `expected 400, got ${overWindow.status}: ${(overWindow.text ?? '').slice(0, 120)}`);
  check((overWindow.text ?? '').includes('/search-deep'), 'and the refusal names the call that can serve it',
      `body was ${(overWindow.text ?? '').slice(0, 160)}`);

  const deepAtWindow = await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&offset=10000&limit=100`);
  check(deepAtWindow.status === 200, 'search-deep serves the same depth', `got ${deepAtWindow.status}`);

  // The deep walk is linear in the offset, so it is bounded too, just much further out.
  const atBound = await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&offset=500000&limit=5`);
  check(atBound.status === 200, 'search-deep serves an offset at the configured maximum', `got ${atBound.status}`);
  const pastBound = await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&offset=500001&limit=5`);
  check(pastBound.status === 400, 'and refuses one past it with 400',
      `expected 400, got ${pastBound.status}: ${(pastBound.text ?? '').slice(0, 120)}`);

  // Neither bound belongs to the graph-backed views, which page with SKIP and never touch the index.
  const sharedDeep = await call(auth, 'GET', '/search?sharing=shared-with-me&offset=20000&limit=5');
  check(sharedDeep.status === 200, 'a graph-backed sharing view still pages to any depth',
      `expected 200, got ${sharedDeep.status}: ${(sharedDeep.text ?? '').slice(0, 120)}`);

  suite('pagination: a continuation walks a whole result set');

  // The offset makes the server skip to a page; a continuation says where the last one stopped, so a
  // page costs the same wherever it falls and a whole result set can be read without the walk growing.
  // The tagged set is small, but the mechanism is the one a 400,000-row enumeration uses.
  const walked = [];
  let cursor = 'start';
  let requests = 0;
  let lastBody = null;
  let refused = null;
  while (cursor && requests < 10) {
    const page = await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&limit=2&continuation=${enc(cursor)}`);
    requests++;
    if (page.status !== 200) {
      refused = `page ${requests} answered ${page.status}: ${(page.text ?? '').slice(0, 120)}`;
      break;
    }
    lastBody = page.body;
    walked.push(...(page.body?.resources ?? []).map(r => r['@id']));
    cursor = page.body?.continuation ?? null;
  }
  check(refused === null, 'every page of the walk answers', refused ?? '');
  check(walked.length === N && new Set(walked).size === N,
      'the walk reads every row exactly once', `got ${walked.length} row(s), ${new Set(walked).size} distinct`);
  check(cursor === null, 'and stops by answering without a continuation', `it was still ${cursor}`);
  check(lastBody?.totalCount === N, 'every page reports the total the walk began with',
      `the last page said ${lastBody?.totalCount}`);

  const walkStart = await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&limit=2&continuation=start`);
  if (checkStatus(walkStart, 200, 'the first page of a walk returns')) {
    check(!!walkStart.body?.paging?.next && walkStart.body.paging.next.includes('continuation='),
        'its next link carries the continuation, not an offset', `next was ${walkStart.body?.paging?.next}`);
    const followed = await call(auth, 'GET', walkStart.body.paging.next.replace(/^https?:[/][/][^/]+/, ''));
    check(followed.status === 200, 'and following that link works', `got ${followed.status}`);
  }

  // A continuation names a position in one search. Everything that would make it mean something else
  // is refused rather than answered from the wrong place.
  const token = walkStart.body?.continuation;
  check((await call(auth, 'GET', `/search?q=${enc(PAGE_TAG)}&continuation=start`)).status === 400,
      'search refuses a continuation, which only search-deep serves', 'it did not');
  check((await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&continuation=start&offset=5`)).status === 400,
      'a continuation together with an offset is refused', 'it did not');
  check((await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&continuation=not-a-real-token`)).status === 400,
      'a token this server did not issue is refused', 'it did not');
  if (token) {
    check((await call(auth, 'GET', `/search-deep?q=${enc(PAGE_TAG)}&limit=2&sort=name&continuation=${enc(token)}`)).status === 400,
        'and a token replayed against a changed search is refused', 'it did not');
  }

  return {};
}
