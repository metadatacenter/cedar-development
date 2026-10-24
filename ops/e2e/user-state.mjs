// What a script of the split tier changes of a test user's own account, and how to put it back.
//
// The sweep deletes the fixtures a killed script made, which it finds in the fixture ledger
// (split-steps.mjs). A change to the account itself, such as an API key added to it, belongs to no
// fixture, so deleting fixtures never undoes it. Before a script makes such a change, it therefore
// notes a restore entry in the ledger that says how to undo it. The script's own cleanup undoes the change through restore() and then notes that it
// has. When the runner kills the script before then, the sweep undoes the change through the same
// restore(), and it leaves alone every entry the script has marked as put back.
//
// A restorer reads the account first and writes only what still differs from the original, so a
// restoration that runs after the script's own, or twice, changes nothing.
import { USER_SERVER, enc } from "./rest/lib.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** How to put back each kind of change, given `call` (the REST helper's), a credential and the entry. */
export const RESTORERS = Object.freeze({
  "workspace-preferences": async (call, auth, entry) => {
    const account = await call(auth, "GET", entry.userPath, undefined, {base: USER_SERVER});
    if (account.status !== 200) return {ok: false, status: account.status, text: account.text};
    if (isDeepStrictEqual(account.body?.uiPreferences?.workspace, entry.preferences)) return {ok: true, changed: 0};
    const written = await call(auth, "PUT", entry.userPath,
      {"uiPreferences.workspace": entry.preferences}, {base: USER_SERVER});
    return written.status === 200 ? {ok: true, changed: 1}
      : {ok: false, status: written.status, text: written.text};
  },
  /**
   * An API key added to an account, identified by the description it was given, which no other run
   * uses. The account had no key with that description before, so putting it back deletes every key
   * with that description and no other key.
   */
  "api-key": async (call, auth, entry) => {
    const account = await call(auth, "GET", entry.userPath, undefined, { base: USER_SERVER });
    if (account.status !== 200) return { ok: false, status: account.status, text: account.text };
    const keys = (account.body?.apiKeys ?? []).filter(key => key.description === entry.description);
    for (const key of keys) {
      const removed = await call(auth, "DELETE", entry.userPath + "/api-keys/" + enc(key.id), undefined,
        { base: USER_SERVER });
      if (removed.status !== 200) return { ok: false, status: removed.status, text: removed.text };
    }
    return { ok: true, changed: keys.length };
  },
});

/** Each visit has its own key: an earlier completed restoration must not hide a later killed visit. */
export function listingPreferencesRestore({as, userPath, preferences}) {
  return {
    restore: "workspace-preferences",
    key: `workspace-preferences ${userPath} ${randomUUID()}`,
    label: `Workspace listing preferences on ${as}'s account`,
    as,
    userPath,
    preferences: structuredClone(preferences),
  };
}

/**
 * The restore entry for an API key a script is about to add to an account. `as` identifies the test
 * user, `user1` or `user2`, and `userPath` is the account's path on the user server.
 */
export function apiKeyRestore({ as, userPath, description }) {
  return {
    restore: "api-key",
    key: `api-key ${userPath} ${description}`,
    label: `API key "${description}" on ${as}'s account`,
    as,
    userPath,
    description,
  };
}

/**
 * Puts back the change a restore entry describes, with `call` and the credential of the user it
 * identifies. Returns `{ok: true, changed}`, where `changed` counts what had to be put back and is 0
 * when the account was already as it was, or `{ok: false, status, text}`.
 */
export async function restore(entry, { call, auth }) {
  const restorer = RESTORERS[entry?.restore];
  if (!restorer) return { ok: false, status: null, text: `no restorer for ${entry?.restore}` };
  return restorer(call, auth, entry);
}
