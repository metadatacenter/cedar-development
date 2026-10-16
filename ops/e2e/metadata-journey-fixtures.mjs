import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";

export const comparable = (body) => {
  const copy = structuredClone(body);
  delete copy["pav:lastUpdatedOn"];
  delete copy["oslc:modifiedBy"];
  return copy;
};
export async function metadataFixture(args, suffix, fields, values) {
  const { user, name, created } = args,
    folderId = await journeyFolder(args, suffix);
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
  const template = artifactBody("template", name + " " + suffix);
  for (const [key, definition] of Object.entries(fields)) {
    template.properties[key] = definition;
    template.properties["@context"].properties[key] = {
      enum: ["https://example.org/journey/" + key],
    };
    template._ui.order.push(key);
    template._ui.propertyLabels[key] = key;
    template.required.push(key);
  }
  const templateId = await create("templates", template);
  const instance = artifactBody("instance", name + " " + suffix, {
    "schema:isBasedOn": templateId,
    ...values,
  });
  for (const key of Object.keys(fields))
    instance["@context"][key] = "https://example.org/journey/" + key;
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
export function numericField(name, type = "xsd:decimal") {
  const field = artifactBody("field", name);
  field._ui.inputType = "numeric";
  field._valueConstraints = { requiredValue: false, numberType: type };
  field.required = ["@value", "@type"];
  return field;
}
