import assert from "node:assert/strict";
import {call, enc, USER_SERVER} from "./rest/lib.mjs";
import {noteFixture, noteRestore, noteRestored} from "./split-steps.mjs";
import {listingPreferencesRestore, restore} from "./user-state.mjs";

// Listing and drag/drop scenarios must not depend on how many fixtures earlier journeys kept.
export async function journeyFolder({user, folderId, name, created}, suffix) {
  const result = await call(user.auth, "POST", "/folders", {
    folderId, name: name + " " + suffix, description: "Isolated temporary journey fixtures",
  });
  assert.equal(result.status, 201, result.text);
  const id = result.body["@id"];
  created.push({collection: "folders", id});
  return id;
}

// A journey asserts what a page shows, and above all what it does not show, only once the page has
// settled: the answer it was waiting for has arrived and been rendered. A helper that waits for such
// a state fails with a message that says what it waited for.

/**
 * A Workspace dashboard address that names the default sort and list view. An address naming no listing
 * preference opens with the filters, sort and view the user's profile keeps, which every journey
 * that chooses one rewrites, and every lane signs in as the same users. Naming the preferences keeps
 * another lane's choices out of the listing without writing the account's preferences during setup.
 */
export const dashboardAddress = (base, parameters = {}) =>
  base + "/dashboard?" + new URLSearchParams({...parameters, sort: "name", view: "list"});

/**
 * Runs a journey that chooses listing preferences in Workspace, and puts back the ones the user's
 * profile kept before it, so the account leaves the journey as it entered it.
 */
export async function keepingListingPreferences(user, journey, {as = "user1"} = {}) {
  const path = "/users/" + enc(user.profile["@id"].split("/").at(-1));
  const read = await call(user.auth, "GET", path, undefined, {base: USER_SERVER});
  assert.equal(read.status, 200, read.text);
  const entry = listingPreferencesRestore({as, userPath: path, preferences: read.body.uiPreferences.workspace});
  noteRestore(entry);
  let failure;
  try {
    return await journey();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      const restored = await restore(entry, {call, auth: user.auth});
      assert.ok(restored.ok, `Workspace preference cleanup failed (${restored.status}): ${restored.text}`);
      noteRestored(entry);
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], `${failure.message}; ${error.message}`);
      throw error;
    }
  }
}

/** Whether a response answers Workspace's listing of a folder. The graph serves it, so it reflects a write at once. */
export const listingOf = folderId => response => {
  const url = new URL(response.url());
  return response.request().method() === "GET" && url.pathname.endsWith("/contents") &&
    decodeURIComponent(url.pathname).includes(folderId.split("/").at(-1));
};

/** Waits until Workspace's listing table reports that it is no longer loading or moving anything. */
export const listingIdle = page =>
  page.waitForFunction(() => document.querySelector(".table-scroll")?.getAttribute("aria-busy") === "false");

/** Selects list view for fixture setup through the address, without saving account preferences. */
export async function listView(page) {
  await page.getByRole("button", {name: "New", exact: true}).waitFor();
  const list = page.getByRole("button", {name: "List view", exact: true});
  if (await list.getAttribute("aria-pressed") !== "true") {
    const address = new URL(page.url());
    address.searchParams.set("view", "list");
    await page.goto(address.href);
  }
  await page.getByRole("button", {name: "List view", exact: true, pressed: true}).waitFor();
  await listingIdle(page);
}

/**
 * Opens a folder in Workspace's list view. The listing is settled once the request this navigation
 * made has been answered, the list view is the one shown, and the table no longer reports itself
 * busy. Setup names the view in the address rather than saving a view choice on the account.
 */
export async function openListing(page, base, folderId) {
  await Promise.all([
    page.waitForResponse(listingOf(folderId)),
    page.goto(dashboardAddress(base, {folderId})),
  ]);
  await listView(page);
}

/**
 * Opens a folder's listing until it shows a row, and returns the row. Each attempt reads a settled
 * listing. After the last one the wait fails, naming the row it expected.
 */
export async function listedIn(page, base, folderId, row, what, attempts = 16) {
  for (let attempt = 1; ; attempt++) {
    await openListing(page, base, folderId);
    if (await row.count()) return row;
    assert.ok(attempt < attempts, `${what} is not listed in ${attempt} settled listings`);
  }
}

/** Waits until a control holds the focus of its own document or shadow root. */
export async function focused(locator, failure) {
  const control = await locator.elementHandle();
  await locator.page().waitForFunction(element => element.getRootNode().activeElement === element, control)
    .catch(error => { throw new Error(`${failure}: ${error.message}`); });
}

