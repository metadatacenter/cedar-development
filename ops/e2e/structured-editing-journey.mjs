import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { metadataFixture, numericField, comparable } from "./metadata-journey-fixtures.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { textField, editor, input, opened, saved } from "./ordinary-editing-journey.mjs";

const iri = key => "https://example.org/structured/" + encodeURIComponent(key);
function child(parent, key, definition) {
  parent.properties[key] = definition;
  parent.properties["@context"].properties[key] = { enum: [iri(key)] };
  parent._ui.order.push(key);
  parent._ui.propertyLabels[key] = key;
  parent.required.push(key);
}
const repeat = (items, maxItems) => ({ type: "array", minItems: 0, ...(maxItems ? { maxItems } : {}), items });
const elementValue = children => ({ "@id": null, "@context": Object.fromEntries(Object.keys(children).map(key => [key, iri(key)])), ...children });
const answer = value => ({ "@value": value });
const pagers = page => editor(page).locator("app-cedar-multi-pager");
async function occurrence(pager, number) {
  await pager.getByRole("option", { name: String(number), exact: true }).click();
  await pager.getByRole("option", { name: String(number), exact: true, selected: true }).waitFor();
}

async function nestedFixture(args, suffix) {
  const specimen = artifactBody("element", "Specimens");
  child(specimen, "Detail", textField("Detail"));
  child(specimen, "Codes", repeat(textField("Codes")));
  const visit = artifactBody("element", "Visits");
  child(visit, "VisitName", textField("VisitName"));
  child(visit, "Specimens", repeat(specimen));
  return metadataFixture(args, suffix, { Visits: repeat(visit, 3), Keep: textField("Keep") }, {
    Visits: [1, 2].map(v => elementValue({ VisitName: answer(`Visit ${v}`), Specimens: [1, 2].map(s =>
      elementValue({ Detail: answer(`Visit ${v} specimen ${s}`), Codes: [1, 2, 3].map(c => answer(`V${v}S${s}C${c}`)) })) })),
    Keep: answer("Untouched top-level value"),
  }, { iris: { Visits: iri("Visits"), Keep: iri("Keep") } });
}

// These journeys use only the first user and no external terminology service.
export async function nestedMetadataJourney(args) {
  const { page, pass } = args;
  const fixture = await nestedFixture(args, "nested repeated editing"), expected = (await fixture.read()).body;
  await opened(page, fixture);
  await occurrence(pagers(page).nth(0), 2);
  await occurrence(pagers(page).nth(1), 2);
  await occurrence(pagers(page).nth(2), 3);
  assert.equal(await input(page, "Codes").inputValue(), "V2S2C3");
  await input(page, "Codes").fill("Revised nested code");
  await input(page, "Detail").fill("Revised nested detail");
  expected.Visits[1].Specimens[1].Codes[2] = answer("Revised nested code");
  expected.Visits[1].Specimens[1].Detail = answer("Revised nested detail");
  await occurrence(pagers(page).nth(0), 1);
  assert.equal(await input(page, "VisitName").inputValue(), "Visit 1");
  await saved(args);
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  await occurrence(pagers(page).nth(0), 2);
  await occurrence(pagers(page).nth(1), 2);
  await occurrence(pagers(page).nth(2), 3);
  assert.equal(await input(page, "Codes").inputValue(), "Revised nested code");
  assert.equal(await input(page, "Detail").inputValue(), "Revised nested detail");
  pass("nested-occurrence-identity", "Editing a repeated field inside two repeated element levels preserves every other answer and every stored element identity across navigation, save and reopen");
}

const withoutIds = value => Array.isArray(value) ? value.map(withoutIds) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "@id").map(([key, item]) => [key, withoutIds(item)])) : value;
function elementIds(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (value["@context"] && value["@id"]) result.push(value["@id"]);
  for (const child of Object.values(value)) elementIds(child, result);
  return result;
}

