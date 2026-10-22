import { withBrowserAuthentication, withJourneyAuthentication } from "./auth-activity.mjs";
// Modern Angular journey; the AngularJS login-smoke-test.mjs remains unchanged.
//
// The steps before the journey loop are one chain on one template, authored in Designer with a
// Disease field constrained through the live term picker. The template then reuses a library
// element, a second user populates it while that element's source stays private, and its owner
// writes and edits metadata on it in the metadata editor. Each step checks what an earlier step
// made. Everything after the chain is a journey with fixtures of its own, run in the order
// journey-registry.mjs lists them.
//
//   node modern-workspace-smoke.mjs [--chain-only]
//
// `--chain-only` runs the chain and skips the journeys. The split tier's core lane runs it that way
// while other lanes run the journeys through focused-journey-smoke.mjs.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { actors, artifactBody, call, mutate, enc, poll } from "./rest/lib.mjs";
import { captureCreates, recordCreate, rendered } from "./journey-fixtures.mjs";
import { DOID_DISEASE, editorStatus, offeredTerm } from "./metadata-journey-fixtures.mjs";
import {
  assertOnlyContentChanges, backToWorkspace, editor as editorAt, editorSave as editorSaveAt,
  listed as listedAt, listing as listingAt, menu, openSharedWithMe, pathId, ready, setPermission,
  sharedWithMeLists,
} from "./workspace-journey-fixtures.mjs";
import { sharedTemplateJourney } from "./shared-template-journey.mjs";
import { designerTerminologyFailureJourney, editorTerminologyFailureJourney, LIVE_SEARCH_TIMEOUT } from "./terminology-failure-journey.mjs";
import { journeyBrowser } from "./journey-browser.mjs";
import { scenarioTracker } from "./journey-contract.mjs";
import { JOURNEYS } from "./journey-registry.mjs";
import { enter, evidencePath, record } from "./split-steps.mjs";
const chainOnly = process.argv.slice(2).includes("--chain-only");
const base = process.env.CEDAR_BASE || "https://workspace.metadatacenter.orgx";
const designer =
  process.env.CEDAR_DESIGNER_BASE || "https://designer.metadatacenter.orgx";
const stamp = Date.now();
const names = Object.fromEntries(
  ["folder", "template", "element", "instance"].map((k) => [k, `Angular journey ${k} ${stamp}`]),
);
const { user1, user2 } = await actors();
const browser = await chromium.launch({ headless: !process.env.HEADED });
const created = [];
const bodies = new Map();
const errors = [];
const checks = [];
let chainDiagnostics = journeyBrowser(browser, { directory: evidencePath("chain") });
let chainFailure = null;
let page,
  folderId,
  step = "login";
