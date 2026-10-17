import {scalarRoundtripJourney} from "./scalar-roundtrip-journey.mjs";
import {restoredValidationJourney} from "./restored-validation-journey.mjs";
import {repeatedSchemaJourney} from "./repeated-schema-journey.mjs";
import {configurationDraftJourney} from "./configuration-draft-journey.mjs";
import {accountSwitchJourney} from "./account-switch-journey.mjs";
import {combinedDeleteJourney} from "./combined-delete-journey.mjs";
import {startupRecoveryJourney,tabIsolationJourney} from "./recovery-boundary-journey.mjs";
import {openingPermissionJourney,signInPermissionJourney} from "./opening-permission-journey.mjs";
import {numericConstraintJourney} from "./numeric-constraint-journey.mjs";
import {draftRecoveryJourney, metadataReconciliationJourney} from "./draft-recovery-journey.mjs";
import {reusableSourceFailureJourney} from "./reusable-source-failure-journey.mjs";
import {recoveryElementEditsJourney} from "./recovery-element-edits-journey.mjs";
import {saveStatusJourney, confirmedSaveRecoveryJourney} from "./save-status-journey.mjs";
// Modern Angular journey; the AngularJS login-smoke-test.mjs remains unchanged.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { actors, call, mutate, enc, OPENVIEW, artifactBody, poll } from "./rest/lib.mjs";
import { createdFixture, createAttempt, fixtureAt, listingIdle, listingOf, rendered } from "./journey-fixtures.mjs";
import { editorStatus, offeredTerm } from "./metadata-journey-fixtures.mjs";
import { incompleteMetadataJourney } from "./incomplete-metadata-journey.mjs";
import { sharedTemplateJourney } from "./shared-template-journey.mjs";
import { groupAccessJourney } from "./group-access-journey.mjs";
import { designerTerminologyFailureJourney, editorTerminologyFailureJourney } from "./terminology-failure-journey.mjs";
import { contentDeletionJourney } from "./content-deletion-journey.mjs";
import { olderArtifactJourney } from "./older-artifact-journey.mjs";
import { initialLoadJourney } from "./initial-load-journey.mjs";
import { validationRejectionJourney } from "./validation-rejection-journey.mjs";
import { duplicationJourney } from "./duplication-journey.mjs";
import { templateEvolutionJourney } from "./template-evolution-journey.mjs";
import { partialMoveJourney, mixedMoveJourney } from "./partial-move-journey.mjs";
import { currentTemplateConstraintJourney } from "./current-template-constraint-journey.mjs";
import { uncertainMoveJourney } from "./uncertain-move-journey.mjs";
import { olderKeyRenameJourney } from "./older-key-rename-journey.mjs";
import { designerPendingSaveJourney } from "./designer-pending-save-journey.mjs";
import { workspaceDraftSharingJourney, designerDraftSharingJourney } from "./draft-sharing-journey.mjs";
import { uncertainCreateJourney, uncertainWorkspaceCreateJourney, uncertainVersionJourney } from "./uncertain-create-journey.mjs";
import { partialVersionDefinitionJourney, partialVersionDraftJourney } from "./partial-version-journey.mjs";
import { enter, record } from "./split-steps.mjs";
const base = process.env.CEDAR_BASE || "https://workspace.metadatacenter.orgx";
const designer =
  process.env.CEDAR_DESIGNER_BASE || "https://designer.metadatacenter.orgx";
const stamp = Date.now();
// Fixtures are canonical local identities; modern browser addresses retain only type/UUID.
const selector = iri => iri.split("/").slice(-2).join("/");
const pathId = iri => iri.substring(iri.lastIndexOf("/") + 1);
// A normal update changes its root write provenance. Everything else must be accounted
// for by the user's explicit edit, including nested definitions and unexposed metadata.
function assertOnlyContentChanges(before, after, changes) {
  const comparable = artifact => {
    const copy = structuredClone(artifact);
    delete copy["pav:lastUpdatedOn"];
    delete copy["oslc:modifiedBy"];
    return copy;
  };
  assert.deepEqual(comparable(after), comparable({...before, ...changes}),
    "Saving a targeted edit must preserve all unrelated artifact content");
}
const names = Object.fromEntries(
  [
    "folder",
    "template",
    "element",
    "field",
    "instance",
    "destination",
    "copy",
  ].map((k) => [k, `Angular journey ${k} ${stamp}`]),
);
const { user1, user2 } = await actors();
const browser = await chromium.launch({ headless: !process.env.HEADED });
const created = [];
const bodies = new Map();
const errors = [];
const checks = [];
let page,
  folderId,
  step = "login";
const modal = (p) => p.locator("dialog[open]");
// A version is entered as three numbers, one per box of the dialog's picker.
async function enterVersion(p, version) {
  const parts = version.split(".");
  for (const [index, name] of ["Major", "Minor", "Patch"].entries())
    await modal(p).getByRole("textbox", { name, exact: true }).fill(parts[index]);
}
const row = (p, name) =>
  p
    .locator("tbody tr")
    .filter({ has: p.getByRole("link", { name, exact: true }) })
    .first();
// Selecting a row opens its information. Click the date cell, since the name cell's link opens the artifact.
const showInformation = (p, name) =>
  row(p, name).locator("td").nth(1).click();
async function ready(p) {
  await p.getByRole("button", { name: "New", exact: true }).waitFor();
  // This journey selects rows and date cells. Workspace defaults to the grid, so select
  // the table explicitly after every full navigation; do not depend on an old default.
  await p.getByRole("button", { name: "List view", exact: true }).click();
  // Switching views fetches nothing, so only the pressed view control says the switch is done.
  await p.getByRole("button", { name: "List view", exact: true, pressed: true }).waitFor();
  await p.waitForFunction(
    () =>
      document.querySelector(".table-scroll")?.getAttribute("aria-busy") ===
      "false",
  );
}
function recordFixture(fixture) {
  if (fixture && !created.some(item => item.id === fixture.id)) created.push(fixture);
}
function recordCreated(method, url, status, body) {
  const fixture = createdFixture(method, url, status, body);
  // A successful POST that names an identity names one cleanup can remove.
  if (method === "POST" && status >= 200 && status < 300 && body?.["@id"])
    assert.ok(fixture, `${method} ${url} named ${body["@id"]}, outside the collections cleanup removes`);
  recordFixture(fixture);
}
async function login(username, password) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1500, height: 1000 },
  });
  context.setDefaultTimeout(25000);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (
      !["POST", "PUT"].includes(req.method()) ||
      !/^\/(folders|templates|template-elements|template-fields|template-instances|command\/)/.test(
        path,
      ) ||
      path.endsWith("/download")
    )
      return route.continue();
    let response;
    try {
      response = await route.fetch();
    } catch (error) {
      // A create whose reply never arrived may still have committed. Its address names the
      // identity, so cleanup can remove it or find it absent.
      if (createAttempt(req)) recordFixture(fixtureAt(req.url()));
      throw error;
    }
    let body;
    try {
      body = await response.json();
    } catch {}
    bodies.set(req.method() + " " + req.url(), body);
    recordCreated(req.method(), req.url(), response.status(), body);
    await route.fulfill({ response });
  });
  const p = await context.newPage();
  p.on("dialog", (dialog) => dialog.accept());
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base + "/dashboard", { waitUntil: "domcontentloaded" });
  await p
    .locator("#username, cedar-workspace-page .destinations")
    .first()
    .waitFor({ state: "visible" });
  if (await p.locator("#username").isVisible()) {
    await p.locator("#username").fill(username);
    await p.locator("#password").fill(password);
    await p.locator("#kc-login").click();
  }
  await ready(p);
  return p;
}
// A listing is read only once the request a navigation made has been answered and rendered.
const anyListing = response => response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/contents");
async function listing(p, id = folderId) {
  await Promise.all([
    p.waitForResponse(id ? listingOf(id) : anyListing),
    p.goto(base + "/dashboard" + (id ? "?folderId=" + enc(selector(id)) : ""), {
      waitUntil: "domcontentloaded",
    }),
  ]);
  await ready(p);
}
async function listed(p, name, id = folderId) {
  for (let i = 0; i < 15; i++) {
    await listing(p, id);
    // Journeys create enough fixtures to span several listing pages. Exhaust the
    // current listing before retrying for eventual search-index consistency.
    for (;;) {
      if (await row(p, name).count()) return;
      const next = p.getByRole("button", {name: "Next", exact: true});
      if (await next.isDisabled()) break;
      await Promise.all([p.waitForResponse(id ? listingOf(id) : anyListing), next.click()]);
      await listingIdle(p);
    }
  }
  throw new Error("Not listed in 15 settled listings: " + name);
}
const sharedListing = response => {
  const url = new URL(response.url());
  return response.request().method() === "GET" && url.pathname === "/search" &&
    url.searchParams.get("sharing") === "shared-with-me";
};
/** Runs a gesture that opens Shared with Me, and returns once its listing has settled. */
async function openSharedWithMe(p, gesture) {
  await Promise.all([p.waitForResponse(sharedListing), gesture()]);
  await ready(p);
}
/**
 * Whether the Shared with Me listing on this page shows the name on any of its pages. It pages by
 * fifty rows sorted by name, so a grant that another run makes to the same user can push a row past
 * the first page; reading only that page would miss a present row and prove nothing about an absent one.
 * The caller opens the listing with openSharedWithMe, so every page is read once it has settled.
 */
