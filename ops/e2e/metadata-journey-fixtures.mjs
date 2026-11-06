import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";

export const comparable = (body) => {
  const copy = structuredClone(body);
  delete copy["pav:lastUpdatedOn"];
  delete copy["oslc:modifiedBy"];
  return copy;
};
/** Plain text keeps artifact journeys independent of a live terminology provider. */
export function diseaseField() {
  return artifactBody("field", "Disease");
}

/** The fields the full smoke authors in Designer: free-text Notes and Disease. */
export const diseaseFields = () => ({ Notes: artifactBody("field", "Notes"), Disease: diseaseField() });

/**
 * Mints property IRIs for the given fields as Designer mints them. Such an IRI identifies the property
 * without naming the field, so the metadata editor's control that shows it does not match a search
 * for the field's label, as an IRI that names the field would.
 */
const mintedIris = fields =>
  Object.fromEntries(Object.keys(fields).map(key => [key, "https://schema.metadatacenter.org/properties/" + randomUUID()]));

/**
 * Builds a template holding the given fields, each required and identified by a property of its
 * own: the IRI that `iris` gives it, or one that names the field.
 */
export function templateWith(name, fields, iris = {}) {
  const template = artifactBody("template", name);
  for (const [key, definition] of Object.entries(fields)) {
    template.properties[key] = definition;
    template.properties["@context"].properties[key] = {
      enum: [iris[key] ?? "https://example.org/journey/" + key],
    };
    template._ui.order.push(key);
    template._ui.propertyLabels[key] = key;
    template.required.push(key);
  }
  return template;
}

/** Builds a template with the fields the full smoke authors in Designer, identified as Designer identifies them. */
export function diseaseTemplate(name) {
  const fields = diseaseFields();
  return templateWith(name, fields, mintedIris(fields));
}

/**
 * Makes a template and one instance answering its fields, in a folder of the journey's own. Both are
 * named for the journey and the suffix unless `options` names them apart, as a journey that finds
 * each by its row in one listing needs. `options.iris` identifies the fields' properties.
 */
export async function metadataFixture(args, suffix, fields, values, options = {}) {
  const { user, name, created } = args,
    folderId = await journeyFolder(args, suffix);
  const iris = options.iris ?? {};
  async function create(collection, body) {
    const r = await call(
      user.auth,
      "POST",
      "/" + collection + "?folder_id=" + enc(folderId),
      body,
    );
    assert.equal(r.status, 201, r.text);
    created.push({ collection, id: r.body["@id"] });
    return r.body["@id"];
  }
  const template = templateWith(options.template ?? name + " " + suffix, fields, iris);
  const templateId = await create("templates", template);
  const instance = artifactBody("instance", options.instance ?? name + " " + suffix, {
    "schema:isBasedOn": templateId,
    ...values,
  });
  for (const key of Object.keys(fields))
    instance["@context"][key] = iris[key] ?? "https://example.org/journey/" + key;
  instance["@context"]["pav:derivedFrom"] = { "@type": "@id" };
  const id = await create("template-instances", instance),
    path = "/template-instances/" + enc(id);
  async function read() {
    const r = await call(user.auth, "GET", path);
    assert.equal(r.status, 200, r.text);
    return r;
  }
  return {
    id,
    path,
    templateId,
    folderId,
    url: args.base + "/instances/edit/" + enc(id),
    read,
  };
}
/**
 * Makes a template with the fields the full smoke authors in Designer, identified as Designer
 * identifies them, and one record answering both fields, with some notes and influenza as the disease.
 */
export function diseaseRecord(args, suffix, names) {
  const fields = diseaseFields();
  return metadataFixture(args, suffix, fields, { Notes: { "@value": "Opened" }, Disease: { "@value": "influenza" } },
    { ...names, iris: mintedIris(fields) });
}
// The metadata editor's save status. It reads Loading… until the page has loaded the record, and
// the page disregards edits made before then, so a journey waits for a loaded status before it types.
export const editorStatus = (page, text) =>
  page.locator(".metadata-toolbar [role=status]").filter({ hasText: text });

export function numericField(name, type = "xsd:decimal") {
  const field = artifactBody("field", name);
  field._ui.inputType = "numeric";
  field._valueConstraints = { requiredValue: false, numberType: type };
  field.required = ["@value", "@type"];
  return field;
}
