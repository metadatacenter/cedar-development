// Messages between users on the messaging server: sending one, and the changes only its recipient
// may make to it. Paging through the list is the pagination suite's.
//
// The messaging server has no route that deletes a message, so each run leaves the message it sends
// in the second test user's list, read. Its subject carries the run's stamp.
import { suite, check, checkStatus, call, enc, RUN, MESSAGING } from '../lib.mjs';

export const name = 'messaging';

export async function run({ user1, user2 }) {
  const onMessaging = { base: MESSAGING };
  const asPatch = { base: MESSAGING, contentType: 'application/merge-patch+json' };
  const subject = `REST message ${RUN}`;
  const to = { '@id': user2.profile['@id'], recipientType: 'user' };
  const listed = async auth => {
    const res = await call(auth, 'GET', '/messages?limit=500', undefined, onMessaging);
    return res.status === 200 ? (res.body?.messages ?? []).filter(m => m.subject === subject) : undefined;
  };

  suite('messaging: a user sends another a message');

  checkStatus(await call(user1.auth, 'POST', '/messages',
      { to, subject, from: { processId: 'submission.NCBI', senderType: 'process' }, body: 'not sent' },
      onMessaging), 403, 'an ordinary user cannot send on behalf of a process');
  const sent = await call(user1.auth, 'POST', '/messages', { to, subject, body: 'Sent by the REST suites' }, onMessaging);
  if (!checkStatus(sent, [200, 201], 'a user can send another user a message')) return {};

  const received = await listed(user2.auth);
  const message = received?.[0];
  if (!check(received?.length === 1 && message.readStatus === 'unread' && message.notificationStatus === 'notnotified',
      'the recipient holds it once, unread and not yet notified', `the recipient's list held ${JSON.stringify(received)}`)) {
    return {};
  }
  const own = await listed(user1.auth);
  check(Array.isArray(own) && own.length === 0, 'and it is not in the sender\'s own messages',
      `the sender's list held ${JSON.stringify(own)}`);

  suite('messaging: only the recipient changes a message');

  const at = `/messages/${enc(message.id)}`;
  checkStatus(await call(user1.auth, 'PATCH', at, { notificationStatus: 'notified' }, asPatch), [403, 404],
      'the sender cannot change the recipient\'s message');
  check((await listed(user2.auth))?.[0]?.notificationStatus === 'notnotified', 'and the refusal changed nothing',
      'the message was marked notified');
  checkStatus(await call(user2.auth, 'PATCH', at, { readStatus: 'read' }, asPatch), 400,
      'the recipient cannot change anything but the notification state');
  if (checkStatus(await call(user2.auth, 'PATCH', at, { notificationStatus: 'notified' }, asPatch), 200,
      'the recipient marks it notified')) {
    check((await listed(user2.auth))?.[0]?.notificationStatus === 'notified', 'and the change is stored',
        'the message is not marked notified');
  }

  const marked = await call(user2.auth, 'POST', '/command/mark-all-as-read', undefined, onMessaging);
  if (checkStatus(marked, 200, 'the recipient marks every message read')) {
    check(Number.isInteger(marked.body?.updated) && marked.body.updated >= 1, 'and the count includes this one',
        `updated was ${JSON.stringify(marked.body?.updated)}`);
    check((await listed(user2.auth))?.[0]?.readStatus === 'read', 'and the message now reads as read',
        'the message is still unread');
  }
  return {};
}
