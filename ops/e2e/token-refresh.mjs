import assert from "node:assert/strict";

/** Observe only refresh grants, without keeping or reporting credentials from the request body. */
export function observeTokenRefresh(page) {
  const statuses = [];
  const response = answer => {
    const request = answer.request();
    if (new URL(answer.url()).pathname.endsWith("/protocol/openid-connect/token") &&
        request.method() === "POST" &&
        new URLSearchParams(request.postData() ?? "").get("grant_type") === "refresh_token")
      statuses.push(answer.status());
  };
  page.on("response", response);
  return {
    snapshot: () => [...statuses],
    assertRefreshedBeforeRetry: beforeRetry => {
      assert.deepEqual(beforeRetry, [200], "The retry must follow one successful Keycloak refresh grant");
      assert.deepEqual(statuses, [200], "The unauthorized request must cause exactly one successful refresh grant");
    },
    stop: () => page.off("response", response),
  };
}
