// Search and its variants, including the paging parameters that thirty-one endpoints declare and
// almost nothing exercises.
import { suite, check, checkStatus, call, cleanup, artifactBody, note, enc, RUN } from '../lib.mjs';

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

  return { tag };
}
