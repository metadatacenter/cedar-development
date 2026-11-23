import test from 'node:test';
import assert from 'node:assert/strict';
import { envelopeProblems } from './paging-envelope.mjs';

const at = '/folders/f/contents';
const page = () => ({
  totalCount: 5, request: { limit: 2, offset: 2 }, currentOffset: 2,
  paging: { first: `${at}?limit=2&offset=0`, prev: `${at}?limit=2&offset=0`, next: `${at}?limit=2&offset=4`,
    last: `${at}?limit=2&offset=4` },
});
const sent = { limit: 2, offset: 2, links: true };

test('a page in the middle that states its window and links raises nothing', () => {
  assert.deepEqual(envelopeProblems(page(), sent), []);
});

test('each part of the envelope a page lacks is named', () => {
  const cases = [
    [body => { delete body.request; }, /request was undefined/],
    [body => { body.request.offset = 0; }, /not the limit 2 and offset 2 sent/],
    [body => { body.totalCount = '5'; }, /totalCount was "5"/],
    [body => { body.currentOffset = 0; }, /currentOffset was 0, not the offset 2 sent/],
    [body => { delete body.paging; }, /paging was undefined/],
    [body => { delete body.paging.prev; }, /the prev link was undefined/],
    [body => { body.paging.next = `${at}?limit=25&offset=4`; }, /the next link/],
    [body => { delete body.paging.last; }, /the last link was undefined/],
  ];
  for (const [change, expected] of cases) {
    const body = page();
    change(body);
    const found = envelopeProblems(body, sent);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0], expected);
  }
});

test('the first page needs no prev link, and the last page no next link', () => {
  const first = { ...page(), request: { limit: 2, offset: 0 }, currentOffset: 0 };
  delete first.paging.prev;
  assert.deepEqual(envelopeProblems(first, { ...sent, offset: 0 }), []);
  const last = { ...page(), request: { limit: 2, offset: 4 }, currentOffset: 4 };
  delete last.paging.next;
  assert.deepEqual(envelopeProblems(last, { ...sent, offset: 4 }), []);
});

test('a capped count carries no last link', () => {
  const capped = { ...page(), countCapped: true };
  assert.deepEqual(envelopeProblems(capped, sent), ['a capped count carries a last link']);
  delete capped.paging.last;
  assert.deepEqual(envelopeProblems(capped, sent), []);
});

test('a POST answer needs no links', () => {
  const posted = page();
  delete posted.paging;
  assert.deepEqual(envelopeProblems(posted, { ...sent, links: false }), []);
});
