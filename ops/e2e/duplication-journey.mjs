import {journeyFolder, listedIn} from "./journey-fixtures.mjs";
import {editorStatus} from "./metadata-journey-fixtures.mjs";
import assert from "node:assert/strict";
import {artifactBody, call, enc} from "./rest/lib.mjs";

// A copy is an independent artifact with derivation provenance, not another
// version of its source. Exercise the menu and both editing directions.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function duplicationJourney({page, base, designer, user, folderId, name, created, write, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "copies");
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body["@id"];
  }
  async function read(collection, id) {
    const result = await call(user.auth, "GET", "/" + collection + "/" + enc(id));
    assert.equal(result.status, 200, result.text);
    return result.body;
  }
  function add(parent, key, child) {
    parent.properties[key] = child;
    parent.properties["@context"].properties[key] = {enum: ["https://example.org/copy/" + key]};
    parent._ui.order.push(key);
    parent._ui.propertyLabels[key] = key;
    parent.required.push(key);
  }
  function content(body) {
    const copy = structuredClone(body);
    for (const key of ["@id", "schema:name", "schema:identifier", "pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn",
      "oslc:modifiedBy", "pav:derivedFrom", "pav:previousVersion", "pav:version", "bibo:status"]) delete copy[key];
    return copy;
  }
  function copiedContent(body) {
    const copy = content(body);
    const visit = node => {
      if (!node || typeof node !== "object") return;
      // Creation timestamps are regenerated on embedded schema nodes as well
      // as the root when the server creates a derived artifact.
      if (["TemplateElement", "TemplateField"].some(kind => node["@type"] === "https://schema.metadatacenter.org/core/" + kind)) {
        delete node["pav:createdOn"]; delete node["pav:lastUpdatedOn"];
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(copy);
    return copy;
  }
  async function listed(artifactName) {
    const row = page.locator("tbody tr").filter({has: page.getByRole("link", {name: artifactName, exact: true})});
    return listedIn(page, base, folderId, row, "Copy source " + artifactName, 15);
  }
  async function edit(kind, collection, id, value) {
    if (kind === "instance") {
      await page.goto(base + "/instances/edit/" + enc(id));
      const notes = page.locator("cedar-embeddable-editor").getByLabel("Notes", {exact: true});
      await editorStatus(page, /^Unmodified$/).waitFor();
      await notes.fill(value);
      await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 200, true);
      await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
      await page.reload();
      await editorStatus(page, /^Unmodified$/).waitFor();
      await notes.waitFor();
      assert.equal(await notes.inputValue(), value);
    } else {
      await page.goto(designer + "/" + kind + "s/edit/" + enc(id));
      await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
      if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
      const description = page.getByPlaceholder(kind === "field" ? "Field description" : "Add description...", {exact: true}).first();
      await description.fill(value);
      await write(page, "PUT", "/" + collection + "/", () => page.locator("#save").click(), 200, true);
      await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
      await page.reload();
      await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
      if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
      assert.equal(await description.inputValue(), value);
    }
  }
  for (const [kind, collection] of [["template", "templates"], ["element", "template-elements"], ["field", "template-fields"], ["instance", "template-instances"]]) {
    const sourceName = name + " copy source " + kind;
    let body = artifactBody(kind, sourceName);
    if (kind === "template" || kind === "element") {
      const nested = artifactBody("element", "Nested");
      add(nested, "Notes", artifactBody("field", "Notes"));
      add(body, "Nested", nested);
    }
    if (kind === "instance") {
      const template = artifactBody("template", name + " metadata copy template");
      add(template, "Notes", artifactBody("field", "Notes"));
      add(template, "Keep", artifactBody("field", "Keep"));
      const templateId = await create("templates", template);
      body["schema:isBasedOn"] = templateId;
      body.Notes = {"@value": "Original answer", "@type": "xsd:string"};
      body.Keep = {"@value": "Untouched typed answer", "@type": "xsd:string"};
      body["@context"].Notes = "https://example.org/copy/Notes";
      body["@context"].Keep = "https://example.org/copy/Keep";
      body["@context"]["pav:derivedFrom"] = {"@type": "@id"};
    } else {
      body["schema:identifier"] = "original-only-identifier";
      body._annotations = {"https://example.org/copy/note": {"@value": "Preserve this annotation"}};
    }
    const sourceId = await create(collection, body);
    const source = await read(collection, sourceId);
    const row = await listed(sourceName);
    await row.getByRole("button", {name: "Actions for " + sourceName, exact: true}).click();
    await page.locator(".resource-menu").getByRole("button", {name: "Copy", exact: true}).click();
    const dialog = page.locator("dialog[open]");
    const copyName = name + " independent " + kind;
    await dialog.getByLabel("Name of copy", {exact: true}).fill(copyName);
    // Capture the response directly so both the standalone runner and the main
    // context-level response observer can register the actual collection.
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/command/copy-artifact-to-folder"),
      dialog.getByRole("button", {name: "Save", exact: true}).click(),
    ]);
    assert.equal(response.status(), 201, await response.text());
    const copyId = (await response.json())["@id"];
    assert.ok(copyId && copyId !== sourceId);
    if (!created.some(item => item.id === copyId)) created.push({collection, id: copyId});
    await dialog.waitFor({state: "hidden"});
    const copied = await read(collection, copyId);
    assert.equal(copied["schema:name"], copyName);
    assert.equal(copied["pav:derivedFrom"], sourceId);
    const expectedCopy = structuredClone(source);
    if (kind !== "instance") {
      expectedCopy.title = source.title.replace(sourceName, copyName);
      expectedCopy.description = source.description.replace(sourceName, copyName);
    }
    assert.deepEqual(copiedContent(copied), copiedContent(expectedCopy), "copy must preserve content apart from its name-derived schema text and creation provenance");
    assert.deepEqual(await read(collection, sourceId), source, "copying must not modify its source");
    if (kind !== "instance") {
      assert.equal(copied["bibo:status"], "bibo:draft");
      assert.equal(copied["pav:version"], "0.0.1");
      assert.equal(copied["pav:previousVersion"], undefined);
      assert.equal(copied["schema:identifier"], undefined);
    } else assert.equal(copied["schema:isBasedOn"], source["schema:isBasedOn"]);
    await edit(kind, collection, copyId, "Edited only in the copy");
    assert.deepEqual(await read(collection, sourceId), source);
    const editedCopy = await read(collection, copyId);
    // A text field that the author edits serializes as @value; the untouched
    // typed Keep answer must retain its original representation.
    assert.deepEqual(content(editedCopy), content(kind === "instance"
      ? {...copied, Notes: {"@value": "Edited only in the copy"}}
      : {...copied, "schema:description": "Edited only in the copy"}));
    await edit(kind, collection, sourceId, "Edited only in the original");
    assert.deepEqual(await read(collection, copyId), editedCopy);
    pass(`Workspace copies ${kind} with independent identity and preserved content; both original and copy edit and reopen without changing each other`);
  }
}
