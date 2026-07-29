// Search and its variants, including the paging parameters that thirty-one endpoints declare and
// almost nothing exercises.
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN } from '../lib.mjs';

export const name = 'search';

export async function run({ user1, folderId }) {
  const auth = user1.auth;
  suite('search: propagation and variants');

  // Three artifacts sharing a distinctive term, so paging has something to page over.
  const tag = `SearchProbe${RUN.replace(/[^0-9]/g, '')}`;
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const label = `${tag} ${i}`;
    const post = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
        artifactBody('template', label));
    if (post.status === 201) {
      ids.push(post.body['@id']);
      cleanup('template', `/templates/${enc(post.body['@id'])}`, label);
    }
  }
  if (!check(ids.length === 3, 'three templates created to search for', `only ${ids.length} were created`)) return {};

  // Indexing is asynchronous, so poll rather than assume.
  let found = 0;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await call(auth, 'GET', `/search?q=${encodeURIComponent(tag)}&limit=10`);
    found = res.body?.totalCount ?? 0;
    if (found >= 3) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  check(found >= 3, 'all three reach the search index', `only ${found} were indexed after ~18s`);

  // Paging. An off-by-one here would silently drop or duplicate a row in every listing.
  const page1 = await call(auth, 'GET', `/search?q=${encodeURIComponent(tag)}&limit=2&offset=0`);
  const page2 = await call(auth, 'GET', `/search?q=${encodeURIComponent(tag)}&limit=2&offset=2`);
  checkStatus(page1, 200, 'first page returns');
  checkStatus(page2, 200, 'second page returns');
  const first = (page1.body?.resources ?? []).map(r => r['@id']);
  const second = (page2.body?.resources ?? []).map(r => r['@id']);
  check(first.length === 2, 'a limit of 2 returns 2 rows', `got ${first.length}`);
  check(!first.some(id => second.includes(id)),
      'the pages do not overlap', `both pages held ${first.filter(id => second.includes(id)).join(', ')}`);
  check(page1.body?.totalCount === page2.body?.totalCount,
      'totalCount is stable across pages',
      `${page1.body?.totalCount} then ${page2.body?.totalCount}`);

  // A page past the end is empty, not an error.
  const beyond = await call(auth, 'GET', `/search?q=${encodeURIComponent(tag)}&limit=10&offset=1000`);
  checkStatus(beyond, 200, 'a page past the end still answers 200');
  check((beyond.body?.resources ?? []).length === 0, 'and returns no rows',
      `it returned ${(beyond.body?.resources ?? []).length}`);

  // Filtering by type must actually filter.
  const onlyFolders = await call(auth, 'GET', `/search?q=${encodeURIComponent(tag)}&resource_types=folder&limit=10`);
  if (checkStatus(onlyFolders, 200, 'filtering by resource_types returns')) {
    const kinds = new Set((onlyFolders.body?.resources ?? []).map(r => r.resourceType));
    check(!kinds.has('template'), 'a folder-only search returns no templates',
        `it returned ${[...kinds].join(', ')}`);
  }

  // An excessive limit is refused with 400 rather than answering an unbounded page size (a
  // denial-of-service vector) or a server fault. The paging validator caps at the configured maximum.
  const huge = await call(auth, 'GET', `/search?q=${encodeURIComponent(tag)}&limit=100000`);
  check(huge.status === 400,
      'an excessive limit is refused with 400',
      `expected 400, got ${huge.status}: ${(huge.text ?? '').slice(0, 120)}`);

  suite('search: the query modes beyond a term');

  // Search by exact id. This mode is answered from the graph, not the index, so it is immediate.
  const byId = await call(auth, 'GET', `/search?id=${enc(ids[0])}&limit=10`);
  if (checkStatus(byId, 200, 'a search by id returns')) {
    const got = (byId.body?.resources ?? []).map(r => r['@id']);
    check(got.includes(ids[0]) && !got.includes(ids[1]),
        'it returns the named resource and not the others',
        `got ${JSON.stringify(got).slice(0, 160)}`);
  }

  // mode=special-folders — the special-folders view. Empty for an ordinary user on this stack, so the
  // contract asserted is only that it answers 200 and returns folders, not that it is non-empty.
  const special = await call(auth, 'GET', '/search?mode=special-folders&limit=20');
  if (checkStatus(special, 200, 'mode=special-folders returns')) {
    const kinds = new Set((special.body?.resources ?? []).map(r => r.resourceType));
    check(![...kinds].some(k => k && k !== 'folder'), 'and every row it returns is a folder',
        `it returned ${[...kinds].join(', ')}`);
  }

  // Sorting a term search by name. The three probes sort ascending as "<tag> 1..3"; asserted by
  // comparing the returned order to its own sorted copy, so any extra matching rows do not matter.
  const sorted = await call(auth, 'GET', `/search?q=${encodeURIComponent(tag)}&sort=name&limit=20`);
  if (checkStatus(sorted, 200, 'a name-sorted term search returns')) {
    const names = (sorted.body?.resources ?? []).map(r => r['schema:name']).filter(Boolean);
    const asc = [...names].sort((a, b) => a.localeCompare(b));
    check(JSON.stringify(names) === JSON.stringify(asc), 'the results come back in ascending name order',
        `order was ${JSON.stringify(names).slice(0, 200)}`);
  }

  // is_based_on — find instances built on a given template, also graph-backed. Create one instance on
  // the first template, then search for it.
  const instLabel = `${tag} instance`;
  const inst = await call(auth, 'POST', `/template-instances?folder_id=${enc(folderId)}`,
      artifactBody('instance', instLabel, { 'schema:isBasedOn': ids[0] }));
  if (checkStatus(inst, 201, 'an instance on the first template is created')) {
    cleanup('instance', `/template-instances/${enc(inst.body['@id'])}`, instLabel);
    const based = await call(auth, 'GET', `/search?is_based_on=${enc(ids[0])}&limit=20`);
    if (checkStatus(based, 200, 'a search by is_based_on returns')) {
      const got = (based.body?.resources ?? []).map(r => r['@id']);
      check(got.includes(inst.body['@id']), 'it finds the instance built on that template',
          `got ${got.length} row(s), not including the instance`);
    }
  }

  suite('search-deep: the deep variant answers and pages like search');

  // search-deep serves the same index as search — its point is paging past the 10,000-row window — so
  // the three tagged templates are already there. Assert the same shape, that it finds them, that a
  // page reassembles without overlap, and that it shares the paging validator.
  const deep = await call(auth, 'GET', `/search-deep?q=${enc(tag)}&limit=10`);
  if (checkStatus(deep, 200, 'search-deep returns')) {
    check(Array.isArray(deep.body?.resources) && deep.body?.totalCount !== undefined && !!deep.body?.paging,
        'it answers the same resources/totalCount/paging shape as search',
        `body keys were ${Object.keys(deep.body ?? {}).join(', ')}`);
    check((deep.body?.totalCount ?? 0) >= 3, 'it finds the three tagged templates',
        `totalCount was ${deep.body?.totalCount}`);
  }

  const deep1 = await call(auth, 'GET', `/search-deep?q=${enc(tag)}&limit=2&offset=0`);
  const deep2 = await call(auth, 'GET', `/search-deep?q=${enc(tag)}&limit=2&offset=2`);
  if (checkStatus(deep1, 200, 'search-deep first page returns') && checkStatus(deep2, 200, 'search-deep second page returns')) {
    const first = (deep1.body?.resources ?? []).map(r => r['@id']);
    const second = (deep2.body?.resources ?? []).map(r => r['@id']);
    check(first.length === 2, 'a limit of 2 returns 2 rows', `got ${first.length}`);
    check(!first.some(id => second.includes(id)), 'the pages do not overlap',
        `both held ${first.filter(id => second.includes(id)).join(', ')}`);
    check(deep1.body?.totalCount === deep2.body?.totalCount, 'totalCount is stable across pages',
        `${deep1.body?.totalCount} then ${deep2.body?.totalCount}`);
  }

  check((await call(auth, 'GET', `/search-deep?q=${enc(tag)}&limit=100000`)).status === 400,
      'search-deep refuses an excessive limit with 400', 'it did not');
  check((await call(auth, 'GET', `/search-deep?q=${enc(tag)}&limit=0`)).status === 400,
      'and refuses a non-positive limit with 400', 'it did not');

  return { tag };
}
