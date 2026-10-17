// Modern account pages; fixtures are isolated and removed, secrets are never logged.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  actors,
  call,
  GROUP_SERVER,
  mutateGroup,
  enc,
} from "./rest/lib.mjs";
import { evidencePath, noteFixture, noteRestore, noteRestored } from "./split-steps.mjs";
import { apiKeyRestore, restore } from "./user-state.mjs";
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
let groupId;
// The API key the profile area adds belongs to the account rather than to any fixture.
let keyRestore;
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
    await confirmation.getByRole("button", { name: "Yes", exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), status);
  return response;
}
try {
  if (area === "profile") {
    await open("/profile");
    await page.getByRole("heading", { name: /API Keys/ }).waitFor();
    await page.getByLabel("New key description (optional)").fill(fixture);
    // Should the split tier kill this process, its sweep removes the key through this entry.
    keyRestore = apiKeyRestore({ as: "user1", userPath, description: fixture });
    noteRestore(keyRestore);
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
    await page.getByRole("link", { name: "Back to Workspace", exact: true }).click();
    await page.locator("cedar-workspace-page").waitFor();
    console.log(
      "PASS: Profile is Angular-only; account, key create/reveal/hide/regenerate/delete, and Workspace return",
    );
  }
  if (area === "settings") {
    // Settings holds no preference since the date format left it. It reports what CEDAR is
    // running, so it must name a real CEDAR and CEE version and write nothing, loaded or reloaded.
    await open("/settings");
    // Keycloak's token exchange posts on every load; it is sign-in, not a write to CEDAR.
    const writes = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !path.startsWith("/realms/"))
        writes.push(`${request.method()} ${path}`);
    });
    const versions = async () => {
      const about = page.locator(".account-card").filter({
        has: page.getByRole("heading", { name: "About CEDAR", exact: true }),
      });
      const fact = (term) =>
        about
          .locator("dt")
          .filter({ hasText: new RegExp(`^${term}$`) })
          .locator("xpath=following-sibling::dd[1]");
      const release = /^\d+\.\d+\.\d+/;
      await fact("CEDAR version").filter({ hasText: release }).waitFor();
      // The CEE version reads "Loading…" until the editor has loaded, and "Unavailable" if it fails.
      await fact("CEE version").filter({ hasText: release }).waitFor();
      assert.equal(await page.getByLabel("Date format").count(), 0);
    };
    await versions();
    await page.reload();
    await versions();
    assert.deepEqual(writes, [], "Settings sent a write");
    console.log(
      "PASS: Settings is Angular-only; it names the CEDAR and CEE versions and writes nothing",
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
    noteFixture({ collection: "groups", id: groupId, base: "group" });
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
    const selectAsViewer = async (member) => {
      const ownStatus = await call(user2.auth, "GET", path + "/membership/me", undefined, { base: GROUP_SERVER });
      assert.equal(ownStatus.status, 200);
      assert.deepEqual(ownStatus.body, { member, administrator: false });
      assert.equal(ownStatus.headers.get("cache-control"), "private, no-store");
      assert.equal(ownStatus.headers.get("etag"), null);
      const roster = await call(user2.auth, "GET", path + "/users", undefined, { base: GROUP_SERVER });
      assert.equal(roster.status, 403);
      await vp.getByRole("combobox", { name: "Find a group" }).fill(fixture);
      await vp.getByRole("option", { name: fixture + " - Smoke description", exact: true }).click();
      await vp.getByText(member
        ? "You are a member of this group, but not a Group Administrator."
        : "You are not a member of this group. You can view its name and description.",
        { exact: true }).waitFor();
      await vp.getByText("Only administrators of this group can view its member list.", { exact: true }).waitFor();
      assert.equal(await vp.getByRole("button", { name: "Save", exact: true }).count(), 0);
      assert.equal(await vp.locator(".groups-member-count").count(), 0);
      assert.equal(await vp.evaluate(() => typeof window.angular), "undefined");
      await vp.screenshot({
        path: evidencePath(`groups-${member ? "member" : "non-member"}.png`),
        fullPage: true,
      });
      await vp.getByRole("tab", { name: "Delete group", exact: true }).click();
      await vp.getByText("Only administrators of this group can delete it.", { exact: true }).waitFor();
      assert.equal(await vp.locator(".groups-delete-button").count(), 0);
      await vp.getByRole("tab", { name: "Manage groups", exact: true }).click();
    };
    await selectAsViewer(false);
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
    await selectAsViewer(true);
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
    await selectAsViewer(false);
    await viewer.close();
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
    // Reloading recovers the revision the server now holds and keeps what the user typed, so the
    // edit survives the conflict and saves against the recovered tag.
    await page
      .getByRole("button", { name: "Reload group", exact: true })
      .click();
    // Save stays disabled until the page holds the server's current revision again.
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "Save" && !button.disabled,
      ),
    );
    assert.equal(
      await page.getByLabel("Description", { exact: true }).inputValue(),
      "Local edit retained",
    );
    await mutation(
      "PUT",
      path,
      () => page.getByRole("button", { name: "Save", exact: true }).click(),
      200,
    );
    await page.screenshot({
      path: evidencePath("groups.png"),
      fullPage: true,
    });
    await page.getByRole("tab", { name: "Delete group", exact: true }).click();
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
      "PASS: Groups is Angular-only; CRUD, private caller status, non-member/member/removal views, administrator changes, last administrator, and stale-write conflict",
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
      path: evidencePath("privacy-mobile.png"),
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
    await page.getByRole("link", { name: "Back to Workspace", exact: true }).click();
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
  if (keyRestore) {
    const restored = await restore(keyRestore, { call, auth: user1.auth });
    assert.ok(restored.ok, `Temporary key cleanup failed: ${restored.status}`);
    noteRestored(keyRestore);
  }
}
