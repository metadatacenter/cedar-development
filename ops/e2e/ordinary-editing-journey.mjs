import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { metadataFixture, numericField, comparable, editorStatus } from "./metadata-journey-fixtures.mjs";
import { focused, listingIdle, keepingListingPreferences } from "./journey-fixtures.mjs";
import { listed, row, editorSave, assertOnlyContentChanges } from "./workspace-journey-fixtures.mjs";

export const textField = (name, type = "textfield") => {
  const field = artifactBody("field", name);
  field._ui.inputType = type;
  return field;
};
export const editor = page => page.locator("cedar-embeddable-editor");
export const input = (page, name) => editor(page).getByLabel(name, { exact: true });
export async function opened(page, fixture) {
  await page.goto(fixture.url);
  await editorStatus(page, /^Unmodified$/).waitFor();
}
export async function saved(args, gesture = () => args.page.locator("#button-save-metadata").click()) {
  await args.write(args.page, "PUT", "/template-instances/", gesture, 200, true);
  await editorStatus(args.page, /^Saved$/).waitFor();
}
async function ordinary(page) {
  for (const name of ["Restore draft", "Discard recovery draft", "Check save status"])
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0,
      `An ordinary editing session must not show ${name}`);
}

// Every journey acts as the first test user only. Fixtures belong to its own folder.
export async function largeMetadataJourney(args) {
  const { page, pass } = args;
  const keys = Array.from({ length: 40 }, (_, i) => `Observation ${String(i + 1).padStart(2, "0")}`);
  const fields = Object.fromEntries(keys.map(key => [key, textField(key)]));
  const values = Object.fromEntries(keys.map((key, i) => [key, { "@value": `Original observation ${i + 1}` }]));
  const fixture = await metadataFixture(args, "large metadata", fields, values,
    { iris: Object.fromEntries(keys.map((key, i) => [key, `https://example.org/observation/${i + 1}`])) });
  const expected = (await fixture.read()).body;
  await opened(page, fixture);
  await ordinary(page);
  // Alternate between distant positions rather than only editing the visible first screen.
  for (const index of [39, 0, 21, 8, 38]) {
    const key = keys[index], value = `Revised observation ${index + 1}: αβγ`;
    await input(page, key).fill(value);
    expected[key]["@value"] = value;
  }
  await saved(args);
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  for (const key of keys) assert.equal(await input(page, key).inputValue(), expected[key]["@value"]);
  await ordinary(page);
  pass("distant-fields", "Editing widely separated fields in a forty-field record saves and reopens every changed and untouched answer exactly");
}

export async function mixedMetadataJourney(args) {
  const { page, pass } = args;
  const decision = textField("Decision", "radio");
  decision._valueConstraints = { requiredValue: false, multipleChoice: false,
    literals: ["Pending", "Accepted", "Declined"].map(label => ({ label })) };
  const link = textField("Reference", "link");
  link.properties = { "@type": link.properties["@type"], "@id": { type: "string", format: "uri" }, "rdfs:label": { type: ["string", "null"] } };
  delete link.required;
  const fields = { Notes: textField("Notes", "textarea"), Count: numericField("Count", "xsd:int"),
    Contact: textField("Contact", "email"), Reference: link, Decision: decision, Keep: textField("Keep") };
  const fixture = await metadataFixture(args, "mixed inputs", fields, {
    Notes: { "@value": "Original notes" }, Count: { "@value": "12", "@type": "xsd:int" },
    Contact: { "@value": "initial@example.org" }, Reference: { "@id": "https://example.org/original" },
    Decision: { "@value": "Pending" }, Keep: { "@value": "Keep me exactly" },
  });
  const expected = (await fixture.read()).body;
  await opened(page, fixture);
  const changes = { Notes: "First line\nSecond line: café — 東京 🧬", Count: "27", Contact: "reviewer+cedar@example.org", Reference: "https://example.org/review?q=a%20b#details" };
  for (const [key, value] of Object.entries(changes)) {
    await input(page, key).fill(value);
    expected[key][key === "Reference" ? "@id" : "@value"] = value;
  }
  await editor(page).getByRole("radio", { name: "Accepted", exact: true }).check();
  expected.Decision["@value"] = "Accepted";
  await saved(args);
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  for (const [key, value] of Object.entries(changes)) assert.equal(await input(page, key).inputValue(), value);
  assert.equal(await editor(page).getByRole("radio", { name: "Accepted", exact: true }).isChecked(), true);
  assert.equal(await input(page, "Keep").inputValue(), "Keep me exactly");
  await ordinary(page);
  pass("mixed-types", "A single editing session preserves multiline Unicode, numeric typing, email, a reference IRI and radio choice through save and reopen without changing its untouched sibling");
}