async function login(username, password, storageState) {
  return withBrowserAuthentication("core or sequential runner sign-in", async () => {
    const context = await browser.newContext({
      storageState,
      ignoreHTTPSErrors: true,
      viewport: { width: 1500, height: 1000 },
    });
    context.setDefaultTimeout(25000);
    await captureCreates(context, created, bodies);
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
  });
}
const listing = (p, id = folderId) => listingAt(p, base, id);
const listed = (p, name, id = folderId) => listedAt(p, base, id, name);
const editor = (p, name) => editorAt(p, base, folderId, name);
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
  recordCreate(created, method, response.url(), response.status(), body);
  return body;
}
const editorSave = (p, method, collection, status = 200) => editorSaveAt(p, write, method, collection, status);
async function grant(p, role) {
  await listed(p, names.template);
  await menu(p, names.template, "Permissions…");
  await setPermission(p, write, "/templates/", role);
}
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
  await field.getByRole("textbox", { name: "Enter field name", exact: true }).fill("Disease");
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
    .check({ timeout: LIVE_SEARCH_TIMEOUT });
  await picker.getByRole("button", { name: "Apply", exact: true }).click();
  await picker.getByRole("tab", { name: /^Branches/ }).click();
  await picker
    .getByRole("button", { name: "disease 1 ontology", exact: true })
    .click({ timeout: LIVE_SEARCH_TIMEOUT });
  await picker
    .getByRole("option", { name: /^DOID · Human Disease Ontology/ })
    .dblclick({ timeout: LIVE_SEARCH_TIMEOUT });
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
function pass(idOrMessage, promise) {
  const message = promise ?? idOrMessage;
  checks.push(message);
  console.log("PASS: " + message);
}
try {
  step = enter("login");
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
  // The run's folder holds every fixture the run makes, each journey's own folder included. It is
  // made by REST, since the folder-ui journey checks Workspace's own folder dialogs.
  step = enter("fixtures");
  const root = await call(user1.auth, "POST", "/folders", {
    folderId: user1.profile.homeFolderId, name: names.folder, description: "Temporary journey",
  });
  assert.equal(root.status, 201, root.text);
  folderId = root.body["@id"];
  created.push({ collection: "folders", id: folderId });
  // The template reuses this library element. It is annotated, so the reuse can be seen to keep its
  // metadata, and made first, so the search index has it by the time Designer searches for it.
  const artifacts = {};
  const element = await call(user1.auth, "POST", "/template-elements?folder_id=" + enc(folderId),
    artifactBody("element", names.element, {
      "schema:identifier": `journey-element-${stamp}`,
      "_annotations": {"https://example.org/journey-note": {"@value": "Keep this annotation"}},
    }));
  assert.equal(element.status, 201, element.text);
  artifacts.element = element.body["@id"];
  created.push({ collection: "template-elements", id: artifacts.element });
  step = enter("create-template");
  await listing(page);
  const returnUrl = page.url();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("link", { name: "Template", exact: true }).click();
  await page.waitForURL((u) => u.origin === new URL(designer).origin);
  assert.equal(new URL(page.url()).searchParams.get("returnTo"), returnUrl);
  await page.getByPlaceholder("Template name", { exact: true }).fill(names.template);
  await page.getByRole("button", { name: /^Add field$/ }).click();
  await page
    .locator("app-field-type-picker")
    .getByRole("button", { name: "Text", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Enter field name", exact: true })
    .fill("Notes");
  await constrainToDoidDiseaseBranch(page);
  artifacts.template = (await editorSave(page, "PUT", "templates", 201))["@id"];
  // The new artifact stays open at its edit address, which keeps Workspace's address.
  assert.equal(new URL(page.url()).pathname, `/templates/edit/${pathId(artifacts.template)}`);
  assert.equal(new URL(page.url()).searchParams.get("returnTo"), returnUrl);
  const authored = await call(user1.auth, "GET", "/templates/" + enc(artifacts.template));
  assert.equal(
    authored.body.properties?.Disease?._valueConstraints?.branches?.[0]?.uri,
    DOID_DISEASE,
    "the Disease field is constrained to the DOID disease branch",
  );
  await backToWorkspace(page);
  assert.equal(page.url(), returnUrl);
  const contentPath = "/templates/" + enc(artifacts.template);
  const sourceContent = (await call(user1.auth, "GET", contentPath)).body;
  // Seed supported metadata outside the description control being exercised.
  const annotated = await mutate(user1.auth, "PUT", contentPath, {...sourceContent,
    "schema:identifier": `journey-template-${stamp}`,
    "_annotations": {"https://example.org/journey-note": {"@value": "Keep this annotation"}},
  });
  assert.equal(annotated.status, 200, annotated.text);
  const beforeDescriptionEdit = (await call(user1.auth, "GET", contentPath)).body;
  await editor(page, names.template);
  await page.getByPlaceholder("Add description...", { exact: true }).fill("Updated by journey");
  await saveThroughExpiredToken(page, artifacts.template);
  const afterDescriptionEdit = (await call(user1.auth, "GET", contentPath)).body;
  assertOnlyContentChanges(beforeDescriptionEdit, afterDescriptionEdit, {"schema:description": "Updated by journey"});
  await backToWorkspace(page);
  pass("Template: CED/CEFD create, reopen, conditional update, each staying in Designer, exact return");
  pass("Template: a description edit preserves the rest of the stored artifact");
  pass("CED authors a Disease field constrained to the DOID disease branch through the live term picker");
  pass("Designer save recovers from an expired access token through one refresh and one retry");
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
    .find(value => value["pav:derivedFrom"] === artifacts.element);
  await editorSave(page, "PUT", "templates");
  const importedTemplate = (await call(user1.auth, "GET", "/templates/" + enc(artifacts.template))).body;
  const importedElement = embeddedElement(importedTemplate);
  assert.ok(importedElement, "an imported draft records its source");
  assert.notEqual(importedElement["@id"], artifacts.element, "an imported draft has an independent identity");
  assert.equal(importedElement["bibo:status"], "bibo:draft");
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
  const nestedEditor = page.locator("app-container-editor").nth(1);
  const nestedDescription = nestedEditor.getByPlaceholder("Add description...", {exact: true});
  const elementKey = Object.keys(importedTemplate.properties).find(key =>
    (importedTemplate.properties[key].items ?? importedTemplate.properties[key])["pav:derivedFrom"] === artifacts.element);
  assert.ok(elementKey, "the reused element has a key in its parent");
  // The header edits how the parent displays its imported child. The child's own description
  // is independent from the start and is edited in Presentation.
  await nestedDescription.fill("Local reused element display");
  await editorSave(page, "PUT", "templates");
  const locallyDisplayed = (await call(user1.auth, "GET", "/templates/" + enc(artifacts.template))).body;
  assert.equal(locallyDisplayed._ui.propertyDescriptions[elementKey], "Local reused element display");
  assert.deepEqual(embeddedElement(locallyDisplayed), importedElement,
    "editing the parent's display description leaves the reused definition unchanged");
  const elementSettings = nestedEditor.locator("app-element-card").first();
  const expandSettings = elementSettings.getByRole("button", {name: "Expand element settings", exact: true});
  if (await expandSettings.count()) await expandSettings.click();
  await elementSettings.getByRole("tab", {name: "Presentation", exact: true}).click();
  await elementSettings.getByRole("tabpanel", {name: "Presentation", exact: true})
    .getByLabel("Element description", {exact: true}).fill("Local reused element edit");
  await editorSave(page, "PUT", "templates");
  const locallyEdited = (await call(user1.auth, "GET", "/templates/" + enc(artifacts.template))).body;
  assert.equal(embeddedElement(locallyEdited)["schema:description"], "Local reused element edit");
  assert.equal(locallyEdited._ui.propertyDescriptions[elementKey], "Local reused element display");
  assert.equal((await call(user1.auth, "GET", elementSourcePath)).body["schema:description"], "Later library source edit");
  await backToWorkspace(page);
  await editor(page, names.template);
  assert.equal(await nestedDescription.inputValue(), "Local reused element display");
  const reopenedLocal = await page.locator("cedar-embeddable-designer").evaluate(el => el.currentArtifact);
  assert.equal(embeddedElement(reopenedLocal)["schema:description"], "Local reused element edit");
  await backToWorkspace(page);
  pass("Imported draft elements retain origin and annotations; library, embedded and parent display descriptions remain independent after reopening");
  // The second user may view the template, whose reused element's library source stays private to
  // its owner, and populates it from Shared with Me.
  step = enter("shared-template-population");
  await grant(page, "viewer");
  const reader = await login(
    process.env.CEDAR_FRONTEND_local_USER2_LOGIN || "test2@test.com",
    process.env.CEDAR_FRONTEND_local_USER2_PASSWORD || "test2",
  );
  await openSharedWithMe(reader, () => reader
    .getByRole("link", { name: "Shared with Me", exact: true })
    .click());
  assert.ok(await sharedWithMeLists(reader, names.template), "Shared with Me does not list the template");
  await sharedTemplateJourney({page: reader, user: user2, sourceElementId: artifacts.element,
    templateName: names.template, created, menu, write, pass});
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
  // The record is listed in Workspace beside the template it was made from.
  await listed(page, names.instance);
  pass(
    "Populate → CEE create, redirect, re-edit, conditional save and Workspace listing",
  );
  // Each journey makes its own fixtures, in a folder of its own under the run's folder, and reads
  // nothing another journey or the chain above has made. focused-journey-smoke.mjs runs any of them
  // on its own, under the same key.
  let baseline = await page.context().storageState();
  assert.deepEqual(chainDiagnostics.errors, [], "uncaught browser errors in the core chain");
  const completedChain = chainDiagnostics;
  chainDiagnostics = null;
  await completedChain.finish();
  for (const entry of chainOnly ? [] : JOURNEYS) {
    const { key, run } = entry;
    step = enter(key);
    const began = Date.now(), fixtureStart = created.length;
    const tracker = scenarioTracker(key, { recordDirectory: process.env.CEDAR_JOURNEY_RECORD_INVENTORY,
      emit: scenario => { pass(scenario.promise); record({ event: "scenario", step: key, ...scenario }); } });
    const diagnostics = journeyBrowser(browser, { directory: evidencePath(key),
      capture: context => captureCreates(context, created, bodies) });
    let failure = null;
    const cleanupErrors = [];
    try {
      page = await login(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || "test1@test.com",
        process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || "test1", baseline);
      baseline = await page.context().storageState();
      await withJourneyAuthentication(entry, () => run({page, base, designer, user: user1, folderId, name: names.instance, created, write, pass: tracker.pass}));
      assert.deepEqual(diagnostics.errors, [], "uncaught browser errors");
    } catch (error) { failure = error; }
    try {
      for (const item of created.splice(fixtureStart).reverse()) {
        const removed = await mutate(user1.auth, "DELETE", "/" + item.collection + "/" + enc(item.id));
        if (![200, 204, 404].includes(removed.status)) cleanupErrors.push(`${item.collection}/${item.id}: ${removed.status}`);
      }
      assert.deepEqual(cleanupErrors, [], "Fixture cleanup failed");
      if (!failure) tracker.finish();
    } catch (error) { failure ??= error; }
    let evidence;
    try { evidence = await diagnostics.finish({ failure: failure?.stack, scenarios: tracker.completed, cleanupErrors }); }
    catch (error) {
      failure ??= error;
      evidence = error.evidence;
      cleanupErrors.push(...(error.teardownErrors ?? [String(error)]));
    }
    record({ event: "done", step: key, checks: tracker.completed.length, scenarios: tracker.completed,
      outcome: failure ? "fail" : "pass", message: failure?.message, seconds: (Date.now() - began) / 1000, cleanupErrors, evidence });
    if (failure) throw failure;
  }
  assert.deepEqual(errors, []);
  pass("No uncaught browser errors");
  step = enter("complete");
} catch (error) {
  chainFailure = error;
  record({ event: "fail", step, message: String(error?.message ?? error).slice(0, 2000) });
  await page
    ?.screenshot({
      path: evidencePath("failure.png"),
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
      path: evidencePath(`failure-other-${index}.png`),
      fullPage: true,
    }).catch(() => {});
    console.error(`Other browser page ${index}:`, await candidate.locator("body").innerText().catch(() => ""));
  }
  throw error;
} finally {
  const cleanupErrors = [];
  if (chainDiagnostics) {
    try { await chainDiagnostics.finish({ failure: chainFailure?.stack, scenarios: checks.map(promise => ({ promise })) }); }
    catch (error) { cleanupErrors.push(...(error.teardownErrors ?? [String(error)])); }
  }
  await browser.close().catch(error => cleanupErrors.push("Browser cleanup: " + error.message));
  // A timeline entry of its own, so cleanup's time is not charged to the last step. The step
  // variable keeps the failing step for result.json.
  record({ event: "step", step: "cleanup" });
  // An identity recorded from a create attempt may never have committed, so 404 is a clean end state.
  for (const item of [...created].reverse()) {
    const path = "/" + item.collection + "/" + enc(item.id);
    const current = await call(user1.auth, "GET", path);
    if (current.status === 404) continue;
    const result = await mutate(user1.auth, "DELETE", path);
    if (![200, 204, 404].includes(result.status))
      cleanupErrors.push(`${path}: ${result.status}`);
  }
  await writeFile(
    evidencePath("result.json"),
    JSON.stringify({ step, checks, errors, cleanupErrors }, null, 2),
  );
  record({ event: "end", step, checks: checks.length, errors, cleanupErrors });
  // Do not replace the journey's original failure with a secondary teardown failure.
  if (!chainFailure) assert.deepEqual(cleanupErrors, [], "Runner cleanup failed");
}
console.log(
  `PASS: ${chainOnly ? "modern journey chain" : "full modern journey"} (${checks.length} checks), fixtures removed`,
);
