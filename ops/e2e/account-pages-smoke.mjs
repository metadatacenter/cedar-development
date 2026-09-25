// Modern account pages; fixtures are isolated and removed, secrets are never logged.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  actors,
  call,
  USER_SERVER,
  GROUP_SERVER,
  mutateGroup,
  enc,
} from "./rest/lib.mjs";
const area = process.argv[2] || "profile";
assert.ok(
  ["profile", "settings", "groups", "privacy"].includes(area),
  "Unknown account page",
);
const base = process.env.CEDAR_BASE || "https://workspace.metadatacenter.orgx";
const { user1, user2 } = await actors();
const userId = JSON.parse(
  Buffer.from(user1.auth.split(".")[1], "base64url").toString(),
).sub;
const userPath = "/users/" + enc(userId);
let originalDate;
let groupId;
const fixture = "Workspace account smoke " + Date.now();
const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.setDefaultTimeout(25000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
async function open(route) {
  await page.goto(base + route);
  await page
    .locator(
      "#username, cedar-account-shell .account-card, cedar-account-shell [role=alert], #groups-page .groups-card",
    )
    .first()
    .waitFor();
  if (await page.locator("#username").isVisible()) {
    await page
      .locator("#username")
      .fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || "test1@test.com");
    await page
      .locator("#password")
      .fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || "test1");
    await page.locator("#kc-login").click();
  }
  await page
    .getByRole("heading", {
      name: route.slice(1)[0].toUpperCase() + route.slice(2),
      exact: true,
    })
    .waitFor();
  assert.equal(await page.evaluate(() => typeof window.angular), "undefined");
}
async function mutation(method, path, action, status) {
  const pending = page.waitForResponse(
    (r) =>
      r.request().method() === method &&
      new URL(r.url()).pathname.includes(path),
  );
  await action();
  // Destructive actions ask first in Workspace's own confirmation dialog; accept it when it appears.
  const confirmation = page.locator("dialog.confirmation-dialog");
  const first = await Promise.race([
    pending.then(() => "response"),
    confirmation
      .waitFor()
      .then(() => "confirmation")
      .catch(() => "none"),
  ]);
  if (first === "confirmation")
    await confirmation.getByRole("button", { name: "OK", exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), status);
  return response;
}
try {
  if (area === "profile") {
    await open("/profile");
    await page.getByRole("heading", { name: /API Keys/ }).waitFor();
    await page.getByLabel("New key description (optional)").fill(fixture);
    await mutation(
      "POST",
      "/api-keys",
      () => page.getByRole("button", { name: "New key", exact: true }).click(),
      201,
    );
    const key = () => page.getByRole("article", { name: fixture, exact: true });
    await key().waitFor();
    assert.match(await key().locator("code").innerText(), /^•+$/);
    await key().getByRole("button", { name: "Reveal", exact: true }).click();
    await key().getByRole("button", { name: "Hide", exact: true }).waitFor();
    assert.ok(!(await key().locator("code").innerText()).includes("•"));
    await key().getByRole("button", { name: "Hide", exact: true }).click();
    await mutation(
      "POST",
      "/regenerate",
      () =>
        key().getByRole("button", { name: "Regenerate", exact: true }).click(),
      200,
    );
    await page
      .getByRole("status")
      .filter({ hasText: "API key regenerated." })
      .waitFor();
    await mutation(
      "DELETE",
      "/api-keys/",
      () => key().getByRole("button", { name: "Delete", exact: true }).click(),
      200,
    );
    await key().waitFor({ state: "detached" });
    await page.getByRole("link", { name: "Workspace", exact: true }).click();
    await page.locator("cedar-workspace-page").waitFor();
    console.log(
      "PASS: Profile is Angular-only; account, key create/reveal/hide/regenerate/delete, and Workspace return",
    );
  }
  if (area === "settings") {
    const original = await call(user1.auth, "GET", userPath, undefined, {
      base: USER_SERVER,
    });
    assert.equal(original.status, 200);
    originalDate =
      original.body.uiPreferences?.preferredDateFormat || "MM/DD/YYYY";
    const next = originalDate === "YYYY-MM-DD" ? "DD/MM/YYYY" : "YYYY-MM-DD";
    await open("/settings");
    await mutation(
      "PUT",
      "/users/",
      () => page.getByLabel("Date format", { exact: true }).selectOption(next),
      200,
    );
    await page
      .getByRole("status")
      .filter({ hasText: "Date format saved." })
      .waitFor();
    await page.reload();
    await page.locator(".account-card").first().waitFor();
    assert.equal(
      await page.getByLabel("Date format", { exact: true }).inputValue(),
      next,
    );
    console.log(
      "PASS: Settings is Angular-only; date format saves and survives reload",
    );
  }
  if (area === "groups") {
    await open("/groups");
    await page.getByRole("tab", { name: "Create group", exact: true }).click();
    await page.getByLabel("Group name", { exact: true }).fill(fixture);
    const created = await mutation(
      "POST",
      "/groups",
      () =>
        page.getByRole("button", { name: "Create group", exact: true }).click(),
      201,
    );
    groupId = (await created.json())["@id"];
    const path = "/groups/" + enc(groupId);
    await page.getByRole("button", { name: "Save", exact: true }).waitFor();
    const me = page.getByRole("listitem", {
      name: [user1.profile.firstName, user1.profile.lastName]
        .filter(Boolean)
        .join(" "),
      exact: true,
    });
    assert.equal(await me.getByRole("checkbox").isDisabled(), true);
    assert.equal(
      await me
        .getByRole("button", { name: /^Remove .* from the group$/ })
        .isDisabled(),
      true,
    );
    await page
      .getByLabel("Description", { exact: true })
      .fill("Smoke description");
    await mutation(
      "PUT",
      path,
      () => page.getByRole("button", { name: "Save", exact: true }).click(),
      200,
    );
    await page
      .getByRole("combobox", { name: "Add a member", exact: true })
      .fill(
        [user2.profile.firstName, user2.profile.lastName]
          .filter(Boolean)
          .join(" "),
      );
    await page
      .getByRole("option", {
        name: [user2.profile.firstName, user2.profile.lastName]
          .filter(Boolean)
          .join(" "),
        exact: true,
      })
      .click();
    await mutation(
      "PUT",
      path + "/users",
      () =>
        page.getByRole("button", { name: "Add member", exact: true }).click(),
      200,
    );
    const other = page.getByRole("listitem", {
      name: [user2.profile.firstName, user2.profile.lastName]
        .filter(Boolean)
        .join(" "),
      exact: true,
    });
    await other.waitFor();
    const viewer = await browser.newContext({ ignoreHTTPSErrors: true });
    const vp = await viewer.newPage();
    await vp.goto(base + "/groups");
    await vp.locator("#username").waitFor();
    await vp
      .locator("#username")
      .fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN || "test2@test.com");
    await vp
      .locator("#password")
      .fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD || "test2");
    await vp.locator("#kc-login").click();
    await vp.getByRole("combobox", { name: "Find a group" }).fill(fixture);
    await vp
      .getByRole("option", {
        name: fixture + " - Smoke description",
        exact: true,
      })
      .click();
    await vp
      .getByText("Only a Group Administrator can see who is in this group.")
      .waitFor();
    assert.equal(
      await vp.getByRole("button", { name: "Save", exact: true }).count(),
      0,
    );
    assert.equal(await vp.evaluate(() => typeof window.angular), "undefined");
    await viewer.close();
    await mutation(
      "PUT",
      path + "/users",
      () => other.getByRole("checkbox").click(),
      200,
    );
    await page.waitForFunction(() => {
      return (
        document.querySelectorAll(".groups-member-row input:checked").length ===
        2
      );
    });
    await mutation(
      "PUT",
      path + "/users",
      () => other.getByRole("checkbox").click(),
      200,
    );
    await page.waitForFunction(() => {
      return (
        document.querySelectorAll(".groups-member-row input:checked").length ===
        1
      );
    });
    await mutation(
      "PUT",
      path + "/users",
      () =>
        other
          .getByRole("button", { name: /^Remove .* from the group$/ })
          .click(),
      200,
    );
    await other.waitFor({ state: "detached" });
    const external = await mutateGroup(user1.auth, "PUT", path, {
      "schema:name": fixture,
      "schema:description": "Concurrent update",
    });
    assert.equal(external.status, 200);
    await page
      .getByLabel("Description", { exact: true })
      .fill("Local edit retained");
    await mutation(
      "PUT",
      path,
      () => page.getByRole("button", { name: "Save", exact: true }).click(),
      412,
    );
    await page
      .getByRole("alert")
      .filter({ hasText: "changed since" })
      .waitFor();
    assert.equal(
      await page.getByLabel("Description", { exact: true }).inputValue(),
      "Local edit retained",
    );
    await page
      .getByRole("button", { name: "Reload group", exact: true })
      .click();
    await page.getByRole("button", { name: "Save", exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector("#group-description")?.value ===
        "Concurrent update",
    );
    await page.screenshot({
      path: "/tmp/cedar-modern-groups.png",
      fullPage: true,
    });
    await mutation(
      "DELETE",
      path,
      () =>
        page.getByRole("button", { name: "Delete group", exact: true }).click(),
      204,
    );
    groupId = undefined;
    await page
      .getByRole("status")
      .filter({ hasText: "Group deleted." })
      .waitFor();
    console.log(
      "PASS: Groups is Angular-only; CRUD, membership, administrator changes, restricted viewer, last administrator, and stale-write conflict",
    );
  }
  if (area === "privacy") {
    await open("/privacy");
    for (const name of [
      "Privacy Policy",
      "Information Collected",
      "Information Use",
      "Information Sharing",
      "Data Security",
    ])
      await page.getByRole("heading", { name, exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      "Privacy overflows on mobile",
    );
    await page.screenshot({
      path: "/tmp/cedar-modern-privacy-mobile.png",
      fullPage: true,
    });
    // The account pages are standalone: each is reached by its own route, with no shared navigation.
    for (const route of ["/profile", "/settings", "/groups", "/privacy"]) {
      await open(route);
      assert.equal(
        await page.getByRole("navigation", { name: "Account pages" }).count(),
        0,
      );
    }
    await page.getByRole("link", { name: "Workspace", exact: true }).click();
    await page.locator("cedar-workspace-page").waitFor();
    console.log(
      "PASS: Privacy policy, responsive layout, and all four standalone Angular-only routes",
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(
    "Account alerts:",
    await page.getByRole("alert").allTextContents(),
  );
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
  if (groupId) {
    const removed = await mutateGroup(
      user1.auth,
      "DELETE",
      "/groups/" + enc(groupId),
    );
    assert.ok(
      [204, 404].includes(removed.status),
      "Temporary group cleanup failed",
    );
  }
  if (originalDate !== undefined) {
    const restored = await call(
      user1.auth,
      "PUT",
      userPath,
      { "uiPreferences.preferredDateFormat": originalDate },
      { base: USER_SERVER },
    );
    assert.equal(restored.status, 200, "Date preference restore failed");
  }
  const current = await call(user1.auth, "GET", userPath, undefined, {
    base: USER_SERVER,
  });
  assert.equal(current.status, 200);
  for (const key of current.body.apiKeys || []) {
    if (key.description === fixture) {
      const result = await call(
        user1.auth,
        "DELETE",
        userPath + "/api-keys/" + enc(key.id),
        undefined,
        { base: USER_SERVER },
      );
      assert.equal(result.status, 200, "Temporary key cleanup failed");
    }
  }
}