export async function clonedElementJourney(args) {
  const { page, pass } = args;
  const fixture = await nestedFixture(args, "cloned repeated elements"), before = (await fixture.read()).body;
  await opened(page, fixture);
  await pagers(page).nth(0).getByRole("button", { name: "Add copy of this instance", exact: true }).click();
  await pagers(page).nth(0).getByRole("option", { name: "2", exact: true, selected: true }).waitFor();
  await input(page, "VisitName").fill("Independent copied visit");
  await occurrence(pagers(page).nth(1), 2);
  await input(page, "Detail").fill("Changed only in copied specimen");
  await saved(args);
  const after = (await fixture.read()).body;
  assert.equal(after.Visits.length, 3);
  assert.deepEqual(after.Visits[0], before.Visits[0]);
  assert.deepEqual(after.Visits[2], before.Visits[1]);
  const copy = structuredClone(before.Visits[0]);
  copy.VisitName = answer("Independent copied visit");
  copy.Specimens[1].Detail = answer("Changed only in copied specimen");
  assert.deepEqual(withoutIds(after.Visits[1]), withoutIds(copy));
  const originalIds = new Set(elementIds(before.Visits));
  const copiedIds = elementIds(after.Visits[1]);
  assert.equal(copiedIds.length, 3, "The copied visit and both specimens receive identities");
  assert.equal(new Set(copiedIds).size, copiedIds.length);
  assert.ok(copiedIds.every(id => !originalIds.has(id)), "Copied elements must not reuse source identities");
  assert.deepEqual(comparable({ ...after, Visits: before.Visits }), comparable(before));
  await opened(page, fixture);
  await occurrence(pagers(page).nth(0), 2);
  assert.equal(await input(page, "VisitName").inputValue(), "Independent copied visit");
  await occurrence(pagers(page).nth(1), 2);
  assert.equal(await input(page, "Detail").inputValue(), "Changed only in copied specimen");
  pass("independent-element-copy", "Copying a populated repeated element creates independent identities throughout its nested subtree, allows independent edits and reopens without changing either neighboring occurrence");
}

export async function boundedRepeatedJourney(args) {
  const { page, pass } = args;
  const fixture = await metadataFixture(args, "bounded repeat", {
    Notes: { type: "array", minItems: 1, maxItems: 3, items: textField("Notes") }, Keep: textField("Keep"),
  }, { Notes: [answer("First"), answer("Second")], Keep: answer("Preserved") });
  const expected = (await fixture.read()).body;
  await opened(page, fixture);
  const pager = pagers(page), add = pager.getByRole("button", { name: "Add empty instance here", exact: true }),
    copy = pager.getByRole("button", { name: "Add copy of this instance", exact: true });
  await occurrence(pager, 2);
  await add.click();
  await input(page, "Notes").fill("Third at capacity");
  assert.equal(await add.isDisabled(), true);
  assert.equal(await copy.isDisabled(), true);
  await saved(args);
  expected.Notes.push(answer("Third at capacity"));
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  assert.equal(await add.isDisabled(), true);
  await occurrence(pager, 2);
  await pager.getByRole("button", { name: "Delete current", exact: true }).click();
  assert.equal(await add.isEnabled(), true);
  await occurrence(pager, 1);
  await add.click();
  await input(page, "Notes").fill("Replacement middle");
  await saved(args);
  expected.Notes[1] = answer("Replacement middle");
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  await occurrence(pager, 2);
  assert.equal(await input(page, "Notes").inputValue(), "Replacement middle");
  assert.equal(await add.isDisabled(), true);
  pass("capacity-delete-insert", "A repeated field enforces its maximum, restores capacity after deletion, and inserts a replacement between preserved neighbors through two save/reopen cycles");
}

export async function duplicateNestedLabelsJourney(args) {
  const { page, pass } = args;
  const fields = Object.fromEntries(["Primary", "Secondary"].map(key => {
    const element = artifactBody("element", key);
    child(element, "Notes", textField("Notes"));
    return [key, element];
  }));
  const fixture = await metadataFixture(args, "duplicate nested labels", fields, {
    Primary: elementValue({ Notes: answer("Primary original") }),
    Secondary: elementValue({ Notes: answer("Secondary original") }),
  });
  const expected = (await fixture.read()).body;
  await opened(page, fixture);
  const notes = input(page, "Notes");
  assert.equal(await notes.count(), 2);
  assert.equal(await notes.nth(0).inputValue(), "Primary original");
  assert.equal(await notes.nth(1).inputValue(), "Secondary original");
  await notes.nth(1).fill("Secondary revised");
  await notes.nth(0).fill("Primary revised");
  await saved(args);
  expected.Primary.Notes = answer("Primary revised");
  expected.Secondary.Notes = answer("Secondary revised");
  assert.deepEqual(comparable((await fixture.read()).body), comparable(expected));
  await opened(page, fixture);
  assert.equal(await notes.nth(0).inputValue(), "Primary revised");
  assert.equal(await notes.nth(1).inputValue(), "Secondary revised");
  const ids = await notes.evaluateAll(nodes => nodes.map(node => node.id));
  assert.equal(new Set(ids).size, 2, "Identically labelled controls need distinct accessible identities");
  pass("nested-label-binding", "Identically labelled fields in sibling elements keep distinct control identities and save each answer under its own parent without changing element identities");
}

