import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";

// Supply a server-only finding at the HTTP boundary, then use real components
// and real conditional writes to prove correction and resubmission. This does
// not claim to exercise the server validator that produces the finding.
export async function validationRejectionJourney({page, base, designer, user, folderId, name, created, write, pass}) {
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
  const template = artifactBody("template", name + " validation template");
  const visits = artifactBody("element", "Visits");
  function add(parent, key, child, repeat = false) {
    parent.properties[key] = repeat ? {type: "array", minItems: 0, items: child} : child;
    parent.properties["@context"].properties[key] = {enum: ["https://example.org/validation/" + key]};
    parent._ui.order.push(key);
    parent._ui.propertyLabels[key] = key;
    parent.required.push(key);
  }
  add(visits, "Detail", artifactBody("field", "Detail"));
  add(template, "Visits", visits, true);
  add(template, "Keep", artifactBody("field", "Keep"));
  const templateId = await create("templates", template);
  const matcher = (collection, id) => url => url.origin === new URL(RESOURCE).origin &&
    url.pathname.startsWith("/" + collection + "/") &&
    decodeURIComponent(url.pathname).split("/").at(-1) === id.split("/").at(-1);
  function rejection(location, message) {
    return {status: 400, contentType: "application/json", body: JSON.stringify({
      message: "Validation failed", objects: {validationReport: {errors: [{location, message}], warnings: []}},
    })};
  }
  const templateBefore = await read("templates", templateId);
  await page.goto(designer + "/templates/edit/" + enc(templateId));
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  const description = page.getByPlaceholder("Add description...", {exact: true}).first();
  await description.fill("Rejected description");
  const templateMatch = matcher("templates", templateId);
  const refuseDescription = route => route.request().method() === "PUT"
    ? route.fulfill(rejection("/schema:description", "Review the artifact description")) : route.fallback();
  await page.route(templateMatch, refuseDescription);
  try {
    await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 400, true);
    await page.locator("#server-issues").waitFor();
    await page.locator("#server-issues summary").click();
    assert.match(await page.locator("#server-issues-list").innerText(), /\/schema:description: Review the artifact description/);
    assert.equal(await description.inputValue(), "Rejected description");
    assert.equal(await page.locator("#save").isDisabled(), true);
    assert.deepEqual(await read("templates", templateId), templateBefore);
  } finally { await page.unroute(templateMatch, refuseDescription); }
  await description.fill("Corrected description");
  await page.locator("#server-issues").waitFor({state: "hidden"});
  await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 200, true);
  await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
  assert.equal((await read("templates", templateId))["schema:description"], "Corrected description");
  await page.reload();
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  assert.equal(await description.inputValue(), "Corrected description");
  pass("Designer retains rejected input and displays its server location, then clears the obsolete finding and saves/reopens the correction");

  const instance = artifactBody("instance", name + " validation metadata", {
    "schema:isBasedOn": templateId, Keep: {"@value": "Untouched"},
    Visits: ["First visit", "Second visit"].map(value => ({"@id": null,
      "@context": {Detail: "https://example.org/validation/Detail"}, Detail: {"@value": value}})),
  });
  instance["@context"].Visits = "https://example.org/validation/Visits";
  instance["@context"].Keep = "https://example.org/validation/Keep";
  instance["@context"]["pav:derivedFrom"] = {"@type": "@id"};
  const instanceId = await create("template-instances", instance);
  const before = await read("template-instances", instanceId);
  await page.goto(base + "/instances/edit/" + enc(instanceId));
  const cee = page.locator("cedar-embeddable-editor");
  const detail = cee.getByLabel("Detail", {exact: true});
  await detail.waitFor();
  const pager = cee.locator("app-cedar-multi-pager");
  await pager.getByRole("option", {name: "2", exact: true}).click();
  await detail.fill("Rejected visit");
  await pager.getByRole("option", {name: "1", exact: true}).click();
  const instanceMatch = matcher("template-instances", instanceId);
  const refuseDetail = route => route.request().method() === "PUT"
    ? route.fulfill(rejection("/Visits/1/Detail/@value", "Review this visit detail")) : route.fallback();
  await page.route(instanceMatch, refuseDetail);
  const save = page.locator("#button-save-metadata");
  const issues = page.getByLabel("Metadata errors", {exact: true});
  try {
    await write(page, "PUT", "/template-instances/", () => save.click(), 400, true);
    await issues.waitFor();
    assert.equal(await save.isDisabled(), true);
    assert.deepEqual(await read("template-instances", instanceId), before);
    await issues.locator("summary").click();
    await issues.getByRole("button", {name: /Visits 2.*Detail.*Review this visit detail/}).click();
    await detail.evaluate(el => new Promise((resolve, reject) => {
      const until = Date.now() + 5000;
      const check = () => el.getRootNode().activeElement === el ? resolve() :
        Date.now() > until ? reject(new Error("finding did not focus the affected control")) : setTimeout(check, 20);
      check();
    }));
    assert.equal(await detail.inputValue(), "Rejected visit", "finding must reveal the second occurrence, not the first");
    assert.equal(await cee.getByLabel("Keep", {exact: true}).inputValue(), "Untouched");
  } finally { await page.unroute(instanceMatch, refuseDetail); }
  await detail.fill("Corrected visit");
  await issues.waitFor({state: "detached"});
  await write(page, "PUT", "/template-instances/", () => save.click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  const after = await read("template-instances", instanceId);
  const expected = structuredClone(before);
  expected.Visits[1].Detail["@value"] = "Corrected visit";
  for (const value of [expected, after]) { delete value["pav:lastUpdatedOn"]; delete value["oslc:modifiedBy"]; }
  assert.deepEqual(after, expected);
  await page.reload();
  await detail.waitFor();
  assert.equal(await detail.inputValue(), "First visit");
  await pager.getByRole("option", {name: "2", exact: true}).click();
  assert.equal(await detail.inputValue(), "Corrected visit");
  pass("Editor reveals the rejected repeated-element control, retains all answers and identities, and saves/reopens the correction");
}
