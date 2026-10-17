// Removes what a process of the split tier created when the runner had to kill it, through REST.
//
// A killed process never reaches its own cleanup, so whatever it made stays behind unless the runner
// removes it. Three things say what that is:
//
//   - the lane's root folder, which holds every fixture its journeys made in the first user's home;
//   - the fixture ledger, in which each process notes the fixtures it creates as the server confirms
//     them, wherever they live;
//   - the second user's home, where a journey names what it makes there after the lane's root.
//
// The root goes first, as one recursive deletion when the server allows it, and otherwise item by
// item, deepest first. Whatever the second user holds under the root's name follows, and then what
// the ledger holds that neither tree did, newest first within each kind. A recorded folder that still
// holds something the ledger never saw goes as a tree. An item the first user may not delete is tried
// as the second, who may own it. A failure is read again at the end, since a tree removed later may
// have taken it. The result says what was removed, what was already gone and what was not.
import { actors, call, enc, mutate, mutateGroup } from "./rest/lib.mjs";

// Instances before the templates they are based on, templates before the elements and fields they
// embed, folders after their contents. Groups stand apart from all of it.
const ORDER = ["template-instances", "templates", "template-elements", "template-fields", "folders", "groups"];
const COLLECTION_OF = {
  folder: "folders", template: "templates", element: "template-elements", field: "template-fields",
  instance: "template-instances",
};
const PAGE = 100;

/** The REST calls the sweep makes, against the live stack. Tests pass stand-ins. */
export const LIVE_REST = {
  users: async () => {
    const { user1, user2 } = await actors();
    return { user1, user2 };
  },
  call,
  remove: (auth, item) => item.base === "group"
    ? mutateGroup(auth, "DELETE", "/groups/" + enc(item.id))
    : mutate(auth, "DELETE", "/" + item.collection + "/" + enc(item.id)),
};

const gone = status => status === 404;
const removedStatus = status => status === 200 || status === 204;
const refused = status => status === 401 || status === 403;
const label = item => `${item.collection}/${item.id}`;

/** What a folder holds, every page of it. */
async function children(rest, user, folderId) {
  const items = [];
  for (let offset = 0; ; offset += PAGE) {
    const listed = await rest.call(user.auth, "GET",
      `/folders/${enc(folderId)}/contents?limit=${PAGE}&offset=${offset}`);
    if (listed.status !== 200) break;
    const resources = listed.body?.resources ?? [];
    for (const node of resources) {
      const collection = COLLECTION_OF[node.resourceType];
      if (collection) items.push({ collection, id: node["@id"], name: node["schema:name"] });
    }
    if (!resources.length || offset + resources.length >= (listed.body?.totalCount ?? 0)) break;
  }
  return items;
}

/** Every item under a folder, with its depth below that folder, the folder itself last. */
async function tree(rest, user, folderId, depth = 0) {
  const items = [];
  for (const item of await children(rest, user, folderId)) {
    if (item.collection === "folders") items.push(...(await tree(rest, user, item.id, depth + 1)));
    else items.push({ ...item, depth: depth + 1 });
  }
  items.push({ collection: "folders", id: folderId, depth });
  return items;
}

const byKindThenDepth = (a, b) =>
  ORDER.indexOf(a.collection) - ORDER.indexOf(b.collection) || (b.depth ?? 0) - (a.depth ?? 0);

/**
 * Removes the fixtures a killed process left. `root` is the lane's root folder, `{id, name}`, when
 * the process was a lane's journey runner. `fixtures` are the ledger's entries for that process.
 */
