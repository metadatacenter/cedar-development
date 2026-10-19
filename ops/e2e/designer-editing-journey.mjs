import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { journeyFolder, focused } from "./journey-fixtures.mjs";
import { templateWith, comparable, editorStatus } from "./metadata-journey-fixtures.mjs";
import { editorSave, editor as openFromWorkspace, assertOnlyContentChanges } from "./workspace-journey-fixtures.mjs";
import { textField, input } from "./ordinary-editing-journey.mjs";

async function schema(args, suffix, fields) {
  const { name, user, created, designer } = args;
  const folderId = await journeyFolder(args, suffix);
  const title = name + " " + suffix;
  const body = templateWith(title, fields);
  // Distinct placement help exercises an override without editing the reusable definition.
  for (const key of Object.keys(fields)) body._ui.propertyDescriptions[key] = "Placement description for " + key;
  body._annotations = { "https://example.org/journey/annotation": { "@value": "Keep root annotation" } };
  const made = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId), body);
  assert.equal(made.status, 201, made.text);
  const id = made.body["@id"];
  created.push({ collection: "templates", id });
  const path = "/templates/" + enc(id);
  return { id, folderId, title, path, url: designer + "/templates/edit/" + enc(id),
    read: async () => {
      const result = await call(user.auth, "GET", path);
      assert.equal(result.status, 200, result.text);
      return result.body;
    } };
}
const three = () => Object.fromEntries(["Alpha", "Beta", "Gamma"].map(key => [key, textField(key)]));
const ced = page => page.locator("cedar-embeddable-designer");
async function open(page, fixture) {
  await page.goto(fixture.url);
  await page.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
}
async function settings(card, name) {
  const toggle = card.locator("app-field-settings .settings-toggle");
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await card.getByRole("tab", { name, exact: true }).click();
  return card.getByRole("tabpanel", { name, exact: true });
}
async function reorder(page, outline) {
  const rows = outline.locator(":scope > ul > li");
  const from = await rows.first().getByRole("button", { name: "Reorder Alpha", exact: true }).boundingBox();
  const to = await rows.last().boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(from.x + from.width / 2, to.y + to.height - 2, { steps: 12 });
  await page.locator(".cdk-drag-preview").waitFor();
  await page.mouse.up();
}
// JSON Schema required arrays are sets; serializers may align them with the UI order.
function semanticSchema(body) {
  if (Array.isArray(body)) return body.map(semanticSchema);
  if (!body || typeof body !== "object") return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) =>
    [key, key === "required" && Array.isArray(value) ? [...value].sort() : semanticSchema(value)]));
}
async function populated(args, fixture) {
  const { page, base, name, write, user } = args;
  await page.goto(base + "/instances/create/" + enc(fixture.id) + "?folderId=" + enc(fixture.folderId));
  await editorStatus(page, /^Unmodified$/).waitFor();
  await page.locator("#instance-name").fill(name + " populated " + fixture.title);
  for (const key of ["Alpha", "Beta", "Gamma"]) await input(page, key).fill(key + " answer");
  const body = await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 201);
  await editorStatus(page, /^Saved$/).waitFor();
  const read = await call(user.auth, "GET", "/template-instances/" + enc(body["@id"]));
  assert.equal(read.status, 200, read.text);
  return read.body;
}

// All journeys remain in the first account and create their own schema fixtures.
export async function designerOrderJourney(args) {
  const { page, write, pass } = args;
  for (const nested of [false, true]) {
    const section = artifactBody("element", "Section");
    if (nested) {
      for (const [key, field] of Object.entries(three())) {
        section.properties[key] = field;
        section.properties["@context"].properties[key] = { enum: ["https://example.org/journey/" + key] };
        section.required.push(key);
        section._ui.order.push(key);
        section._ui.propertyLabels[key] = key;
      }
    }
    const fixture = await schema(args, nested ? "nested field ordering" : "root field ordering", nested ? { Section: section } : three());
    const expected = await fixture.read();
    await open(page, fixture);
    const outline = ced(page).locator("app-container-outline").last();
    await reorder(page, outline);
    await page.waitForFunction(nested => {
      const artifact = document.querySelector("cedar-embeddable-designer").currentArtifact;
      return (nested ? artifact.properties.Section : artifact)._ui.order.join(",") === "Beta,Gamma,Alpha";
    }, nested);
    await editorSave(page, write, "PUT", "templates");
    (nested ? expected.properties.Section : expected)._ui.order = ["Beta", "Gamma", "Alpha"];
    const after = await fixture.read();
    if (nested) for (const body of [after, expected]) {
      delete body.properties.Section["pav:lastUpdatedOn"];
      delete body.properties.Section["oslc:modifiedBy"];
    }
    assert.deepEqual(semanticSchema(comparable(after)), semanticSchema(comparable(expected)));
    await open(page, fixture);
    const labels = ced(page).getByRole("textbox", { name: "Field display name", exact: true });
    assert.deepEqual(await labels.evaluateAll(els => els.map(el => el.value)), ["Beta", "Gamma", "Alpha"]);
    const metadata = await populated(args, fixture);
    const values = nested ? metadata.Section : metadata;
    for (const key of ["Alpha", "Beta", "Gamma"]) assert.equal(values[key]["@value"], key + " answer");
    pass(nested ? "nested-order" : "root-order", `${nested ? "Nested" : "Root"} field reordering saves and reopens without changing definitions or property identities, and new metadata remains bound to the correct fields`);
  }
}

