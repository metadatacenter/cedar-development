// Modern Angular journey; the AngularJS login-smoke-test.mjs remains unchanged.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { actors, call, mutate, enc, OPENVIEW, artifactBody } from "./rest/lib.mjs";
const base = process.env.CEDAR_BASE || "https://workspace.metadatacenter.orgx";
const designer =
  process.env.CEDAR_DESIGNER_BASE || "https://designer.metadatacenter.orgx";
const stamp = Date.now();
// Fixtures are canonical local identities; modern browser addresses retain only type/UUID.
const selector = iri => iri.split("/").slice(-2).join("/");
const pathId = iri => iri.substring(iri.lastIndexOf("/") + 1);
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
  await p.waitForFunction(
    () =>
      document.querySelector(".table-scroll")?.getAttribute("aria-busy") ===
      "false",
  );
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
    const response = await route.fetch();
    let body;
    try {
      body = await response.json();
    } catch {}
    bodies.set(req.method() + " " + req.url(), body);
    if (req.method() === "POST" && response.ok() && body?.["@id"]) {
      const collection = path.startsWith("/command/")
        ? {
            folder: "folders",
            element: "template-elements",
            field: "template-fields",
            instance: "template-instances",
          }[body.resourceType] || "templates"
        : path.split("/")[1];
      if (!created.some((r) => r.id === body["@id"]))
        created.push({ collection, id: body["@id"] });
    }
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
async function listing(p, id = folderId) {
  await p.goto(base + "/dashboard" + (id ? "?folderId=" + enc(selector(id)) : ""), {
    waitUntil: "domcontentloaded",
  });
  await ready(p);
}
async function listed(p, name, id = folderId) {
  for (let i = 0; i < 15; i++) {
    await listing(p, id);
    // A non-waiting count can observe the old grid DOM just after the view-switch click.
    // Wait for the actual row before reloading for eventual search-index consistency.
    if (await row(p, name).waitFor({state: "visible", timeout: 1000}).then(() => true, () => false)) return;
  }
  throw new Error("Not listed: " + name);
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
  return bodies.get(method + " " + response.url());
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
  return save(p, "POST", "/folders", 201);
}
async function editor(p, name) {
  await listed(p, name);
  await row(p, name).getByRole("link", { name, exact: true }).click();
  await p
    .locator("#state")
    .filter({ hasText: /^Unmodified$/ })
    .waitFor();
}
async function editorSave(p, method, collection, status = 200) {
  const data = await write(
    p,
    method,
    "/" + collection,
    () => p.locator("#save").click(),
    status,
    method === "PUT",
  );
  await ready(p);
  return data;
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
    .getByRole("heading", { name: "Access on this resource", exact: true })
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
          name: "Remove access for Test User 2",
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
  await picker.getByText("narrow to…", { exact: true }).click();
  await picker
    .getByRole("button", { name: /^DOID Human Disease Ontology/ })
    .click();
  await picker.getByRole("button", { name: "done", exact: true }).click();
  await picker.getByRole("tab", { name: /^branches/ }).click();
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
    // After the save succeeds the host returns to Workspace, whose own sign-in also calls the
    // token endpoint; only the calls before that success belong to the designer's recovery.
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
    await ready(p);
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
  step = "folder-create-rename";
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
  step = "artifact-menu-visibility";
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
  step = "session-retry";
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
  step = "workspace-conflict";
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
  assert.equal(
    await modal(page).getByLabel("Description", { exact: true }).inputValue(),
    "Unsaved local edit",
  );
  await modal(page)
    .getByRole("alert")
    .filter({ hasText: "changed since" })
    .waitFor();
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
    step = "create-" + kind;
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
    artifacts[kind] = (await editorSave(page, "POST", collection, 201))["@id"];
    if (kind === "template") {
      const created = await call(user1.auth, "GET", "/templates/" + enc(artifacts.template));
      assert.equal(
        created.body.properties?.Disease?._valueConstraints?.branches?.[0]?.uri,
        DOID_DISEASE,
        "the Disease field is constrained to the DOID disease branch",
      );
    }
    assert.equal(page.url(), returnUrl);
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
    pass(`${label}: CED/CEFD create, reopen, conditional update, exact return`);
    if (kind === "template") {
      pass("CED authors a Disease field constrained to the DOID disease branch through the live term picker");
      pass("Designer save recovers from an expired access token through one refresh and one retry");
    }
  }
  step = "designer-conflict";
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
    .getByPlaceholder("Add description...", { exact: true })
    .fill("Unsaved CED edit");
  await write(
    page,
    "PUT",
    "/templates/",
    () => page.locator("#save").click(),
    412,
    true,
  );
  assert.equal(
    await page
      .getByPlaceholder("Add description...", { exact: true })
      .inputValue(),
    "Unsaved CED edit",
  );
  pass("CED stale save retains edits");
  step = "sharing";
  await grant(page, "viewer");
  const reader = await login(
    process.env.CEDAR_FRONTEND_local_USER2_LOGIN || "test2@test.com",
    process.env.CEDAR_FRONTEND_local_USER2_PASSWORD || "test2",
  );
  await reader
    .getByRole("link", { name: "Shared with Me", exact: true })
    .click();
  await ready(reader);
  await row(reader, names.template).waitFor();
  await showInformation(reader, names.template);
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
    .getByRole("heading", { name: "Access on this resource", exact: true })
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
  await grant(page, "editor");
  await reader.reload();
  await ready(reader);
  await menu(reader, names.template, "Rename");
  await modal(reader)
    .getByLabel("Description", { exact: true })
    .fill("Changed by editor");
  await save(reader, "POST", "/command/rename-resource", 200, true);
  await grant(page, "manager");
  await reader.reload();
  await ready(reader);
  await menu(reader, names.template, "Permissions…");
  await modal(reader)
    .getByRole("combobox", { name: "User or group", exact: true })
    .waitFor();
  await permissionDone(reader);
  await listed(page, names.template);
  await menu(page, names.template, "Permissions…");
  await modal(page).getByRole("heading", {name: "Access on this resource", exact: true}).waitFor();
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
          name: "Remove access for Everyone",
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
    .filter({ hasText: "Not saved: Set Test User 2 to viewer" })
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
  await reader.reload();
  await ready(reader);
  assert.equal(await row(reader, names.template).count(), 0);
  pass(
    "Permissions: viewer access, immediate role saves, Everyone restrictions, stale revisions, and two-user revocation",
  );
  step = "ownership";
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
        await confirmation.getByRole("button", { name: "OK", exact: true }).click();
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
  for (let i = 0; ; i++) {
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
        name: i === 0 ? "Search" : "Refresh workspace",
        exact: true,
      })
      .click();
    await searched;
    await ready(reader);
    if (await row(reader, names.template).count()) break;
    assert.ok(i < 20, "the transferred template never appeared in the new owner's search");
    await reader.waitForTimeout(1000);
  }
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
  step = "metadata";
  await listed(page, names.template);
  await menu(page, names.template, "Populate");
  const cee = page.locator("cedar-embeddable-editor");
  await cee.getByLabel("Notes", { exact: false }).first().fill("First notes");
  // The constrained field offers live DOID terms from the terminology server as the user types.
  const disease = cee.getByLabel("Disease", { exact: false }).first();
  const influenza = page.getByRole("option", { name: /influenza/i }).first();
  for (let attempt = 0; ; attempt++) {
    await disease.fill("");
    await disease.pressSequentially("influenza", { delay: 40 });
    if (await influenza.waitFor({ timeout: 15000 }).then(() => true, () => false)) break;
    assert.ok(attempt < 2, "no DOID suggestion offered for influenza");
  }
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
  await write(
    page,
    "POST",
    "/template-instances",
    () => page.locator("#button-save-metadata").click(),
    201,
  );
  await page.waitForURL(/\/instances\/edit\//);
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
  await cee.getByLabel("Notes", { exact: false }).first().waitFor();
  const instancePath = "/template-instances/" + enc(instanceId);
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
  pass(
    "Populate → CEE create, redirect, re-edit, conditional save and Workspace listing",
  );
  // Workspace no longer offers artifact downloads. The REST download suite covers JSON,
  // YAML and compact YAML for every artifact kind; editor download controls have browser coverage.
  step = "copy-move";
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
  step = "versioning";
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
  step = "openview";
  await listed(page, names.copy, destination);
  await menu(page, names.copy, "Enable Openview");
  await save(page, "POST", "/command/make-artifact-open", 200, true);
  for (let i = 0; i < 20; i++) {
    const r = await call(
      null,
      "GET",
      "/templates/" + enc(copy["@id"]),
      undefined,
      { base: OPENVIEW },
    );
    if (r.status === 200) break;
    if (i === 19) throw new Error("OpenView did not become public");
    await page.waitForTimeout(500);
  }
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
  for (let i = 0; i < 20; i++) {
    const r = await call(
      null,
      "GET",
      "/templates/" + enc(copy["@id"]),
      undefined,
      { base: OPENVIEW },
    );
    if ([401, 403, 404].includes(r.status)) break;
    if (i === 19)
      throw new Error("Closed artifact remains public: " + r.status);
    await page.waitForTimeout(500);
  }
  pass("OpenView open/render/close");
  step = "folder-openview";
  await listed(page, names.destination);
  await menu(page, names.destination, "Enable Openview");
  await save(page, "POST", "/command/make-folder-open", 200, true);
  assert.equal(
    (
      await call(null, "GET", "/templates/" + enc(copy["@id"]), undefined, {
        base: OPENVIEW,
      })
    ).status,
    200,
  );
  await menu(page, names.destination, "Disable Openview");
  await save(page, "POST", "/command/make-folder-not-open", 200, true);
  assert.ok(
    [401, 403, 404].includes(
      (
        await call(null, "GET", "/templates/" + enc(copy["@id"]), undefined, {
          base: OPENVIEW,
        })
      ).status,
    ),
  );
  pass("Folder OpenView grant and revocation apply to its child artifact");
  step = "deleted-designer-save";
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
    .getByPlaceholder("Add description...", { exact: true })
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
      .getByPlaceholder("Add description...", { exact: true })
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
  step = "search";
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
  await row(page, names.element).waitFor();
  pass("Top search finds authored element");
  step = "delete";
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
  step = "selected-folder-and-artifact-delete";
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
  assert.deepEqual(errors, []);
  pass("No uncaught browser errors");
  step = "complete";
} catch (error) {
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
  const cleanupErrors = [];
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
  assert.deepEqual(cleanupErrors, [], "Fixture cleanup failed");
}
console.log(
  `PASS: full modern journey (${checks.length} checks), fixtures removed`,
);