export async function sweep({ root = null, fixtures = [], rest = LIVE_REST } = {}) {
  const began = Date.now();
  const { user1, user2 } = await rest.users();
  const result = { root: null, removed: [], alreadyGone: [], failed: [], secondUser: [] };
  const settled = new Set();

  async function removeOne(item, first = user1, second = user2) {
    if (settled.has(item.id)) return;
    let response = await rest.remove(first.auth, item);
    let as = first === user1 ? "user1" : "user2";
    if (refused(response.status) && second) {
      response = await rest.remove(second.auth, item);
      as = second === user1 ? "user1" : "user2";
    }
    settled.add(item.id);
    if (removedStatus(response.status)) result.removed.push({ ...pick(item), as });
    else if (gone(response.status)) result.alreadyGone.push(pick(item));
    else result.failed.push({ ...pick(item), status: response.status, text: (response.text ?? "").slice(0, 300) });
  }

  async function removeTree(owner, other, folderId) {
    const check = await rest.call(owner.auth, "GET", `/folders/${enc(folderId)}/deletion`);
    if (gone(check.status)) return { how: "absent" };
    if (check.status === 200 && check.body?.allowed && check.body.token) {
      const done = await rest.call(owner.auth, "POST", `/folders/${enc(folderId)}/deletion`, { token: check.body.token });
      if (done.status === 200 && done.body?.status === "completed") {
        settled.add(folderId);
        return { how: "recursive", deleted: done.body.deleted ?? null };
      }
    }
    // The server refuses a recursive deletion of a tree holding something its owner may not delete,
    // or a template with instances elsewhere, so the tree goes item by item instead.
    const items = (await tree(rest, owner, folderId)).sort(byKindThenDepth);
    const before = result.removed.length;
    for (const item of items) await removeOne(item, owner, other);
    return { how: "item by item", items: items.length, removed: result.removed.length - before };
  }

  if (root?.id) result.root = { id: root.id, name: root.name ?? null, ...(await removeTree(user1, user2, root.id)) };

  // A journey that makes something in the second user's home names it after the lane's root.
  if (root?.name && user2?.profile?.homeFolderId) {
    const prefix = root.name + " ";
    const home = await children(rest, user2, user2.profile.homeFolderId);
    for (const item of home.filter(item => typeof item.name === "string" && item.name.startsWith(prefix))) {
      if (item.collection === "folders") result.secondUser.push({ id: item.id, name: item.name, ...(await removeTree(user2, user1, item.id)) });
      else {
        await removeOne(item, user2, user1);
        result.secondUser.push({ id: item.id, name: item.name, how: "single" });
      }
    }
  }

  // Whatever the ledger holds that neither tree held, newest first within each kind. A folder that
  // still holds something the ledger never saw goes as a tree.
  const recorded = [];
  for (const fixture of fixtures) if (!recorded.some(item => item.id === fixture.id)) recorded.push(fixture);
  const newestFirst = [...recorded].reverse().map((item, index) => ({ ...item, index }));
  newestFirst.sort((a, b) => ORDER.indexOf(a.collection) - ORDER.indexOf(b.collection) || a.index - b.index);
  for (const item of newestFirst) {
    await removeOne(item);
    const index = result.failed.findIndex(entry => entry.id === item.id);
    if (item.collection !== "folders" || index < 0) continue;
    result.failed.splice(index, 1);
    settled.delete(item.id);
    // Item by item, removeTree settles the folder itself.
    const outcome = await removeTree(user1, user2, item.id);
    if (outcome.how === "recursive") result.removed.push({ ...pick(item), as: "user1", deleted: outcome.deleted });
    else if (outcome.how === "absent") result.alreadyGone.push(pick(item));
  }

  // An item that failed early may have gone with a tree removed later, so each failure is read again.
  for (const failure of [...result.failed]) {
    if (failure.base === "group") continue;
    const path = "/" + failure.collection + "/" + enc(failure.id);
    const reads = [await rest.call(user1.auth, "GET", path), ...(user2 ? [await rest.call(user2.auth, "GET", path)] : [])];
    if (reads.every(read => gone(read.status))) {
      result.failed.splice(result.failed.indexOf(failure), 1);
      result.alreadyGone.push(pick(failure));
    }
  }
  result.seconds = Math.round((Date.now() - began) / 100) / 10;
  return result;
}

function pick(item) {
  return { collection: item.collection, id: item.id, ...(item.base ? { base: item.base } : {}) };
}

/** One line for the runner's console. */
export function summarize(result) {
  if (!result) return "no sweep";
  if (result.error) return "sweep failed: " + result.error;
  const parts = [];
  if (result.root) {
    const root = result.root;
    parts.push(root.how === "recursive"
      ? `root removed with ${Object.entries(root.deleted ?? {}).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}`).join(", ") || "nothing in it"}`
      : root.how === "absent" ? "root already gone" : `root removed item by item (${root.removed} of ${root.items})`);
  }
  parts.push(`${result.removed.length} removed, ${result.alreadyGone.length} already gone, ${result.failed.length} not removed`);
  if (result.secondUser.length) parts.push(`${result.secondUser.length} of the second user's`);
  return parts.join("; ");
}