// Find a control through ordinary Tab navigation, allowing intervening help controls without
// encoding the component's implementation-specific number of tab stops.
async function tabTo(page, target, reverse = false, limit = 80) {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate(el => el === el.getRootNode().activeElement || el.contains(el.getRootNode().activeElement))) return;
    await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
  }
  await focused(target, "The control must be reachable by keyboard");
}

export async function keyboardMetadataJourney(args) {
  const { page, pass } = args;
  const fixture = await metadataFixture(args, "keyboard form",
    { First: textField("First"), Second: textField("Second"), Third: textField("Third") },
    { First: { "@value": "One" }, Second: { "@value": "Two" }, Third: { "@value": "Three" } });
  const expected = (await fixture.read()).body;
  await opened(page, fixture);
  for (const [key, value] of [["First", "First keyboard answer"], ["Second", "Second keyboard answer"], ["Third", "Third keyboard answer"]]) {
    await tabTo(page, input(page, key));
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(value);
    expected[key]["@value"] = value;
  }
  await tabTo(page, input(page, "Second"), true);
  await page.keyboard.press("End");
  await page.keyboard.type(" corrected");
  expected.Second["@value"] += " corrected";
  await tabTo(page, page.locator("#button-save-metadata"));
  await saved(args, () => page.keyboard.press("Enter"));
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  for (const key of ["First", "Second", "Third"]) assert.equal(await input(page, key).inputValue(), expected[key]["@value"]);
  pass("keyboard-form", "Keyboard-only forward and backward form navigation, correction and Save preserve the exact record after reopening");
}

export async function keyboardRepeatedMetadataJourney(args) {
  const { page, pass } = args;
  const fixture = await metadataFixture(args, "keyboard repeated",
    { Notes: { type: "array", minItems: 0, items: textField("Notes") }, Keep: textField("Keep") },
    { Notes: ["First occurrence", "Middle occurrence", "Last occurrence"].map(value => ({ "@value": value })), Keep: { "@value": "Unchanged" } });
  const expected = (await fixture.read()).body;
  await opened(page, fixture);
  const pager = editor(page).locator("app-cedar-multi-pager");
  const chip = pager.getByRole("option", { name: "1", exact: true });
  // Material's roving focus is reached by Tab; arrows choose a chip, Enter activates it.
  await tabTo(page, chip);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await pager.getByRole("option", { name: "2", exact: true, selected: true }).waitFor();
  await tabTo(page, input(page, "Notes"));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Middle corrected by keyboard");
  expected.Notes[1]["@value"] = "Middle corrected by keyboard";
  await tabTo(page, page.locator("#button-save-metadata"));
  await saved(args, () => page.keyboard.press("Enter"));
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  await pager.getByRole("option", { name: "2", exact: true }).click();
  assert.equal(await input(page, "Notes").inputValue(), expected.Notes[1]["@value"]);
  pass("keyboard-occurrence", "Keyboard navigation between repeated answers edits the selected occurrence only and preserves its neighbors through save and reopen");
}

export async function metadataNavigationJourney(args) {
  const { page, pass } = args;
  const fixture = await metadataFixture(args, "ordinary navigation", { Notes: textField("Notes") }, { Notes: { "@value": "Saved answer" } });
  const before = (await fixture.read()).body;
  await opened(page, fixture);
  await ordinary(page);
  await input(page, "Notes").fill("Unsaved answer to keep");
  const back = page.getByRole("button", { name: "Back to Workspace", exact: true });
  await back.click();
  const confirmation = page.locator("dialog.confirmation-dialog");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  assert.equal(await input(page, "Notes").inputValue(), "Unsaved answer to keep");
  assert.deepEqual((await fixture.read()).body, before);
  await saved(args);
  await back.click();
  await page.getByRole("button", { name: "New", exact: true }).waitFor();
  await opened(page, fixture);
  await ordinary(page);
  assert.equal(await input(page, "Notes").inputValue(), "Unsaved answer to keep");
  pass("cancel-then-save", "Cancelling Back retains unsaved input and leaves storage unchanged, then Save and Back reopen the same saved answer without recovery controls");
  const savedBody = (await fixture.read()).body;
  await input(page, "Notes").fill("Deliberately discarded");
  await back.click();
  await confirmation.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("button", { name: "New", exact: true }).waitFor();
  await opened(page, fixture);
  await ordinary(page);
  assert.equal(await input(page, "Notes").inputValue(), "Unsaved answer to keep");
  assert.deepEqual((await fixture.read()).body, savedBody);
  pass("discard-navigation", "Explicitly discarding an ordinary edit on Back preserves the saved record and does not offer that discarded work as a recovery draft");
}

