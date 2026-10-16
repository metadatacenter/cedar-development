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