export async function largeDesignerJourney(args) {
  const { page, write, pass } = args;
  const keys = Array.from({ length: 35 }, (_, i) => `Observation${String(i + 1).padStart(2, "0")}`);
  const fixture = await schema(args, "large designer", Object.fromEntries(keys.map(key => [key, textField(key)])));
  const expected = await fixture.read();
  await open(page, fixture);
  const cards = ced(page).locator("app-field-card");
  assert.equal(await cards.count(), 35);
  for (const index of [34, 0, 17]) {
    const panel = await settings(cards.nth(index), "Configuration");
    await panel.getByLabel("Display description", { exact: true }).fill(`Placement note ${index + 1}`);
    expected._ui.propertyDescriptions[keys[index]] = `Placement note ${index + 1}`;
  }
  await editorSave(page, write, "PUT", "templates");
  assert.deepEqual(comparable(await fixture.read()), comparable(expected));
  await open(page, fixture);
  for (const index of [34, 0, 17]) {
    const panel = await settings(cards.nth(index), "Configuration");
    assert.equal(await panel.getByLabel("Display description", { exact: true }).inputValue(), `Placement note ${index + 1}`);
  }
  pass("large-schema-placement", "Editing distant placement descriptions in a thirty-five-field schema saves and reopens the intended fields while preserving all definitions, order, property identities and annotations");
}

export async function designerKeyboardJourney(args) {
  const { page, write, pass } = args;
  const fixture = await schema(args, "designer keyboard", three());
  const expected = await fixture.read();
  await open(page, fixture);
  const cards = ced(page).locator(".field-drag-container");
  await cards.first().focus();
  await page.keyboard.press("ArrowDown");
  await focused(cards.nth(1), "ArrowDown focuses the second field card");
  await page.keyboard.press("ArrowUp");
  await focused(cards.first(), "ArrowUp returns to the first field card");
  const panel = await settings(cards.first().locator("app-field-card"), "Configuration");
  const description = panel.getByLabel("Display description", { exact: true });
  await description.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Keyboard-authored placement");
  await description.press("Tab");
  // Saving by keyboard must adopt the new clean baseline without replacing the selected tab.
  await page.locator("#save").focus();
  await write(page, "PUT", "/templates/", () => page.keyboard.press("Enter"), 200, true);
  await page.locator("#state").filter({ hasText: /^Saved$/ }).waitFor();
  assert.equal(await panel.isVisible(), true);
  expected._ui.propertyDescriptions.Alpha = "Keyboard-authored placement";
  assert.deepEqual(comparable(await fixture.read()), comparable(expected));
  await open(page, fixture);
  const reopened = await settings(ced(page).locator("app-field-card").first(), "Configuration");
  assert.equal(await reopened.getByLabel("Display description", { exact: true }).inputValue(), "Keyboard-authored placement");
  pass("designer-keyboard-edit", "Designer card navigation, keyboard text entry and keyboard Save retain the selected configuration tab and reopen the exact placement edit");
}