export async function metadataRecordSwitchJourney(args) {
  const { page, pass } = args;
  const a = await metadataFixture(args, "record A", { Notes: textField("Notes") }, { Notes: { "@value": "Record A original" } });
  const b = await metadataFixture(args, "record B", { Notes: textField("Notes") }, { Notes: { "@value": "Record B original" } });
  const beforeA = (await a.read()).body, beforeB = (await b.read()).body;
  for (const [fixture, answer] of [[a, "Record A updated"], [b, "Record B updated"]]) {
    await opened(page, fixture);
    await ordinary(page);
    await input(page, "Notes").fill(answer);
    await saved(args);
    await page.getByRole("button", { name: "Back to Workspace", exact: true }).click();
    await page.getByRole("button", { name: "New", exact: true }).waitFor();
  }
  for (const [fixture, before, answer] of [[a, beforeA, "Record A updated"], [b, beforeB, "Record B updated"]]) {
    await opened(page, fixture);
    await ordinary(page);
    assert.equal(await input(page, "Notes").inputValue(), answer);
    assertOnlyContentChanges(before, (await fixture.read()).body, { Notes: { "@value": answer } });
  }
  pass("record-boundaries", "Editing two records with identical field labels in the same tab keeps their values, identities and save states separate on return");
}

async function returned(page, id, view, tab, folderId) {
  await page.getByRole("button", { name: "New", exact: true }).waitFor();
  await listingIdle(page);
  const item = page.locator(`[data-resource-id="${id}"]`);
  await item.locator(".resource-icon").waitFor();
  assert.equal(await item.evaluate(node => node.classList.contains("selected")), true);
  assert.equal(await page.locator(".information").getByRole("tab", { name: tab, exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("button", { name: view + " view", exact: true }).getAttribute("aria-pressed"), "true");
  assert.ok(decodeURIComponent(page.url()).includes(folderId.split("/").at(-1)), "Return keeps the original folder");
  assert.equal(new URL(page.url()).searchParams.has("selected"), false, "One-use selection parameters are consumed");
}

export async function designerReturnContextJourney(args) {
  const { page, base, name, user, write, pass } = args;
  const title = name + " return-context template";
  const fixture = await metadataFixture(args, "designer return context", { Notes: textField("Notes") },
    { Notes: { "@value": "Untouched metadata" } }, { template: title, instance: name + " return-context record" });
  const path = "/templates/" + enc(fixture.templateId);
  const before = (await call(user.auth, "GET", path)).body;
  await listed(page, base, fixture.folderId, title);
  const item = row(page, title);
  await item.locator(".resource-icon").click();
  await page.locator(".information").getByRole("tab", { name: "Version", exact: true }).click();
  await item.getByRole("link", { name: title, exact: true }).click();
  await page.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
  await page.getByPlaceholder("Add description...", { exact: true }).first().fill("Description updated in the real Designer");
  await editorSave(page, write, "PUT", "templates");
  await page.locator("#back").click();
  await returned(page, fixture.templateId, "List", "Version", fixture.folderId);
  assertOnlyContentChanges(before, (await call(user.auth, "GET", path)).body,
    { "schema:description": "Description updated in the real Designer" });
  assert.equal((await fixture.read()).body.Notes["@value"], "Untouched metadata");
  pass("designer-list-return", "Saving in the real Designer and returning restores the Workspace folder, list view, selected template and Version tab while preserving its existing metadata");
}

export async function metadataReturnContextJourney(args) {
  await keepingListingPreferences(args.user, () => metadataReturnContext(args));
}
async function metadataReturnContext(args) {
  const { page, base, name, pass } = args;
  const title = name + " return-context metadata";
  const fixture = await metadataFixture(args, "metadata return context", { Notes: textField("Notes") },
    { Notes: { "@value": "Before grid edit" } }, { template: name + " grid template", instance: title });
  const before = (await fixture.read()).body;
  await listed(page, base, fixture.folderId, title);
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await page.getByRole("button", { name: "Grid view", exact: true, pressed: true }).waitFor();
  const item = page.locator(`[data-resource-id="${fixture.id}"]`);
  await item.locator(".resource-icon").click();
  await page.locator(".information").getByRole("tab", { name: "Details", exact: true }).click();
  await item.locator(".resource-icon").dblclick();
  await editorStatus(page, /^Unmodified$/).waitFor();
  await input(page, "Notes").fill("After grid edit");
  await saved(args);
  await page.getByRole("button", { name: "Back to Workspace", exact: true }).click();
  await returned(page, fixture.id, "Grid", "Details", fixture.folderId);
  assertOnlyContentChanges(before, (await fixture.read()).body, { Notes: { "@value": "After grid edit" } });
  pass("metadata-grid-return", "Opening a grid card in the real metadata editor, saving and returning restores the same folder, grid view, selected record and Details tab");
}