/**
 * Resolves once the page has rendered two more frames. Workspace runs Angular without zone.js, which
 * renders a change no later than the next animation frame. A gesture the page refuses changes nothing
 * that could be waited for. After this point the page shows whatever the gesture started, so an
 * assertion that it started nothing means something.
 */
export const rendered = page =>
  page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const COLLECTIONS = new Set(["folders", "templates", "template-elements", "template-fields", "template-instances"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The collection a full identity belongs to, when it is one of the five that cleanup removes. */
function collectionOf(id) {
  try {
    const collection = new URL(id).pathname.split("/").at(-2);
    return COLLECTIONS.has(collection) ? collection : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fixture a create-by-PUT address identifies. The address carries the full identity, the
 * collection and UUID, or the UUID alone. The server mints identities on repo.<host> and serves
 * them from resource.<host>, so a short form is completed from the address's own host. Fixtures
 * are always recorded under the full identity, which is the form replies and journeys compare.
 */
export function fixtureAt(url) {
  const address = new URL(url);
  const parts = address.pathname.split("/").slice(1);
  if (parts.length !== 2 || !COLLECTIONS.has(parts[0]) || !parts[1]) return undefined;
  const [collection, selector] = [parts[0], decodeURIComponent(parts[1])];
  if (collectionOf(selector) === collection) return {collection, id: selector};
  const local = selector.startsWith(collection + "/") ? selector.slice(collection.length + 1) : selector;
  if (!UUID.test(local) || !address.hostname.startsWith("resource.")) return undefined;
  return {collection, id: `https://repo.${address.hostname.slice("resource.".length)}/${collection}/${local}`};
}

/**
 * The fixture a browser write created, if it created one. A POST names what it created in its
 * reply. A PUT answered 201 created the identity its address names, so the address identifies the
 * fixture even when the page never reads the reply. An address on a host other than resource.<host>
 * cannot complete a short form, and the reply's identity is used instead. Cleanup accepts 404, so an
 * identity that was recorded but never committed costs nothing.
 */
export function createdFixture(method, url, status, body) {
  const collection = typeof body?.["@id"] === "string" ? collectionOf(body["@id"]) : undefined;
  const named = collection ? {collection, id: body["@id"]} : undefined;
  if (method === "PUT") return status === 201 ? fixtureAt(url) ?? named : undefined;
  return method === "POST" && status >= 200 && status <= 299 ? named : undefined;
}

/** Whether a request is a create attempt: an unconditional PUT to an identity in one of the five collections. */
export function createAttempt(request) {
  return request.method() === "PUT" && !request.headers()["if-match"] && !!fixtureAt(request.url());
}

/**
 * Adds a fixture to a runner's cleanup list once, however many writes name it, and notes it in the
 * split tier's fixture ledger when a runner keeps one.
 */
export function recordFixture(created, fixture) {
  if (fixture && !created.some(item => item.id === fixture.id)) {
    created.push(fixture);
    noteFixture(fixture);
  }
}

/**
 * Adds what a browser write created to a runner's cleanup list. A successful POST whose reply names
 * an identity must name one in a collection cleanup removes, or the fixture would leak unnoticed.
 */
export function recordCreate(created, method, url, status, body) {
  const fixture = createdFixture(method, url, status, body);
  if (method === "POST" && status >= 200 && status < 300 && body?.["@id"])
    assert.ok(fixture, `${method} ${url} named ${body["@id"]}, outside the collections cleanup removes`);
  recordFixture(created, fixture);
}

/**
 * Passes every POST and PUT that a context's pages send to a folder, an artifact or a command through
 * the runner, which records each create in its cleanup list even when the page never reads the reply.
 * A create whose reply never arrived may still have committed, and its address names the identity,
 * so cleanup can remove it or find it absent. Each reply's body is kept in `bodies` under its method
 * and address, for failure messages. Routes a page installs itself run first.
 */
export async function captureCreates(context, created, bodies = new Map()) {
  await context.route("**/*", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!["POST", "PUT"].includes(request.method()) ||
        !/^\/(folders|templates|template-elements|template-fields|template-instances|command\/)/.test(path) ||
        path.endsWith("/download"))
      return route.continue();
    let response;
    try {
      response = await route.fetch();
    } catch (error) {
      if (createAttempt(request)) recordFixture(created, fixtureAt(request.url()));
      throw error;
    }
    let body;
    try {
      body = await response.json();
    } catch {}
    bodies.set(request.method() + " " + request.url(), body);
    recordCreate(created, request.method(), request.url(), response.status(), body);
    await route.fulfill({ response });
  });
  return bodies;
}
