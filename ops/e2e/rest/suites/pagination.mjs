// Paging, across the listings that offer it. Thirty-one endpoints declare limit and offset; almost
// nothing exercises them, and a paging bug is the kind that hides — an off-by-one drops or repeats one
// row per page, invisible until someone notices a record that will not show up anywhere.
//
// Two listings are covered directly: a folder's contents, which nothing else touches, and search,
// which the search suite reaches for propagation but not for the shape of a page. The invalid-argument
// behaviour is crossed over both, because they share the validator that is supposed to reject a bad
// limit and today does not.
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN } from '../lib.mjs';

export const name = 'pagination';

const PAGE_TAG = `Paging${RUN.replace(/[^0-9]/g, '')}`;
const N = 5;

export async function run({ user1, folderId }) {
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
  ];
  const endpoints = [
    { name: 'folder contents', path: contents },
    { name: 'search', path: `/search?q=${enc(PAGE_TAG)}` },
  ];
  for (const endpoint of endpoints) {
    const sep = endpoint.path.includes('?') ? '&' : '?';
    for (const bad of badArgs) {
      const res = await call(auth, 'GET', `${endpoint.path}${sep}${bad.qs}`);
      check(res.status === 400,
          `${endpoint.name} with ${bad.what} is refused with 400`,
          `expected 400, got ${res.status}: ${(res.text ?? '').slice(0, 120)}`);
    }
    // A non-numeric limit is rejected by Jersey's parameter conversion before the request reaches the
    // application, so it surfaces as the framework's own 404 rather than the validator's 400. The
    // point of the fix is that it is no longer a 500 server fault; it is a client error either way.
    const nonNumeric = await call(auth, 'GET', `${endpoint.path}${sep}limit=abc`);
    check(nonNumeric.status >= 400 && nonNumeric.status < 500,
        `${endpoint.name} with a non-numeric limit is a client error, not a server fault`,
        `expected 4xx, got ${nonNumeric.status}`);
  }

  return {};
}
