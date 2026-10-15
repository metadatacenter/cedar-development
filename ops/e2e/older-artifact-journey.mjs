import assert from "node:assert/strict";
import { artifactBody, call, enc, RESOURCE } from "./rest/lib.mjs";

function addField(container, key) {
  container.properties[key] = artifactBody("field", key);
  container.properties["@context"].properties[key] = {enum: ["https://example.org/older/" + key]};
  container._ui.order.push(key);
  container._ui.propertyLabels[key] = key;
  container._ui.propertyDescriptions[key] = "Original " + key + " placement";
  container.required.push(key);
}
function comparable(artifact) {
  const result = structuredClone(artifact);
  delete result["pav:lastUpdatedOn"];
  delete result["oslc:modifiedBy"];
  return result;
}

// These REST seed fixtures retain older schema shapes: an array-capable @type,
// explicit false constraints, and no generated @language/annotation schemas.
// Do not normalize them through a component save before taking the baseline.
export async function olderArtifactJourney({page, base, designer, user, folderId, name, created, write, pass}) {
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body["@id"];
  }
  async function read(path) {
    const result = await call(user.auth, "GET", path);
    assert.equal(result.status, 200, result.text);
    return result.body;
  }
  let templateId;
  for (const [kind, collection] of [["template", "templates"], ["element", "template-elements"], ["field", "template-fields"]]) {
    const source = artifactBody(kind, name + " older " + kind);
    source._annotations = {"https://example.org/older/note": {"@value": "Preserved annotation"}};
    source["schema:identifier"] = "older-journey-" + kind;
    if (kind !== "field") {
      addField(source, "Notes");
      addField(source, "Keep");
    }
    const id = await create(collection, source);
    if (kind === "template") templateId = id;
    const path = "/" + collection + "/" + enc(id);
    const before = await read(path);
    await page.goto(designer + "/" + kind + "s/edit/" + enc(id));
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
    const description = page.getByPlaceholder(kind === "field" ? "Field description" : "Add description...", {exact: true}).first();
    for (const suffix of ["first", "second"]) {
      const value = "Older " + kind + " description " + suffix;
      await description.fill(value);
      await write(page, "PUT", "/" + collection + "/", () => page.locator("#save").click(), 200, true);
      await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
      assert.deepEqual(comparable(await read(path)), comparable({...before, "schema:description": value}),
        "editing a description must not normalize unrelated older schema content");
    }
    await page.reload();
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
    assert.equal(await description.inputValue(), "Older " + kind + " description second");
    pass(`Older ${kind} survives two description saves and reopening without changing other schema details, constraints or identities`);
  }

  const instance = artifactBody("instance", name + " older metadata", {
    "schema:isBasedOn": templateId,
    Notes: {"@value": "Old answer", "@type": "xsd:string"},
    Keep: {"@value": "Untouched answer", "@type": "xsd:string"},
  });
  instance["@context"].Notes = "https://example.org/older/Notes";
  instance["@context"].Keep = "https://example.org/older/Keep";
  const instanceId = await create("template-instances", instance);
  const instancePath = "/template-instances/" + enc(instanceId);
  const before = await read(instancePath);
  await page.goto(base + "/instances/edit/" + enc(instanceId));
  await page.locator("cedar-embeddable-editor").getByLabel("Notes", {exact: true}).waitFor();
  await page.locator("#instance-name").fill(name + " renamed older metadata");
  await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  const expected = {...before, "schema:name": name + " renamed older metadata"};
  // CEE supplies this standard context declaration even when the older instance
  // omitted it. It adds no value or identity and does not replace existing terms.
  expected["@context"] = {...before["@context"], "pav:derivedFrom": {"@type": "@id"}};
  assert.deepEqual(comparable(await read(instancePath)), comparable(expected));
  await page.reload();
  const notes = page.locator("cedar-embeddable-editor").getByLabel("Notes", {exact: true});
  await notes.waitFor();
  assert.equal(await notes.inputValue(), "Old answer");
  assert.equal(await page.locator("cedar-embeddable-editor").getByLabel("Keep", {exact: true}).inputValue(), "Untouched answer");
  pass("Editor renames and reopens older metadata without losing typed values, identity or existing context declarations");

  // Simulate a historical unreadable representation at the GET boundary. Do
  // not corrupt storage merely to test whether opening it enables a write.
  const templatePath = "/templates/" + enc(templateId);
  const intact = await read(templatePath);
  const unreadable = structuredClone(intact);
  unreadable.properties.Notes._ui.inputType = "unsupported-historical-input";
  const matcher = url => url.origin === new URL(RESOURCE).origin && url.pathname.startsWith("/templates/") &&
    decodeURIComponent(url.pathname.split("/").at(-1)).split("/").at(-1) === templateId.split("/").at(-1);
  const serveUnreadable = async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({response, json: unreadable});
  };
  const writes = [];
  const observe = request => {
    if (new URL(request.url()).origin === new URL(RESOURCE).origin &&
      ["POST", "PUT", "DELETE"].includes(request.method())) writes.push(request.url());
  };
  await page.route(matcher, serveUnreadable);
  page.on("request", observe);
  try {
    await page.goto(designer + "/templates/edit/" + enc(templateId));
    await page.locator("#state").filter({hasText: /Unable to load/}).waitFor();
    assert.equal(await page.locator("#save").isDisabled(), true);
    assert.match(await page.locator("#message").innerText(), /cannot|could not|unable|read/i);
    assert.equal(await page.locator("#editor").isVisible(), false);
    assert.deepEqual(writes, [], "an unreadable document must not trigger an artifact write");
    assert.deepEqual(await read(templatePath), intact);
  } finally {
    page.off("request", observe);
    await page.unroute(matcher, serveUnreadable);
  }
  await page.goto(designer + "/templates/edit/" + enc(templateId));
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  pass("Designer refuses an unsupported historical input shape without enabling save or changing stored content, and reopens a readable response");
}