export async function designerDefaultJourney(args) {
  const { page, base, name, user, write, pass } = args;
  const fixture = await schema(args, "author constraints and defaults", { Code: textField("Code"), Keep: textField("Keep") });
  const before = await fixture.read();
  await open(page, fixture);
  const card = ced(page).locator("app-field-card").first();
  const configuration = await settings(card, "Configuration");
  await configuration.getByRole("combobox", { name: "Requirement", exact: true }).selectOption("required");
  const constraints = await settings(card, "Constraints");
  await constraints.getByLabel("Minimum length", { exact: true }).fill("2");
  await constraints.getByLabel("Maximum length", { exact: true }).fill("4");
  await constraints.getByLabel("Regular expression", { exact: true }).fill("^[A-Z]+$");
  await constraints.getByRole("textbox", { name: "Default value", exact: true }).fill("AB");
  await editorSave(page, write, "PUT", "templates");
  const after = await fixture.read();
  assert.deepEqual(after.properties.Keep, before.properties.Keep);
  assert.equal(after.properties.Code["@id"], before.properties.Code["@id"]);
  assert.deepEqual(after.properties.Code._valueConstraints, { ...before.properties.Code._valueConstraints,
    requiredValue: true, minLength: 2, maxLength: 4, regex: "^[A-Z]+$", defaultValue: "AB" });
  await open(page, fixture);
  assert.equal(await (await settings(card, "Constraints")).getByRole("textbox", { name: "Default value", exact: true }).inputValue(), "AB");
  await page.goto(base + "/instances/create/" + enc(fixture.id) + "?folderId=" + enc(fixture.folderId));
  await editorStatus(page, /^Unmodified$/).waitFor();
  assert.equal(await input(page, "Code").inputValue(), "AB");
  await input(page, "Code").fill("XYZ");
  await input(page, "Keep").fill("Other answer");
  await page.locator("#instance-name").fill(name + " configured metadata");
  const made = await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 201);
  await editorStatus(page, /^Saved$/).waitFor();
  const record = (await call(user.auth, "GET", "/template-instances/" + enc(made["@id"]))).body;
  assert.equal(record.Code["@value"], "XYZ");
  assert.equal(record.Keep["@value"], "Other answer");
  pass("authored-default-to-metadata", "A required text default and its length/regex constraints authored in Designer persist, initialize new metadata and accept a valid replacement through the real server");
}

export async function nestedDesignerJourney(args) {
  const { page, write, pass } = args;
  const section = artifactBody("element", "Section");
  const child = textField("Detail");
  section.properties.Detail = child;
  section.properties["@context"].properties.Detail = { enum: ["https://example.org/detail"] };
  section.required.push("Detail");
  section._ui.order.push("Detail");
  section._ui.propertyLabels.Detail = "Detail";
  section._ui.propertyDescriptions.Detail = "Original nested placement help";
  const fixture = await schema(args, "nested presentation editing", { Section: section, Keep: textField("Keep") });
  const expected = await fixture.read();
  await open(page, fixture);
  const detail = ced(page).locator("app-field-card").first();
  await (await settings(detail, "Configuration")).getByLabel("Display description", { exact: true }).fill("Nested placement explanation");
  const container = ced(page).locator("app-container-editor").last();
  await container.getByRole("button", { name: "Collapse Section", exact: true }).click();
  await container.getByRole("button", { name: "Expand Section", exact: true }).click();
  assert.equal(await (await settings(detail, "Configuration")).getByLabel("Display description", { exact: true }).inputValue(), "Nested placement explanation");
  await editorSave(page, write, "PUT", "templates");
  expected.properties.Section._ui.propertyDescriptions.Detail = "Nested placement explanation";
  const after = await fixture.read();
  for (const body of [after, expected]) {
    delete body.properties.Section["pav:lastUpdatedOn"];
    delete body.properties.Section["oslc:modifiedBy"];
  }
  assert.deepEqual(comparable(after), comparable(expected));
  await open(page, fixture);
  assert.equal(await (await settings(detail, "Configuration")).getByLabel("Display description", { exact: true }).inputValue(), "Nested placement explanation");
  pass("nested-collapse-preservation", "A nested field placement edit survives collapsing its element, saving and reopening while preserving the child definition and untouched top-level sibling");
}

export async function designerNavigationJourney(args) {
  const { page, base, write, pass } = args;
  const fixture = await schema(args, "designer navigation", three());
  const before = await fixture.read();
  await openFromWorkspace(page, base, fixture.folderId, fixture.title);
  const description = page.getByPlaceholder("Add description...", { exact: true }).first();
  const handlers = page.listeners("dialog");
  for (const handler of handlers) page.off("dialog", handler);
  try {
    await description.fill("Keep after cancelling Back");
    page.once("dialog", dialog => dialog.dismiss());
    await page.locator("#back").click();
    assert.equal(await description.inputValue(), "Keep after cancelling Back");
    assert.deepEqual(await fixture.read(), before);
    await editorSave(page, write, "PUT", "templates");
    await page.locator("#back").click();
    await openFromWorkspace(page, base, fixture.folderId, fixture.title);
    assert.equal(await description.inputValue(), "Keep after cancelling Back");
    assert.equal(await page.locator("#restore-draft").isVisible(), false);
    await description.fill("Discard on leaving");
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#back").click();
    await openFromWorkspace(page, base, fixture.folderId, fixture.title);
    assert.equal(await description.inputValue(), "Keep after cancelling Back");
    assert.equal(await page.locator("#restore-draft").isVisible(), false);
    assertOnlyContentChanges(before, await fixture.read(), { "schema:description": "Keep after cancelling Back" });
    pass("designer-cancel-save-discard", "Designer Back cancellation retains the draft, Save establishes the new baseline, and explicit discard leaves no recovery draft or unintended stored changes");
  } finally { for (const handler of handlers) page.on("dialog", handler); }
}
