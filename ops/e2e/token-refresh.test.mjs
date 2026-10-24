import {test} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {observeTokenRefresh} from "./token-refresh.mjs";

function grant(page, {status = 200, grantType = "refresh_token"} = {}) {
  page.emit("response", {
    url: () => "https://auth.example/realms/CEDAR/protocol/openid-connect/token",
    status: () => status,
    request: () => ({method: () => "POST", postData: () => `grant_type=${grantType}&refresh_token=private`}),
  });
}

test("a successful retry without a refresh grant cannot pass the refresh assertion", () => {
  const page = new EventEmitter(), refresh = observeTokenRefresh(page);
  assert.throws(() => refresh.assertRefreshedBeforeRetry(refresh.snapshot()), /successful Keycloak refresh/);
  grant(page, {grantType: "authorization_code"});
  assert.throws(() => refresh.assertRefreshedBeforeRetry(refresh.snapshot()), /successful Keycloak refresh/);
  refresh.stop();
  assert.equal(page.listenerCount("response"), 0);
});

test("a failed, late or duplicated refresh grant cannot pass", () => {
  for (const kind of ["failed", "late", "duplicate"]) {
    const page = new EventEmitter(), refresh = observeTokenRefresh(page);
    const beforeGrant = refresh.snapshot();
    grant(page, {status: kind === "failed" ? 400 : 200});
    const beforeRetry = kind === "late" ? beforeGrant : refresh.snapshot();
    if (kind === "duplicate") grant(page);
    assert.throws(() => refresh.assertRefreshedBeforeRetry(beforeRetry), /refresh grant/);
    refresh.stop();
  }
});

test("exactly one successful refresh before retry passes and retains no credential", () => {
  const page = new EventEmitter(), refresh = observeTokenRefresh(page);
  grant(page);
  const beforeRetry = refresh.snapshot();
  assert.deepEqual(beforeRetry, [200]);
  refresh.assertRefreshedBeforeRetry(beforeRetry);
  refresh.stop();
});
