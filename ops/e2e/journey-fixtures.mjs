import assert from "node:assert/strict";
import {call} from "./rest/lib.mjs";

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