export async function clearOptionalMetadataJourney(args) {
  const { page, pass } = args;
  const fixture = await metadataFixture(args, "clear optional answers", {
    Notes: textField("Notes"), Count: numericField("Count"), Keep: textField("Keep"),
  }, { Notes: answer("Remove this text"), Count: { "@value": "12.50", "@type": "xsd:decimal" }, Keep: answer("Keep this answer") });
  const before = (await fixture.read()).body;
  await opened(page, fixture);
  await input(page, "Notes").fill("");
  await input(page, "Count").fill("");
  await saved(args);
  const after = (await fixture.read()).body;
  assert.equal(after.Notes["@value"], null, "Cleared optional text stores no previous answer");
  assert.equal(after.Count["@value"], null, "Cleared optional number stores no previous answer");
  assert.deepEqual(comparable({ ...after, Notes: before.Notes, Count: before.Count }), comparable(before));
  await opened(page, fixture);
  assert.equal(await input(page, "Notes").inputValue(), "");
  assert.equal(await input(page, "Count").inputValue(), "");
  await input(page, "Count").fill("0");
  await saved(args);
  const zero = (await fixture.read()).body;
  assert.equal(zero.Count["@value"], "0", "Zero is an answer rather than an empty field");
  assert.deepEqual(zero.Notes, after.Notes);
  await opened(page, fixture);
  assert.equal(await input(page, "Count").inputValue(), "0");
  pass("empty-versus-zero", "Clearing optional text and numbers removes their stored answers, while a subsequent numeric zero survives save and reopen as a real answer");
}

export async function attributeEditingJourney(args) {
  const { page, base, user, name, created, pass } = args;
  const folder = await journeyFolder(args, "attribute editing");
  const template = artifactBody("template", name + " attributes");
  const field = textField("Attributes", "attribute-value");
  field.type = "string";
  delete field.properties; delete field.required; delete field._valueConstraints;
  child(template, "Attributes", repeat(field, 4));
  template.required = template.required.filter(key => key !== "Attributes");
  child(template, "Keep", textField("Keep"));
  template.properties["@context"].additionalProperties = { type: "string", format: "uri" };
  template.additionalProperties = { type: "object", properties: {
    "@value": { type: ["string", "null"] }, "@type": { type: "string", format: "uri" },
  }, required: ["@value"], additionalProperties: false };
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folder), body);
    assert.equal(result.status, 201, result.text);
    created.push({ collection, id: result.body["@id"] });
    return result.body["@id"];
  }
  const templateId = await create("templates", template);
  const instance = artifactBody("instance", name + " attribute values", {
    "schema:isBasedOn": templateId, Attributes: [], Keep: answer("Keep unchanged"),
  });
  instance["@context"].Attributes = iri("Attributes");
  instance["@context"].Keep = iri("Keep");
  instance["@context"]["pav:derivedFrom"] = { "@type": "@id" };
  const id = await create("template-instances", instance);
  const fixture = { url: base + "/instances/edit/" + enc(id), read: () => call(user.auth, "GET", "/template-instances/" + enc(id)) };
  const before = (await fixture.read()).body;
  await opened(page, fixture);
  const pager = pagers(page);
  await pager.getByRole("button", { name: "Add empty instance here", exact: true }).click();
  await input(page, "Attribute Name").fill("colour");
  await input(page, "Attribute Value").fill("blue");
  await pager.getByRole("button", { name: "Add copy of this instance", exact: true }).click();
  assert.equal(await input(page, "Attribute Name").inputValue(), "colour copy");
  await input(page, "Attribute Name").fill("texture");
  await input(page, "Attribute Value").fill("smooth");
  await saved(args);
  const after = (await fixture.read()).body;
  assert.deepEqual(after.Attributes, ["colour", "texture"]);
  assert.equal(after.colour["@value"], "blue");
  assert.equal(after.texture["@value"], "smooth");
  assert.equal(after["colour copy"], undefined);
  assert.equal(after["@context"]["colour copy"], undefined, "Renaming an attribute must not leave its old context term");
  assert.deepEqual(after.Keep, before.Keep);
  await opened(page, fixture);
  assert.equal(await input(page, "Attribute Name").inputValue(), "colour");
  await occurrence(pager, 2);
  assert.equal(await input(page, "Attribute Name").inputValue(), "texture");
  assert.equal(await input(page, "Attribute Value").inputValue(), "smooth");
  await input(page, "Attribute Name").fill("surface");
  await saved(args);
  const renamed = (await fixture.read()).body;
  assert.deepEqual(renamed.Attributes, ["colour", "surface"]);
  assert.equal(renamed.surface["@value"], "smooth");
  assert.equal(renamed.texture, undefined);
  assert.equal(renamed["@context"].texture, undefined);
  assert.deepEqual(renamed.colour, after.colour);
  pass("attribute-copy-rename", "Adding, copying and renaming attribute-value answers survives real server validation and reopen, preserves the source and removes obsolete values and context terms");
}