async function sharedWithMeLists(p, name) {
  for (;;) {
    if (await row(p, name).count()) return true;
    const next = p.getByRole("button", {name: "Next", exact: true});
    if (!(await next.count()) || await next.isDisabled()) return false;
    await Promise.all([p.waitForResponse(sharedListing), next.click()]);
    await listingIdle(p);
  }
}
async function menu(p, name, label) {
  await row(p, name)
    .getByRole("button", { name: "Actions for " + name, exact: true })
    .click();
  const item = p
    .locator(".resource-menu")
    .getByRole("button", { name: label, exact: true });
  await item.waitFor();
  await p.waitForFunction(
    (label) =>
      Array.from(document.querySelectorAll(".resource-menu button")).some(
        (b) => b.textContent.trim() === label && !b.disabled,
      ),
    label,
  );
  await item.click();
}
async function write(
  p,
  method,
  path,
  gesture,
  status = 200,
  conditional = false,
) {
  const [response] = await Promise.all([
    p.waitForResponse(
      (r) =>
        r.request().method() === method &&
        new URL(r.url()).pathname.startsWith(path),
    ),
    gesture(),
  ]);
  assert.ok(
    (Array.isArray(status) ? status : [status]).includes(response.status()),
    `${method} ${path} returned ${response.status()}, expected ${status}: ${JSON.stringify(bodies.get(method + " " + response.url()))?.slice(0, 1200)}`,
  );
  if (conditional)
    assert.ok(
      await response.request().headerValue("if-match"),
      "Missing If-Match",
    );
  // Journeys may create their own browser contexts, outside login()'s capture route.
  // Read this exact response and register successful creates before returning it.
  const body = await response.json().catch(() => undefined);
  recordCreated(method, response.url(), response.status(), body);
  return body;
}
// OpenView changes, publications and drafts confirm with "Ok" rather than "Save".
const confirmLabel = (path) =>
  /-open|publish-artifact|create-draft-artifact/.test(path) ? "Ok" : "Save";
