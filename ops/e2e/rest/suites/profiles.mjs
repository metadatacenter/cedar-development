// A user's own profile on the user server: the preferences the user may change, and the summary
// only the user may read. The profile is keyed by the identifier in the token's subject.
//
// A preference is changed and then put back, so the first test user's profile ends as it began.
import { isDeepStrictEqual } from 'node:util';
import { suite, check, checkStatus, call, enc, USER_SERVER } from '../lib.mjs';

export const name = 'profiles';

const subjectOf = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub;

export async function run({ user1, user2 }) {
  const id = subjectOf(user1.auth);
  const at = `/users/${enc(id)}`;
  const onUserServer = { base: USER_SERVER };
  const profile = async () => (await call(user1.auth, 'GET', at, undefined, onUserServer)).body;
  const opened = body => body?.uiPreferences?.infoPanel?.opened;

  suite('profiles: a user reads their own summary, and no one else does');

  const summary = await call(user1.auth, 'GET', `${at}/summary`, undefined, onUserServer);
  if (checkStatus(summary, 200, 'a user reads their own summary')) {
    check(JSON.stringify(summary.body ?? {}).includes(id), 'and it names that user',
        `the summary was ${(summary.text ?? '').slice(0, 200)}`);
  }
  checkStatus(await call(user2.auth, 'GET', `${at}/summary`, undefined, onUserServer), 403,
      'another user cannot read it');

  suite('profiles: a user changes their own preferences, and no one else does');

  const before = await profile();
  const original = opened(before);
  if (!check(typeof original === 'boolean', 'the profile carries the preference the suite changes',
      `uiPreferences.infoPanel.opened was ${JSON.stringify(original)}`)) return {};

  checkStatus(await call(user2.auth, 'PATCH', at, { 'uiPreferences.infoPanel.opened': !original }, onUserServer), 403,
      'another user cannot change it');
  checkStatus(await call(user1.auth, 'PATCH', at, { homeFolderId: 'https://repo.example/folders/elsewhere' },
      onUserServer), 400, 'the user cannot write a field outside the preferences');
  check(isDeepStrictEqual(await profile(), before), 'and neither refusal changed the stored profile',
      'the profile changed');

  if (checkStatus(await call(user1.auth, 'PATCH', at, { 'uiPreferences.infoPanel.opened': !original }, onUserServer),
      200, 'the user changes the preference')) {
    check(opened(await profile()) === !original, 'and the stored profile holds the change',
        `uiPreferences.infoPanel.opened is ${JSON.stringify(opened(await profile()))}`);
  }
  checkStatus(await call(user1.auth, 'PATCH', at, { 'uiPreferences.infoPanel.opened': original }, onUserServer), 200,
      'the user puts it back');
  check(opened(await profile()) === original, 'and the stored profile holds the original value again',
      `uiPreferences.infoPanel.opened is ${JSON.stringify(opened(await profile()))}`);
  return {};
}