async function save(p, method, path, status = 200, conditional = false) {
  const data = await write(
    p,
    method,
    path,
    () =>
      modal(p)
        .getByRole("button", { name: confirmLabel(path), exact: true })
        .click(),
    status,
    conditional,
  );
  await modal(p).waitFor({ state: "hidden" });
  return data;
}
async function createFolder(p, name) {
  await p.getByRole("button", { name: "New", exact: true }).click();
  await p.getByRole("button", { name: "Folder", exact: true }).click();
  await modal(p).getByLabel("Name", { exact: true }).fill(name);
  // The dialog creates the folder under an identity it mints, so the write is a PUT to that identity.
  return save(p, "PUT", "/folders/", 201);
}
async function editor(p, name) {
  await listed(p, name);
  await row(p, name).getByRole("link", { name, exact: true }).click();
  await p
    .locator("#state")
    .filter({ hasText: /^Unmodified$/ })
    .waitFor();
}
// A create is a PUT answered 201 at an identity the editor minted, and carries no If-Match.
async function editorSave(p, method, collection, status = 200) {
  const data = await write(
    p,
    method,
    "/" + collection + "/",
    () => p.locator("#save").click(),
    status,
    method === "PUT" && status !== 201,
  );
  // A successful save stays in Designer.
  await p.locator("#state").filter({ hasText: /^Saved$/ }).waitFor();
  return data;
}
// Designer's own control is the only way back to Workspace.
async function backToWorkspace(p) {
  await p.locator("#back").click();
  await ready(p);
}
async function permissionAppearance(p, name) {
  const heading = modal(p).locator('h2');
  assert.equal(await heading.evaluate(e => getComputedStyle(e).color), 'rgb(23, 63, 62)');
  assert.equal(await modal(p).evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 255, 255)');
  if (name === 'readonly') {
    assert.equal(await modal(p).locator('select.readonly-role').first().evaluate(e => getComputedStyle(e).opacity), '1', 'read-only values remain legible rather than appearing unavailable');
  }
  const previous = p.viewportSize();
  for (const width of [1440, 375]) {
    await p.setViewportSize({width, height: 950});
    const bounds = await modal(p).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'permissions stays within viewport');
    assert.equal(await modal(p).locator('.access-list').evaluate(e => e.scrollWidth <= e.clientWidth), true, 'permission controls require no horizontal scrolling');
    const done = await modal(p).getByRole('button', {name: 'Done', exact: true}).boundingBox();
    assert.ok(done.y + done.height <= 950, 'Done stays reachable on narrow screens');
    if (process.env.CEDAR_UI_SCREENSHOTS) {
      await mkdir(process.env.CEDAR_UI_SCREENSHOTS, {recursive: true});
      await p.screenshot({path: `${process.env.CEDAR_UI_SCREENSHOTS}/permissions-${name}-${width}.png`});
    }
  }
  await p.setViewportSize(previous);
}
async function permissionDone(p) {
  await modal(p).getByRole("button", { name: "Done", exact: true }).click();
  await modal(p).waitFor({ state: "hidden" });
}
async function setPermission(p, collection, role) {
  const rolePicker = modal(p).getByRole("combobox", {
    name: "Role for Test User 2",
    exact: true,
  });
  await modal(p)
    .getByRole("heading", { name: "Owner and direct role assignments", exact: true })
    .waitFor();
  if (await rolePicker.count()) {
    await write(
      p,
      "PUT",
      collection,
      () => rolePicker.selectOption(role),
      200,
      true,
    );
  } else {
    await modal(p)
      .getByRole("combobox", { name: "User or group", exact: true })
      .fill("Test User 2");
    await modal(p)
      .getByRole("option", { name: "Test User 2", exact: true })
      .click();
    await modal(p)
      .getByRole("combobox", { name: "Role", exact: true })
      .selectOption(role);
    await write(
      p,
      "PUT",
      collection,
      () => modal(p).getByRole("button", { name: "Add", exact: true }).click(),
      200,
      true,
    );
  }
  await permissionDone(p);
}
async function removePermission(p, collection) {
  await write(
    p,
    "PUT",
    collection,
    () =>
      modal(p)
        .getByRole("button", {
          name: "Remove direct role for Test User 2",
          exact: true,
        })
        .click(),
    200,
    true,
  );
  await permissionDone(p);
}
async function grant(p, role) {
  await listed(p, names.template);
  await menu(p, names.template, "Permissions…");
  await setPermission(p, "/templates/", role);
}
const DOID_DISEASE = "http://purl.obolibrary.org/obo/DOID_4";
// Add a controlled-term field and constrain it, in the real term picker against the local
// terminology server, to the "disease" branch of DOID.
async function constrainToDoidDiseaseBranch(p) {
  await p.getByRole("button", { name: /^Add field$/ }).last().click();
  await p
    .locator("app-field-type-picker")
    .getByRole("button", { name: "Controlled Terms", exact: true })
    .click();
  const field = p
    .locator("app-field-card")
    .filter({ has: p.locator("app-controlled-term-config") });
  await field.getByRole("textbox", { name: "Field display name", exact: true }).fill("Disease");
  const settings = field.locator("app-field-settings");
  const toggle = settings.locator(".settings-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await settings.getByRole("tab", { name: "Constraints", exact: true }).click();
  await settings
    .getByRole("button", { name: /Edit controlled-term constraints/ })
    .click();
  const picker = p.locator("cedar-embeddable-term-picker");
  await picker.getByRole("button", { name: "Ontologies", exact: true }).click();
  await picker
    .getByRole("checkbox", { name: /^DOID(?:\s|$)/ })
    .check();
  await picker.getByRole("button", { name: "Apply", exact: true }).click();
  await picker.getByRole("tab", { name: /^Branches/ }).click();
  await picker
    .getByRole("button", { name: "disease 1 ontology", exact: true })
    .click();
  await picker
    .getByRole("option", { name: /^DOID · Human Disease Ontology/ })
    .dblclick();
  await picker
    .getByRole("region", { name: "Field constraints" })
    .getByRole("row")
    .filter({ hasText: "DOID" })
    .filter({ hasText: /Branch\s*disease/ })
    .waitFor();
  await designerTerminologyFailureJourney({page: p, pass});
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
}
// Answer the designer's first template save with an expired-token refusal. The host must refresh
// through Keycloak and retry once, and the edit must reach the server.
async function saveThroughExpiredToken(p, templateId) {
  const saves = [];
  const refreshes = [];
  const observe = (response) => {
    const url = new URL(response.url());
    if (response.request().method() === "PUT" && url.pathname.startsWith("/templates/"))
      saves.push(response.status());
    // Only the calls before the save succeeds belong to the designer's recovery. A later one, such
    // as Workspace's own sign-in after the return, does not.
    if (url.pathname.endsWith("/protocol/openid-connect/token") && !saves.includes(200))
      refreshes.push(response.status());
  };
  let expired = false;
  const templateUrl = (url) => url.pathname.startsWith("/templates/");
  const expire = async (route) => {
    if (route.request().method() !== "PUT" || expired) return route.fallback();
    expired = true;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ errorType: "authorization", suggestedAction: "refreshToken" }),
      headers: { "Access-Control-Allow-Origin": new URL(designer).origin },
    });
  };
  p.on("response", observe);
  await p.route(templateUrl, expire);
  try {
    const saved = p.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        templateUrl(new URL(response.url())) &&
        response.status() === 200,
    );
    await p.locator("#save").click();
    await saved;
    await p.locator("#state").filter({ hasText: /^Saved$/ }).waitFor();
  } finally {
    // The interception answers only the first save and then defers. Removing it while a request is
    // in flight races the context's capture route, so it stays installed.
    p.off("response", observe);
  }
  assert.deepEqual(saves, [401, 200], "one refused save, then one retried save");
  assert.equal(
    refreshes.filter((status) => status >= 200 && status < 300).length,
    1,
    `exactly one Keycloak refresh; saw ${JSON.stringify(refreshes)}`,
  );
  const stored = await call(user1.auth, "GET", "/templates/" + enc(templateId));
  assert.equal(stored.body["schema:description"], "Updated by journey");
}
function pass(message) {
  checks.push(message);
  console.log("PASS: " + message);
}
try {
  page = await login(
    process.env.CEDAR_FRONTEND_local_USER1_LOGIN || "test1@test.com",
    process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || "test1",
  );
  assert.equal(await page.evaluate(() => typeof window.angular), "undefined");
  assert.equal(await page.locator("table").count(), 1);
  for (const name of [
    "Collapse navigation",
    "Collapse information",
    "Expand navigation",
    "Expand information",
  ])
    await page.getByRole("button", { name, exact: true }).click();
  pass("Login, Angular-only workspace and collapsible panels");
  step = enter("folder-create-rename");
  folderId = (await createFolder(page, names.folder))["@id"];
  await listing(page);
  const destination = (await createFolder(page, names.destination))["@id"];
  await listed(page, names.destination);
  await menu(page, names.destination, "Rename");
  await modal(page)
    .getByLabel("Name", { exact: true })
    .fill(names.destination + " renamed");
  await save(page, "POST", "/command/rename-resource", 200, true);
  names.destination += " renamed";
  pass("Create folder and conditional rename");
  step = enter("artifact-menu-visibility");
  for (const height of [1000, 480]) {
    await page.setViewportSize({ width: 1500, height });
    await row(page, names.destination)
      .getByRole("button", { name: "Actions for " + names.destination, exact: true }).click();
    const resourceMenu = page.locator(".resource-menu");
    await resourceMenu.waitFor();
    assert.deepEqual(
      (await resourceMenu.getByRole("button").allTextContents()).map((label) => label.trim()),
      ["Open", "Permissions…", "Move", "Rename", "Delete", "Enable Openview",
        "Disable Openview", "Open in OpenView"],
      "The folder menu must offer only applicable actions in order",
    );
    await page.waitForFunction(() => {
      const menu = document.querySelector(".resource-menu");
      const rect = menu?.getBoundingClientRect();
      return rect && rect.top >= 0 && rect.bottom <= innerHeight;
    });
    if (height === 1000) {
      assert.equal(await resourceMenu.evaluate((m) => m.scrollHeight <= m.clientHeight), true,
        "All Workspace menu actions should fit without scrolling on a tall viewport");
    }
    const last = resourceMenu.getByRole("button", { name: "Open in OpenView", exact: true });
    await last.scrollIntoViewIfNeeded();
    const bounds = await last.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height,
      "The final menu action must remain reachable on short viewports");
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  pass("Applicable folder menu actions fit tall screens and remain reachable on short screens");
  step = enter("session-retry");
  await ready(page);
  // Inject one expired-access-token response, then let the real refresh and
  // retried request reach Keycloak and the resource server.
  let attempts = 0;
  const contentsUrl = (url) =>
    url.pathname === "/folders/" + pathId(folderId) + "/contents";
  const expireOnce = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"message":"Expired access token"}',
        headers: { "Access-Control-Allow-Origin": new URL(base).origin },
      });
    return route.fallback();
  };
  await page.route(contentsUrl, expireOnce);
  const recovered = page.waitForResponse(
    (response) =>
      contentsUrl(new URL(response.url())) &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  await page
    .getByRole("button", { name: "Refresh workspace", exact: true })
    .click();
  await recovered;
  await ready(page);
  assert.equal(
    attempts,
    2,
    "One unauthorized request is refreshed and retried once",
  );
  assert.ok(await row(page, names.destination).count());
  await page.unroute(contentsUrl, expireOnce);
  pass("Expired access response refreshes the real session and retries once");
  step = enter("workspace-conflict");
  await listed(page, names.destination);
  await menu(page, names.destination, "Rename");
  await modal(page)
    .getByLabel("Description", { exact: true })
    .fill("Unsaved local edit");
  const external = await mutate(
    user1.auth,
    "PUT",
    "/folders/" + enc(destination),
    { "schema:description": "Concurrent description" },
  );
  assert.equal(external.status, 200, external.text);
  await write(
    page,
    "POST",
    "/command/rename-resource",
    () =>
      modal(page).getByRole("button", { name: "Save", exact: true }).click(),
    412,
    true,
  );
  // The dialog keeps the edit and says why once it has handled the refusal.
  await modal(page)
    .getByRole("alert")
    .filter({ hasText: "changed since" })
    .waitFor();
  assert.equal(
    await modal(page).getByLabel("Description", { exact: true }).inputValue(),
    "Unsaved local edit",
  );
  await modal(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  pass("Stale Workspace write retains edits");
  const artifacts = {};
  for (const [kind, label, collection] of [
    ["template", "Template", "templates"],
    ["element", "Element", "template-elements"],
    ["field", "Field", "template-fields"],
  ]) {
    step = enter("create-" + kind);
    await listing(page);
    const returnUrl = page.url();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL((u) => u.origin === new URL(designer).origin);
    assert.equal(new URL(page.url()).searchParams.get("returnTo"), returnUrl);
    if (kind === "field")
      await page.getByRole("button", { name: "Number", exact: true }).click();
    const input =
      kind === "template"
        ? page.getByPlaceholder("Template name", { exact: true })
        : page.getByRole("textbox", {
            name: kind === "field" ? "Field display name" : "Element name",
            exact: true,
          });
    await input.fill(names[kind]);
    if (kind === "template") {
      await page.getByRole("button", { name: /^Add field$/ }).click();
      await page
        .locator("app-field-type-picker")
        .getByRole("button", { name: "Text", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Field display name", exact: true })
        .fill("Notes");
      await constrainToDoidDiseaseBranch(page);
    }
    artifacts[kind] = (await editorSave(page, "PUT", collection, 201))["@id"];
    // The new artifact stays open at its edit address, which keeps Workspace's address.
    assert.equal(new URL(page.url()).pathname, `/${kind}s/edit/${pathId(artifacts[kind])}`);
    assert.equal(new URL(page.url()).searchParams.get("returnTo"), returnUrl);
    if (kind === "template") {
      const created = await call(user1.auth, "GET", "/templates/" + enc(artifacts.template));
      assert.equal(
        created.body.properties?.Disease?._valueConstraints?.branches?.[0]?.uri,
        DOID_DISEASE,
        "the Disease field is constrained to the DOID disease branch",
      );
    }
    await backToWorkspace(page);
    assert.equal(page.url(), returnUrl);
    const contentPath = "/" + collection + "/" + enc(artifacts[kind]);
    const sourceContent = (await call(user1.auth, "GET", contentPath)).body;
    // Seed supported metadata outside the description control being exercised.
    const annotated = await mutate(user1.auth, "PUT", contentPath, {...sourceContent,
      "schema:identifier": `journey-${kind}-${stamp}`,
      "_annotations": {"https://example.org/journey-note": {"@value": "Keep this annotation"}},
    });
    assert.equal(annotated.status, 200, annotated.text);
    const beforeDescriptionEdit = (await call(user1.auth, "GET", contentPath)).body;
    await editor(page, names[kind]);
    if (kind === "field") {
      // Settings open expanded; expand them only if a later default collapses them again.
      const expand = page.getByRole("button", {
        name: "Expand field settings",
        exact: true,
      });
      if (await expand.isVisible().catch(() => false)) await expand.click();
      // A field's own description, which CEE shows as its help, is on the Presentation tab.
      await page.getByRole("tab", { name: "Presentation", exact: true }).click();
    }
    await page
      .getByPlaceholder(kind === "field" ? "Field description" : "Add description...", {
        exact: true,
      })
      .fill("Updated by journey");
    if (kind === "template") await saveThroughExpiredToken(page, artifacts.template);
    else await editorSave(page, "PUT", collection);
    const afterDescriptionEdit = (await call(user1.auth, "GET", contentPath)).body;
    assertOnlyContentChanges(beforeDescriptionEdit, afterDescriptionEdit, {"schema:description": "Updated by journey"});
    await backToWorkspace(page);
    pass(`${label}: CED/CEFD create, reopen, conditional update, each staying in Designer, exact return`);
    pass(`${label}: a description edit preserves the rest of the stored artifact`);
    if (kind === "template") {
      pass("CED authors a Disease field constrained to the DOID disease branch through the live term picker");
      pass("Designer save recovers from an expired access token through one refresh and one retry");
    }
  }
  await reusableSourceFailureJourney({page, designer, user: user1, folderId, name: names.instance, created, write, pass});
  step = enter("reusable-element-snapshot");
  await editor(page, names.template);
  await page.getByRole("button", {name: "Import fields and elements", exact: true}).first().click();
  const importDialog = page.locator("app-child-picker dialog[open]");
  await importDialog.getByRole("searchbox").fill(names.element);
  // The element was created moments earlier and reaches the search index through a queue, so one
  // query can predate it. Search again until it is listed, counting rows only once the dialog has
  // rendered each search's answer.
  const importRow = importDialog.getByRole("row", {name: "Select " + names.element, exact: true});
  const imported = await poll(async () => {
    await Promise.all([
      page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/search"),
      importDialog.getByRole("button", {name: "Search", exact: true}).click(),
    ]);
    await importDialog.locator('.table-scroll[aria-busy="false"]').waitFor();
    return {done: (await importRow.count()) > 0};
  }, {tries: 21, delayMs: 1000});
  assert.ok(!imported.timedOut, `the reusable element never appeared in ${imported.attempts} of the Designer's import searches`);
  await importRow.click();
  await page.getByRole("button", {name: "Done", exact: true}).click();
  const elementSourcePath = "/template-elements/" + enc(artifacts.element);
  const elementSource = (await call(user1.auth, "GET", elementSourcePath)).body;
  const embeddedElement = artifact => Object.values(artifact.properties).map(value => value.items ?? value)
    .find(value => value["@id"] === artifacts.element);
  await editorSave(page, "PUT", "templates");
  const importedTemplate = (await call(user1.auth, "GET", "/templates/" + enc(artifacts.template))).body;
  const importedElement = embeddedElement(importedTemplate);
  assert.ok(importedElement, "reused element retains its source identity");
  assert.equal(importedElement["schema:description"], elementSource["schema:description"]);
  assert.deepEqual(importedElement["_annotations"], elementSource["_annotations"]);
  const sourceUpdate = await mutate(user1.auth, "PUT", elementSourcePath,
    {...elementSource, "schema:description": "Later library source edit"});
  assert.equal(sourceUpdate.status, 200, sourceUpdate.text);
  await backToWorkspace(page);
  await editor(page, names.template);
  const reopenedTemplate = await page.locator("cedar-embeddable-designer").evaluate(el => el.currentArtifact);
  assert.deepEqual(embeddedElement(reopenedTemplate), importedElement,
    "a later source edit must not silently replace the reused snapshot");
  const nestedDescription = page.locator("app-container-editor").nth(1).getByPlaceholder("Add description...", {exact: true});
  await nestedDescription.fill("Local reused element edit");
  await editorSave(page, "PUT", "templates");
  const locallyEdited = (await call(user1.auth, "GET", "/templates/" + enc(artifacts.template))).body;
  assert.equal(embeddedElement(locallyEdited)["schema:description"], "Local reused element edit");
  assert.equal((await call(user1.auth, "GET", elementSourcePath)).body["schema:description"], "Later library source edit");
  await backToWorkspace(page);
  pass("Reused elements retain source identity and annotations; library and embedded edits remain independent");
  step = enter("designer-conflict");
  await editor(page, names.template);
  const templatePath = "/templates/" + enc(artifacts.template);
  const stored = await call(user1.auth, "GET", templatePath);
  assert.equal(
    (
      await mutate(user1.auth, "PUT", templatePath, {
        ...stored.body,
        "schema:description": "Concurrent CED edit",
      })
    ).status,
    200,
  );
  await page
    .getByPlaceholder("Add description...", { exact: true }).first()
    .fill("Unsaved CED edit");
  await write(
    page,
    "PUT",
    "/templates/",
    () => page.locator("#save").click(),
    412,
    true,
  );
  // Save is disabled while it is in flight too, so wait until Designer has handled the refusal.
  await page.locator("#state").filter({ hasText: /^Reload required$/ }).waitFor();
  assert.equal(
    await page
      .getByPlaceholder("Add description...", { exact: true }).first()
      .inputValue(),
    "Unsaved CED edit",
  );
  pass("CED stale save retains edits");
  step = enter("sharing");
  await grant(page, "viewer");
  const reader = await login(
    process.env.CEDAR_FRONTEND_local_USER2_LOGIN || "test2@test.com",
    process.env.CEDAR_FRONTEND_local_USER2_PASSWORD || "test2",
  );
  await openSharedWithMe(reader, () => reader
    .getByRole("link", { name: "Shared with Me", exact: true })
    .click());
  assert.ok(await sharedWithMeLists(reader, names.template), "Shared with Me does not list the template");
  // The panel shows the row at once and what the reader may do once the template's report is read.
  await Promise.all([
    reader.waitForResponse(response => response.request().method() === "GET" &&
      new URL(response.url()).pathname.endsWith("/report") &&
      decodeURIComponent(new URL(response.url()).pathname).includes(pathId(artifacts.template))),
    showInformation(reader, names.template),
  ]);
  await reader
    .getByRole("heading", { name: names.template, exact: true })
    .waitFor();
  assert.equal(
    await reader
      .getByRole("button", { name: "Edit description", exact: true })
      .count(),
    0,
  );
  await menu(reader, names.template, "Permissions…");
  await modal(reader)
    .getByRole("heading", { name: "Owner and direct role assignments", exact: true })
    .waitFor();
  assert.equal(
    await modal(reader)
      .getByRole("combobox", { name: "User or group", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await modal(reader)
      .getByRole("combobox", { name: "Role for Test User 2", exact: true })
      .isDisabled(),
    true,
  );
  await permissionAppearance(reader, "readonly");
  await permissionDone(reader);
  step = enter("shared-template-population");
  await sharedTemplateJourney({page: reader, user: user2, sourceElementId: artifacts.element,
    templateName: names.template, created, menu, write, pass});
  step = enter("sharing");
  await grant(page, "editor");
  await reader.reload();
  await ready(reader);
  await menu(reader, names.template, "Rename");
  await modal(reader)
    .getByLabel("Description", { exact: true })
    .fill("Changed by editor");
  await save(reader, "POST", "/command/rename-resource", 200, true);
  // The editor opened with permission; another user removes that permission while
  // its draft is still open. This differs from initially opening a read-only page.
  await reader.goto(designer + "/templates/edit/" + enc(artifacts.template));
  const readerDescription = reader.getByPlaceholder("Add description...", {exact: true}).first();
  await reader.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
  await readerDescription.fill("Designer draft after access loss");
  const beforeDesignerRevocation = await call(user1.auth, "GET", "/templates/" + enc(artifacts.template));
  await grant(page, "viewer");
  const deniedDesignerSave = reader.waitForResponse(response => response.status() === 403 &&
    response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith("/templates/"));
  await reader.locator("#save").click();
  await deniedDesignerSave;
  await reader.waitForFunction(() => document.getElementById("save").disabled);
  assert.equal(await readerDescription.inputValue(), "Designer draft after access loss");
  assert.deepEqual((await call(user1.auth, "GET", "/templates/" + enc(artifacts.template))).body,
    beforeDesignerRevocation.body);
  // Reload asks before discarding the draft, and the answer is settled once the question is closed.
  reader.removeAllListeners("dialog");
  const askedToReload = reader.waitForEvent("dialog");
  reader.once("dialog", dialog => dialog.dismiss());
  await reader.locator("#reload").click();
  assert.equal((await askedToReload).type(), "confirm");
  assert.equal(await readerDescription.inputValue(), "Designer draft after access loss");
  reader.on("dialog", dialog => dialog.accept());
  pass("Designer loses edit permission while open: save refused, draft retained, server content unchanged");
  await grant(page, "manager");
  await openSharedWithMe(reader, () => reader.goto(base + "/dashboard?sharing=shared-with-me"));
  assert.ok(await sharedWithMeLists(reader, names.template), "Shared with Me does not list the template");
  await menu(reader, names.template, "Permissions…");
  await modal(reader)
    .getByRole("combobox", { name: "User or group", exact: true })
    .waitFor();
  await permissionDone(reader);
  await listed(page, names.template);
  await menu(page, names.template, "Permissions…");
  await modal(page).getByRole("heading", {name: "Owner and direct role assignments", exact: true}).waitFor();
  await permissionAppearance(page, "editable");
  // Special groups remain Viewer-only and cannot be made owners.
  await modal(page)
    .getByRole("combobox", { name: "User or group", exact: true })
    .fill("Everyone");
  await modal(page)
    .getByRole("option", { name: "Everyone (Group)", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#share-role")?.options.length === 1,
  );
  assert.deepEqual(
    await modal(page)
      .getByRole("combobox", { name: "Role", exact: true })
      .locator("option")
      .allTextContents(),
    ["Viewer"],
  );
  await write(
    page,
    "PUT",
    "/templates/",
    () => modal(page).getByRole("button", { name: "Add", exact: true }).click(),
    200,
    true,
  );
  const everyoneRole = modal(page).getByRole("combobox", {
    name: "Role for Everyone",
    exact: true,
  });
  await everyoneRole.waitFor();
  assert.deepEqual(
    (await everyoneRole.locator("option").allTextContents()).map((label) => label.trim()),
    ["Viewer"],
  );
  assert.equal(
    await modal(page)
      .getByRole("checkbox", { name: "Make Everyone the owner", exact: true })
      .isDisabled(),
    true,
  );
  await write(
    page,
    "PUT",
    "/templates/",
    () =>
      modal(page)
        .getByRole("button", {
          name: "Remove direct role for Everyone",
          exact: true,
        })
        .click(),
    200,
    true,
  );
  await everyoneRole.waitFor({ state: "detached" });

  // An external ACL change must reject a stale edit and leave the failed intent visible.
  const permissionPath = templatePath + "/permissions";
  const acl = await call(user1.auth, "GET", permissionPath);
  assert.equal(acl.status, 200);
  const changed = await mutate(user1.auth, "PUT", permissionPath, {
    owner: { "@id": acl.body.owner["@id"] },
    userPermissions: acl.body.userPermissions.map((g) => ({
      user: { "@id": g.user["@id"] },
      role: "editor",
    })),
    groupPermissions: [],
  });
  assert.equal(changed.status, 200);
  await write(
    page,
    "PUT",
    "/templates/",
    () =>
      modal(page)
        .getByRole("combobox", { name: "Role for Test User 2", exact: true })
        .selectOption("viewer"),
    412,
    true,
  );
  await modal(page)
    .getByRole("alert")
    .filter({ hasText: "Not saved: Set Test User 2 to Viewer" })
    .waitFor();
  await modal(page)
    .getByRole("button", { name: "Reload permissions", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Role for Test User 2"]')
        ?.value === "editor",
  );
  await removePermission(page, "/templates/");
  await openSharedWithMe(reader, () => reader.reload());
  assert.equal(await sharedWithMeLists(reader, names.template), false,
    "Shared with Me still lists the template after its grant was removed");
  pass(
    "Permissions: viewer access, immediate role saves, Everyone restrictions, stale revisions, and two-user revocation",
  );
  step = enter("ownership");
  // Ownership moves through Workspace's own control in both directions, each confirmed in the page.
  const transferOwnership = async (p, toName, toUser) => {
    const confirmation = p.locator("dialog.confirmation-dialog");
    const permissions = await write(
      p,
      "POST",
      "/command/transfer-resource-ownership",
      async () => {
        await modal(p)
          .getByRole("checkbox", { name: `Make ${toName} the owner`, exact: true })
          .click();
        await confirmation.getByRole("button", { name: "Yes", exact: true }).click();
      },
      200,
    );
    assert.equal(permissions?.owner?.["@id"], toUser.profile["@id"]);
    assert.ok(
      !(permissions?.userPermissions ?? []).some(
        (g) => g.user?.["@id"] === toUser.profile["@id"],
      ),
      "the new owner does not also keep a direct role",
    );
    await modal(p).waitFor({ state: "hidden" });
  };
  await grant(page, "editor");
  await listed(page, names.template);
  await menu(page, names.template, "Permissions…");
  await transferOwnership(page, "Test User 2", user2);
  // The new owner no longer sees the template under Shared with Me and cannot open the folder
  // holding it, so reach it through search. The index follows the transfer, so retry.
  await reader
    .getByRole("textbox", { name: "Search workspace", exact: true })
    .fill(names.template);
  const transferred = await poll(async (attempt) => {
    const searched = reader.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/search" &&
        url.searchParams.get("q") === names.template &&
        response.status() === 200
      );
    });
    // Submitting the same search again changes no route, so later attempts refresh the listing.
    await reader
      .getByRole("button", {
        name: attempt === 1 ? "Search" : "Refresh workspace",
        exact: true,
      })
      .click();
    await searched;
    await ready(reader);
    return { done: (await row(reader, names.template).count()) > 0 };
  }, { tries: 21, delayMs: 1000 });
  assert.ok(!transferred.timedOut,
    `the transferred template never appeared in ${transferred.attempts} of the new owner's searches`);
  await menu(reader, names.template, "Permissions…");
  await modal(reader)
    .getByRole("combobox", { name: "User or group", exact: true })
    .fill("Test User 1");
  await modal(reader)
    .getByRole("option", { name: "Test User 1", exact: true })
    .click();
  await modal(reader)
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption("editor");
  await write(
    reader,
    "PUT",
    "/templates/",
    () => modal(reader).getByRole("button", { name: "Add", exact: true }).click(),
    200,
    true,
  );
  await transferOwnership(reader, "Test User 1", user1);
  const returned = await call(user1.auth, "GET", permissionPath);
  assert.equal(returned.body.owner["@id"], user1.profile["@id"]);
  // Leave the template owned by Test User 1 alone, as the later steps expect.
  if (returned.body.userPermissions.length)
    assert.equal(
      (
        await mutate(user1.auth, "PUT", permissionPath, {
          owner: { "@id": user1.profile["@id"] },
          userPermissions: [],
          groupPermissions: [],
        })
      ).status,
      200,
    );
  pass("Ownership transfers to another user and back through Workspace");
  step = enter("metadata");
  await listed(page, names.template);
  await menu(page, names.template, "Populate");
  const cee = page.locator("cedar-embeddable-editor");
  await editorStatus(page, /^Unmodified$/).waitFor();
  await cee.getByLabel("Notes", { exact: false }).first().fill("First notes");
  // The constrained field offers live DOID terms from the terminology server as the user types.
  const disease = cee.getByLabel("Disease", { exact: false }).first();
  const influenza = await offeredTerm(page, disease, "influenza", /influenza/i,
    "no DOID suggestion offered for influenza");
  await influenza.click();
  assert.equal(await page.evaluate(() => typeof window.angular), "undefined");
  assert.deepEqual(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((r) => new URL(r.name).pathname)
        .filter((path) => /bower_components\/angular\//.test(path)),
    ),
    [],
  );
  await page.evaluate(() => {
    window.journeyEditor = document.querySelector("cedar-embeddable-editor");
  });
  await page.locator("#instance-name").fill(names.instance);
  // Hold the identity readback while the author continues typing. Acknowledging
  // server-minted nested IDs must not replace those newer values or remount CEE.
  const instanceReadback = url => /^\/template-instances\//.test(url.pathname) && !url.pathname.endsWith("/report");
  let releaseIdentityRead;
  const identityGate = new Promise(resolve => { releaseIdentityRead = resolve; });
  await page.route(instanceReadback, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await identityGate;
    return route.continue();
  });
  const readingIdentities = page.waitForRequest(request =>
    request.method() === "GET" && instanceReadback(new URL(request.url())));
  await write(
    page,
    "PUT",
    "/template-instances/",
    () => page.locator("#button-save-metadata").click(),
    201,
  );
  await readingIdentities;
  await cee.getByLabel("Notes", {exact: false}).first().fill("Newer notes during acknowledgement");
  releaseIdentityRead();
  await page.waitForURL(/\/instances\/edit\//);
  await page.unroute(instanceReadback);
  // The save has been acknowledged once the status leaves Saving, here for Modified.
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: "Modified"}).waitFor();
  assert.equal(await cee.getByLabel("Notes", {exact: false}).first().inputValue(), "Newer notes during acknowledgement");
  pass("First save adopts nested element IDs without losing edits made during acknowledgement");
  const suggestedTerm = (
    await call(
      user1.auth,
      "GET",
      "/template-instances/" +
        enc(decodeURIComponent(new URL(page.url()).pathname.split("/instances/edit/")[1])),
    )
  ).body.Disease?.["@id"];
  assert.match(
    suggestedTerm ?? "",
    /^http:\/\/purl\.obolibrary\.org\/obo\/DOID_\d+$/,
    "the chosen suggestion is stored as a DOID term",
  );
  pass("Populate offers live DOID suggestions for the constrained field and stores the chosen term");
  assert.equal(
    await page.evaluate(
      () =>
        window.journeyEditor ===
        document.querySelector("cedar-embeddable-editor"),
    ),
    true,
  );
  const metadataUrl = page.url();
  const instanceId = decodeURIComponent(
    new URL(page.url()).pathname.split("/instances/edit/")[1],
  );
  const beforeNotesEdit = (await call(user1.auth, "GET", "/template-instances/" + enc(instanceId))).body;
  await cee.getByLabel("Notes", { exact: false }).first().fill("Updated notes");
  await write(
    page,
    "PUT",
    "/template-instances/",
    () => page.locator("#button-save-metadata").click(),
    200,
    true,
  );
  // CED keys a new field by its name as written, so the field named "Notes" is stored as `Notes`.
  const storedInstance = (
    await call(user1.auth, "GET", "/template-instances/" + enc(instanceId))
  ).body;
  assert.equal(
    storedInstance.Notes?.["@value"],
    "Updated notes",
    `stored instance fields: ${Object.keys(storedInstance).filter((k) => !k.includes(":") && !k.startsWith("@"))}`,
  );
  assertOnlyContentChanges(beforeNotesEdit, storedInstance, {Notes: {"@value": "Updated notes"}});
  pass("CEE value edit preserves other values, term identity, context and provenance");
  await editorTerminologyFailureJourney({page, user: user1,
    instancePath: "/template-instances/" + enc(instanceId), write, pass});
  await page
    .locator(".metadata-toolbar [role=status]")
    .filter({ hasText: /^Saved$/ })
    .waitFor();
  await cee
    .getByLabel("Notes", { exact: false })
    .first()
    .fill("Unsaved navigation");
  await page
    .locator(".metadata-toolbar [role=status]")
    .filter({ hasText: "Modified" })
    .waitFor();
  await page.getByRole("button", { name: "Back to Workspace", exact: true }).click();
  const discard = page
    .locator("dialog.confirmation-dialog")
    .filter({ hasText: "Discard unsaved metadata changes?" });
  await discard.getByRole("button", { name: "Cancel", exact: true }).click();
  await discard.waitFor({ state: "detached" });
  assert.equal(page.url(), metadataUrl);
  // The in-page confirmation guards Workspace navigation; the browser's own prompt guards unloading.
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.accept());
  await cee.getByLabel("Notes", { exact: false }).first().fill("Updated notes");
  await page
    .locator(".metadata-toolbar [role=status]")
    .filter({ hasText: /^Saved$/ })
    .waitFor();
  await page.getByRole("button", { name: "Back to Workspace", exact: true }).click();
  await ready(page);
  pass(
    "CEE host loads no AngularJS, saves without remounting, guards navigation and recognizes exact reverts",
  );
  await page.goto(metadataUrl);
  await editorStatus(page, /^Unmodified$/).waitFor();
  await cee.getByLabel("Notes", { exact: false }).first().waitFor();
  const instancePath = "/template-instances/" + enc(instanceId);
  // Let the update commit, then drop its response: it may not claim confirmed success or repeat
  // the write while the outcome is unknown. Creation with a lost reply is uncertain-create's journey.
  {
    const value = "Committed edit with lost response";
    await cee.getByLabel("Notes", {exact: false}).first().fill(value);
    const matcher = url => /^\/template-instances(?:\/|$)/.test(url.pathname);
    let writes = 0, committed;
    const loseResponse = async intercepted => {
      const req = intercepted.request();
      if (!["POST", "PUT"].includes(req.method())) return intercepted.fallback();
      writes++;
      const response = await intercepted.fetch();
      committed = await response.json();
      assert.ok(response.ok(), JSON.stringify(committed));
      await intercepted.abort("failed");
    };
    await page.route(matcher, loseResponse);
    try {
      await page.locator("#button-save-metadata").click();
      await page.getByRole("alert").filter({hasText: "could not confirm whether"}).waitFor();
      assert.equal(await page.locator("#button-save-metadata").isDisabled(), true);
      assert.equal(await cee.getByLabel("Notes", {exact: false}).first().inputValue(), value);
      const stored = await call(user1.auth, "GET", "/template-instances/" + enc(committed["@id"]));
      assert.equal(stored.body.Notes["@value"], value);
      await page.locator("#button-save-metadata").dispatchEvent("click");
      // A save the page started would show Saving… once rendered, and a refused one changes nothing.
      await rendered(page);
      assert.doesNotMatch(await page.locator(".metadata-toolbar [role=status]").innerText(), /^Saving/);
      assert.equal(writes, 1);
    } finally {
      await page.unroute(matcher, loseResponse);
    }
    pass("CEE edit with a lost committed response retains input and prevents another write");
  }
  await page.goto(metadataUrl);
  await cee.getByLabel("Notes", {exact: false}).first().waitFor();
  // Returning to the interrupted update now offers its durable recovery journal.
  await page.getByRole("button", {name: "Restore draft", exact: true}).click();
  await page.getByRole("button", {name: "Check save status", exact: true}).click();
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  const beforeConflict = await call(user1.auth, "GET", instancePath);
  assert.equal(
    (
      await mutate(user1.auth, "PUT", instancePath, {
        ...beforeConflict.body,
        Notes: { "@value": "Concurrent metadata" },
      })
    ).status,
    200,
  );
  await cee
    .getByLabel("Notes", { exact: false })
    .first()
    .fill("My unsaved metadata");
  await write(
    page,
    "PUT",
    "/template-instances/",
    () => page.locator("#button-save-metadata").click(),
    412,
    true,
  );
  await page.getByRole("alert").filter({ hasText: "changed since" }).waitFor();
  assert.equal(
    await cee.getByLabel("Notes", { exact: false }).first().inputValue(),
    "My unsaved metadata",
  );
  assert.equal(
    (await call(user1.auth, "GET", instancePath)).body.Notes["@value"],
    "Concurrent metadata",
  );
  pass(
    "CEE host rejects stale saves and preserves local edits and the concurrent server update",
  );
  await grant(page, "viewer");
  await listed(page, names.instance);
  await menu(page, names.instance, "Permissions…");
  await setPermission(page, "/template-instances/", "viewer");
  await reader.goto(metadataUrl);
  await reader
    .locator(".metadata-toolbar [role=status]")
    .filter({ hasText: "Read only" })
    .waitFor();
  assert.equal(await reader.evaluate(() => typeof window.angular), "undefined");
  assert.equal(await reader.locator("#button-save-metadata").count(), 0);
  assert.equal(
    await reader.locator("#instance-name").getAttribute("readonly"),
    "",
  );
  await menu(page, names.instance, "Permissions…");
  await removePermission(page, "/template-instances/");
  pass(
    "CEE host settles viewer permissions before configuring its read-only editor",
  );
  await menu(page, names.instance, "Permissions…");
  await setPermission(page, "/template-instances/", "editor");
  await reader.goto(metadataUrl);
  const readerNotes = reader.locator("cedar-embeddable-editor").getByLabel("Notes", {exact: false}).first();
  await editorStatus(reader, /^Unmodified$/).waitFor();
  await readerNotes.fill("Metadata draft after access loss");
  const beforeEditorRevocation = await call(user1.auth, "GET", instancePath);
  await menu(page, names.instance, "Permissions…");
  await setPermission(page, "/template-instances/", "viewer");
  await write(reader, "PUT", "/template-instances/",
    () => reader.locator("#button-save-metadata").click(), 403, true);
  await reader.waitForFunction(() => document.getElementById("button-save-metadata").disabled);
  assert.equal(await readerNotes.inputValue(), "Metadata draft after access loss");
  assert.deepEqual((await call(user1.auth, "GET", instancePath)).body, beforeEditorRevocation.body);
  await reader.getByRole("button", {name: "Reload metadata", exact: true}).click();
  const reloadQuestion = reader.locator("dialog.confirmation-dialog");
  await reloadQuestion.getByRole("button", {name: "Cancel", exact: true}).click();
  await reloadQuestion.waitFor({state: "hidden"});
  assert.equal(await readerNotes.inputValue(), "Metadata draft after access loss");
  await menu(page, names.instance, "Permissions…");
  await removePermission(page, "/template-instances/");
  pass("CEE loses edit permission while open: save refused, draft retained, server content unchanged");
  pass(
    "Populate → CEE create, redirect, re-edit, conditional save and Workspace listing",
  );
  // Workspace no longer offers artifact downloads. The REST download suite covers JSON,
  // YAML and compact YAML for every artifact kind; editor download controls have browser coverage.
  step = enter("group-derived-access");
  await groupAccessJourney({page, reader, base, designer, owner: user1, member: user2,
    templateId: artifacts.template, instancePath, metadataUrl, name: names.instance, write, pass});
  step = enter("initial-load");
  await initialLoadJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, pass});
  step = enter("validation-rejection");
  await validationRejectionJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("current-template-constraint");
  await currentTemplateConstraintJourney({page, base, user: user1, folderId,
    name: names.instance, created, write, pass});
  for (const [label, journey] of Object.entries({"scalar-roundtrip":scalarRoundtripJourney,"restored-validation":restoredValidationJourney,"repeated-schema":repeatedSchemaJourney,"configuration-draft":configurationDraftJourney,"account-switch":accountSwitchJourney,"combined-delete":combinedDeleteJourney,"startup-recovery":startupRecoveryJourney,"tab-isolation":tabIsolationJourney,"opening-permissions":openingPermissionJourney,"signin-permissions":signInPermissionJourney,"numeric-constraint":numericConstraintJourney,"mixed-move":mixedMoveJourney,"draft-sharing-workspace":workspaceDraftSharingJourney,"draft-sharing-designer":designerDraftSharingJourney,"uncertain-create":uncertainCreateJourney,"uncertain-workspace-create":uncertainWorkspaceCreateJourney,"uncertain-version":uncertainVersionJourney,"partial-version-definition":partialVersionDefinitionJourney,"partial-version-draft":partialVersionDraftJourney})) {
    step = enter(label);
    await journey({page,base,designer,user:user1,folderId,name:names.instance,created,write,pass});
  }
  step = enter("older-artifacts");
  await olderArtifactJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("older-key-rename");
  await olderKeyRenameJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("designer-pending-save");
  await designerPendingSaveJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("save-status");
  await saveStatusJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("recovery-element-edits");
  await confirmedSaveRecoveryJourney({page, base, designer, user: user1, folderId, name: names.instance, created, write, pass});
  await recoveryElementEditsJourney({page, base, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("durable-draft-recovery");
  await draftRecoveryJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("metadata-reconciliation");
  await metadataReconciliationJourney({page, base, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("content-deletion");
  await contentDeletionJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  step = enter("incomplete-required-metadata");
  await incompleteMetadataJourney({page, base, user: user1, folderId, templateId: artifacts.template,
    name: names.instance, created, write, pass});
  step = enter("uncertain-move");
  await uncertainMoveJourney({page, base, user: user1, folderId,
    name: names.instance, created, pass});
  step = enter("copy-move");
  await partialMoveJourney({page, base, user: user1, folderId,
    name: names.instance, created, pass});
  await duplicationJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  await listed(page, names.template);
  await menu(page, names.template, "Copy");
  await modal(page).getByLabel("Name of copy", { exact: true }).fill(names.copy);
  const copy = await save(
    page,
    "POST",
    "/command/copy-artifact-to-folder",
    201,
  );
  assert.ok(copy["@id"]);
  await listed(page, names.copy);
  await menu(page, names.copy, "Move");
  await modal(page)
    .locator("cedar-folder-list")
    .getByRole("button", { name: names.destination, exact: true })
    .click();
  await save(page, "POST", "/command/move-resource-to-folder", 201, true);
  await listed(page, names.copy, destination);
  pass("Copy and conditional move through folder picker");
  step = enter("versioning");
  await templateEvolutionJourney({page, base, designer, user: user1, folderId,
    name: names.instance, created, write, pass});
  await listed(page, names.template);
  await menu(page, names.template, "Publish");
  await enterVersion(page, "1.0.0");
  await save(page, "POST", "/command/publish-artifact", [200, 201]);
  await listed(page, names.template);
  await menu(page, names.template, "Create Draft");
  await enterVersion(page, "1.1.0");
  const draft = await save(page, "POST", "/command/create-draft-artifact", 201);
  assert.ok(draft["@id"]);
  assert.notEqual(draft["@id"], artifacts.template);
  assert.equal(
    (await call(user1.auth, "GET", "/template-instances/" + enc(instanceId)))
      .body["schema:isBasedOn"],
    artifacts.template,
  );
  pass("Publish/new draft preserves metadata template identity");
  await listed(page, names.template);
  await showInformation(page, names.template);
  await page.getByRole("tab", { name: "Version", exact: true }).click();
  // The tab describes the selected version and names the other one: the draft
  // as the latest version, or the published template as a previous one.
  const panel = page.getByRole("tabpanel");
  const versionCell = panel.locator("dd").nth(1);
  await versionCell.waitFor();
  const shown = (await versionCell.textContent()).trim();
  assert.ok(["1.0.0", "1.1.0"].includes(shown), `Version tab shows ${shown}`);
  await panel
    .locator(shown === "1.0.0" ? ".latest-version" : ".previous-versions")
    .filter({ hasText: shown === "1.0.0" ? "· 1.1.0 · Draft" : "· 1.0.0 · Published" })
    .waitFor();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  pass("Details and Version panels show the published/draft chain");
  step = enter("openview");
  await listed(page, names.copy, destination);
  await menu(page, names.copy, "Enable Openview");
  await save(page, "POST", "/command/make-artifact-open", 200, true);
  // OpenView follows a change of openness after the command has answered, so read it until it agrees.
  const openViewStatus = async (open, what) => {
    const outcome = await poll(async () => {
      const r = await call(null, "GET", "/templates/" + enc(copy["@id"]), undefined, { base: OPENVIEW });
      return { done: open ? r.status === 200 : [401, 403, 404].includes(r.status), status: r.status };
    }, { tries: 20, delayMs: 500 });
    assert.ok(!outcome.timedOut, `${what}: OpenView still answers ${outcome.status} after ${outcome.attempts} reads`);
  };
  await openViewStatus(true, "OpenView did not become public");
  const publicContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const publicPage = await publicContext.newPage();
  publicPage.on("pageerror", (error) => errors.push(error.message));
  await publicPage.goto(
    "https://openview." +
      new URL(base).hostname.split(".").slice(1).join(".") +
      "/templates/" +
      pathId(copy["@id"]),
  );
  await publicPage.locator("cedar-embeddable-editor").waitFor();
  await publicPage.waitForFunction((name) => {
    const content = document.querySelector("cedar-embeddable-editor")
      ?.shadowRoot?.textContent;
    return content?.includes(name) && content.includes("Notes");
  }, names.copy);
  await menu(page, names.copy, "Disable Openview");
  await save(page, "POST", "/command/make-artifact-not-open", 200, true);
  await openViewStatus(false, "Closed artifact remains public");
  pass("OpenView open/render/close");
  step = enter("folder-openview");
  await listed(page, names.destination);
  await menu(page, names.destination, "Enable Openview");
  await save(page, "POST", "/command/make-folder-open", 200, true);
  await openViewStatus(true, "An open folder did not make its child artifact public");
  await menu(page, names.destination, "Disable Openview");
  await save(page, "POST", "/command/make-folder-not-open", 200, true);
  await openViewStatus(false, "A closed folder left its child artifact public");
  pass("Folder OpenView grant and revocation apply to its child artifact");
  step = enter("deleted-designer-save");
  await listed(page, names.copy, destination);
  await row(page, names.copy)
    .getByRole("link", { name: names.copy, exact: true })
    .click();
  // An artifact just read from the server is unmodified, not saved.
  await page.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
  assert.equal(
    (await mutate(user1.auth, "DELETE", "/templates/" + enc(copy["@id"])))
      .status,
    204,
  );
  await page
    .getByPlaceholder("Add description...", { exact: true }).first()
    .fill("Unsaved after deletion");
  // CED checks template update impact before saving; deletion is caught there
  // before a conditional PUT can be sent.
  const deletedRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/command/check-update-template/" + pathId(copy["@id"]) &&
      response.status() === 404,
  );
  await page.locator("#save").click();
  await deletedRead;
  await page
    .locator("#message")
    .filter({ hasText: /404|not found/i })
    .waitFor();
  assert.equal(
    await page
      .getByPlaceholder("Add description...", { exact: true }).first()
      .inputValue(),
    "Unsaved after deletion",
  );
  assert.equal(
    (await call(user1.auth, "GET", "/templates/" + enc(copy["@id"]))).status,
    404,
  );
  pass(
    "Delete versus CED save retains edits and cannot resurrect the artifact",
  );
  step = enter("search");
  await listing(page);
  await page
    .getByRole("textbox", { name: "Search workspace", exact: true })
    .fill(names.element);
  const searched = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/search" &&
      url.searchParams.get("q") === names.element &&
      response.status() === 200
    );
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await searched;
  await ready(page);
  // Indexing is eventual. As in the ownership search, refresh the listing until the element appears.
  const found = await poll(async (attempt) => {
    if (attempt > 1) {
      const again = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/search" && url.searchParams.get("q") === names.element && response.status() === 200;
      });
      await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
      await again;
      await ready(page);
    }
    return { done: (await row(page, names.element).count()) > 0 };
  }, { tries: 21, delayMs: 1000 });
  assert.ok(!found.timedOut, `the authored element never appeared in ${found.attempts} top searches`);
  pass("Top search finds authored element");
  step = enter("delete");
  for (const [kind, collection] of [
    ["instance", "template-instances"],
    ["field", "template-fields"],
    ["element", "template-elements"],
  ]) {
    await listed(page, names[kind]);
    let deletedEditor;
    if (kind === "instance") {
      deletedEditor = await page.context().newPage();
      deletedEditor.on("pageerror", (error) => errors.push(error.message));
      await deletedEditor.goto(metadataUrl);
      await editorStatus(deletedEditor, /^Unmodified$/).waitFor();
      await deletedEditor
        .locator("cedar-embeddable-editor")
        .getByLabel("Notes", { exact: false })
        .first()
        .waitFor();
    }
    await menu(page, names[kind], "Delete");
    await write(
      page,
      "DELETE",
      "/" + collection,
      () =>
        modal(page)
          .getByRole("button", { name: "Yes, delete it!", exact: true })
          .click(),
      204,
      true,
    );
    await modal(page).waitFor({ state: "hidden" });
    if (deletedEditor) {
      const notes = deletedEditor
        .locator("cedar-embeddable-editor")
        .getByLabel("Notes", { exact: false })
        .first();
      await notes.fill("Edits after metadata deletion");
      await write(
        deletedEditor,
        "PUT",
        "/template-instances/",
        () => deletedEditor.locator("#button-save-metadata").click(),
        412,
        true,
      );
      await deletedEditor
        .getByRole("alert")
        .filter({ hasText: "was deleted" })
        .waitFor();
      assert.equal(await notes.inputValue(), "Edits after metadata deletion");
      assert.equal((await call(user1.auth, "GET", instancePath)).status, 404);
      await deletedEditor.close();
      pass(
        "CEE save after deletion retains edits and cannot recreate metadata",
      );
    }
  }
  pass("Conditional deletion through Workspace");
  step = enter("selected-folder-and-artifact-delete");
  const bulkCreated = [];
  async function bulkCreate(collection, parent, name, type, extra = {}) {
    const response = await call(user1.auth, "POST", "/" + collection +
      (type ? "?folder_id=" + enc(parent) : ""),
      type ? artifactBody(type, name, extra) : {folderId: parent, name, description: "Selection deletion smoke fixture"});
    assert.equal(response.status, 201, response.text);
    const item = {collection, id: response.body["@id"]};
    created.push(item); bulkCreated.push(item);
    return item.id;
  }
  const bulkRoot = await bulkCreate("folders", user1.profile.homeFolderId, `Selection deletion ${stamp}`);
  const bulkFolder = await bulkCreate("folders", bulkRoot, `Selected folder ${stamp}`);
  const bulkEmpty = await bulkCreate("folders", bulkRoot, `Selected empty folder ${stamp}`);
  const bulkNested = await bulkCreate("folders", bulkFolder, `Nested folder ${stamp}`);
  const bulkTemplate = await bulkCreate("templates", bulkFolder, `Nested template ${stamp}`, "template");
  await bulkCreate("template-instances", bulkNested, `Nested instance ${stamp}`, "instance", {"schema:isBasedOn":bulkTemplate});
  const bulkField = await bulkCreate("template-fields", bulkRoot, `Selected field ${stamp}`, "field");
  await listing(page, bulkRoot);
  for (const [index, id] of [bulkFolder, bulkEmpty, bulkField].entries()) {
    await page.locator(`[data-resource-id="${id}"] .resource-icon`).click({modifiers:index ? ["ControlOrMeta"] : []});
  }
  const bulkAction = page.getByRole("button", {name:"Delete (3)",exact:true});
  const bulkSource = await page.locator(`[data-resource-id="${bulkFolder}"] .resource-icon`).boundingBox();
  const bulkBin = await bulkAction.boundingBox();
  await page.mouse.move(bulkSource.x + bulkSource.width / 2, bulkSource.y + bulkSource.height / 2);
  await page.mouse.down();
  await page.mouse.move(bulkSource.x + bulkSource.width / 2 + 10, bulkSource.y + bulkSource.height / 2 + 10, {steps:3});
  await page.mouse.move(bulkBin.x + bulkBin.width / 2, bulkBin.y + bulkBin.height / 2, {steps:12});
  await page.locator('.selection-delete.explorer-delete-target').waitFor();
  await page.mouse.up();
  await modal(page).getByText("Total items to delete: 6.", {exact:false}).waitFor();
  await modal(page).getByRole("button", {name:"Cancel",exact:true}).click();
  for (const item of bulkCreated) assert.equal((await call(user1.auth,"GET","/"+item.collection+"/"+enc(item.id))).status,200);
  await bulkAction.click();
  await modal(page).getByText("Total items to delete: 6.", {exact:false}).waitFor();
  await modal(page).getByRole("button",{name:"Delete selected items and contents",exact:true}).click();
  await modal(page).waitFor({state:"hidden"});
  for (const item of bulkCreated.filter(item=>item.id!==bulkRoot)) {
    assert.equal((await call(user1.auth,"GET","/"+item.collection+"/"+enc(item.id))).status,404);
  }
  pass("Bin drop cancels safely; clicking Delete then removes two folders, nested template/instance and a separate artifact");
  step = enter("partial-selection-delete");
  const partialIds = [];
  for (let i = 0; i < 3; i++) partialIds.push(await bulkCreate("template-fields", bulkRoot,
    `Partial deletion ${i} ${stamp}`, "field"));
  await listing(page, bulkRoot);
  for (const [index, id] of partialIds.entries()) {
    await page.locator(`[data-resource-id="${id}"] .resource-icon`).click({modifiers: index ? ["ControlOrMeta"] : []});
  }
  const attemptedDeletes = [];
  const deleteMatcher = url => url.pathname.startsWith("/template-fields/");
  const loseSecondDelete = async intercepted => {
    const req = intercepted.request();
    if (req.method() !== "DELETE") return intercepted.fallback();
    attemptedDeletes.push(pathId(new URL(req.url()).pathname));
    assert.ok(req.headers()["if-match"]);
    const response = await intercepted.fetch();
    assert.ok(response.ok());
    if (attemptedDeletes.length === 2) return intercepted.abort("failed");
    await intercepted.fulfill({response});
  };
  await page.route(deleteMatcher, loseSecondDelete);
  await page.getByRole("button", {name: "Delete (3)", exact: true}).click();
  await modal(page).getByRole("button", {name: "Delete", exact: true}).click();
  await modal(page).getByRole("alert").filter({hasText: "Some items may already have been deleted"}).waitFor();
  await modal(page).getByText("Confirmed deletions so far", {exact: true}).waitFor();
  await modal(page).getByText("1", {exact: true}).waitFor();
  assert.equal(await modal(page).getByRole("button", {name: "Delete", exact: true}).isDisabled(), true);
  assert.equal(attemptedDeletes.length, 2);
  for (const id of partialIds) {
    assert.equal((await call(user1.auth, "GET", "/template-fields/" + enc(id))).status,
      attemptedDeletes.includes(pathId(id)) ? 404 : 200);
  }
  await modal(page).getByRole("button", {name: "Delete", exact: true}).dispatchEvent("click");
  // A deletion the dialog started would show its progress once rendered, and a refused one changes nothing.
  await rendered(page);
  assert.equal(await modal(page).getByRole("status").count(), 0, "the refused Delete started a deletion");
  assert.equal(attemptedDeletes.length, 2);
  await page.unroute(deleteMatcher, loseSecondDelete);
  await modal(page).getByRole("button", {name: "Cancel", exact: true}).click();
  await listing(page, bulkRoot);
  const remainingId = partialIds.find(id => !attemptedDeletes.includes(pathId(id)));
  await page.locator(`[data-resource-id="${remainingId}"] .resource-icon`).click();
  await page.getByRole("button", {name: "Delete (1)", exact: true}).click();
  await write(page, "DELETE", "/template-fields/",
    () => modal(page).getByRole("button", {name: "Delete", exact: true}).click(), [200, 204], true);
  await modal(page).waitFor({state: "hidden"});
  for (const id of partialIds) assert.equal((await call(user1.auth, "GET", "/template-fields/" + enc(id))).status, 404);
  pass("Partial deletion stops after a lost response, reports only confirmed progress and resumes from a fresh selection");
  assert.deepEqual(errors, []);
  pass("No uncaught browser errors");
  step = enter("complete");
} catch (error) {
  record({ event: "fail", step, message: String(error?.message ?? error).slice(0, 2000) });
  await mkdir("/tmp/cedar-modern-workspace-smoke", { recursive: true });
  await page
    ?.screenshot({
      path: "/tmp/cedar-modern-workspace-smoke/failure.png",
      fullPage: true,
    })
    .catch(() => {});
  console.error("FAILED STEP:", step);
  console.error("Designer validation:", await page?.evaluate(() => {
    const editor = document.querySelector("cedar-embeddable-designer, cedar-embeddable-field-designer");
    return editor?.validationReport ?? null;
  }).catch(() => null));
  console.error(
    await page
      ?.locator("body")
      .innerText()
      .catch(() => ""),
  );
  // A second user's page may own the failure; the original owner tab cannot explain it.
  let otherPage = 0;
  for (const context of browser.contexts()) for (const candidate of context.pages()) {
    if (candidate === page || candidate.isClosed()) continue;
    const index = ++otherPage;
    await candidate.screenshot({
      path: `/tmp/cedar-modern-workspace-smoke/failure-other-${index}.png`,
      fullPage: true,
    }).catch(() => {});
    console.error(`Other browser page ${index}:`, await candidate.locator("body").innerText().catch(() => ""));
  }
  throw error;
} finally {
  await browser.close();
  // A timeline entry of its own, so cleanup's time is not charged to the last step. The step
  // variable keeps the failing step for result.json.
  record({ event: "step", step: "cleanup" });
  const cleanupErrors = [];
  // An identity recorded from a create attempt may never have committed, so 404 is a clean end state.
  for (const item of [...created].reverse()) {
    const path = "/" + item.collection + "/" + enc(item.id);
    const current = await call(user1.auth, "GET", path);
    if (current.status === 404) continue;
    const result = await mutate(user1.auth, "DELETE", path);
    if (![200, 204, 404].includes(result.status))
      cleanupErrors.push(`${path}: ${result.status}`);
  }
  await mkdir("/tmp/cedar-modern-workspace-smoke", { recursive: true });
  await writeFile(
    "/tmp/cedar-modern-workspace-smoke/result.json",
    JSON.stringify({ step, checks, errors, cleanupErrors }, null, 2),
  );
  record({ event: "end", step, checks: checks.length, errors, cleanupErrors });
  assert.deepEqual(cleanupErrors, [], "Fixture cleanup failed");
}
console.log(
  `PASS: full modern journey (${checks.length} checks), fixtures removed`,
);
