import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";
const content = value => {
  const copy = structuredClone(value);
  delete copy["pav:lastUpdatedOn"]; delete copy["oslc:modifiedBy"];
  return copy;
};
function add(parent, key, child, repeated = false) {
  parent.properties[key] = repeated ? {type: "array", minItems: 0, items: child} : child;
  parent.properties["@context"].properties[key] = {enum: ["https://example.org/recovery/" + key]};
  parent._ui.order.push(key); parent._ui.propertyLabels[key] = key; parent.required.push(key);
}
// Lose a real committed reply, or prevent the write from reaching the server.
// Recovery reads must distinguish these without replacing the current component.
export async function saveStatusJourney({page, base, designer, user, folderId, name, created, write, pass}) {
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]}); return result.body["@id"];
  }
  for (const kind of ["template", "element", "field", "metadata"]) for (const committed of [false, true]) {
    const metadata = kind === "metadata";
    const collection = metadata ? "template-instances" : {template: "templates", element: "template-elements", field: "template-fields"}[kind];
    let body, templateId;
    if (metadata) {
      const template = artifactBody("template", name + " status template");
      const visits = artifactBody("element", "Visits");
      add(visits, "Detail", artifactBody("field", "Detail"));
      add(template, "Visits", visits, true); add(template, "Notes", artifactBody("field", "Notes"));
      add(template, "Keep", artifactBody("field", "Keep"));
      templateId = await create("templates", template);
      body = artifactBody("instance", name + " status metadata", {"schema:isBasedOn": templateId,
        Notes: {"@value": "Opened"}, Keep: {"@value": "Untouched"},
        Visits: [{"@id": null, "@context": {Detail: "https://example.org/recovery/Detail"}, Detail: {"@value": "Original visit"}}]});
      for (const key of ["Notes", "Keep", "Visits"]) body["@context"][key] = "https://example.org/recovery/" + key;
      body["@context"]["pav:derivedFrom"] = {"@type": "@id"};
    } else body = artifactBody(kind, name + " status " + kind);
    const id = await create(collection, body), path = "/" + collection + "/" + enc(id);
    async function read() {const result = await call(user.auth, "GET", path); assert.equal(result.status, 200, result.text); return result;}
    const before = await read();
    await page.goto((metadata ? base + "/instances/edit/" : designer + "/" + kind + "s/edit/") + enc(id));
    const component = page.locator(metadata ? "cedar-embeddable-editor" : kind === "field" ? "cedar-embeddable-field-designer" : "cedar-embeddable-designer");
    const save = page.locator(metadata ? "#button-save-metadata" : "#save");
    if (!metadata) {
      await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
      if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
    }
    const input = metadata ? component.getByLabel("Notes", {exact: true}) :
      page.getByPlaceholder(kind === "field" ? "Field description" : "Add description...", {exact: true}).first();
    await input.fill("Submitted value");
    if (metadata) {
      await component.getByRole("button", {name: "Add empty instance here", exact: true}).click();
      await component.getByLabel("Detail", {exact: true}).fill("New visit");
    }
    const handle = await component.elementHandle();
    const match = url => url.origin === new URL(RESOURCE).origin && url.pathname.startsWith("/" + collection + "/") &&
      decodeURIComponent(url.pathname.split("/").at(-1)).split("/").at(-1) === id.split("/").at(-1);
    let writes = 0, submitted;
    const lose = async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      writes++; submitted = route.request().postDataJSON();
      if (committed) {const result = await route.fetch(); assert.equal(result.status(), 200, await result.text());}
      await route.abort("failed");
    };
    await page.route(match, lose);
    await save.click();
    const check = page.getByRole("button", {name: "Check save status", exact: true});
    await check.waitFor(); await page.unroute(match, lose);
    assert.equal(writes, 1);
    const afterAttempt = await read();
    if (!committed) assert.deepEqual(afterAttempt.body, before.body);
    else if (!metadata) assert.deepEqual(content(afterAttempt.body), content({...before.body, "schema:description": "Submitted value"}));
    if (metadata) assert.equal(submitted.Visits.length, 2);
    await input.fill("Newer value");
    const unavailable = route => route.request().method() === "GET"
      ? route.fulfill({status: 503, json: {message: "Temporary read failure"}}) : route.fallback();
    await page.route(match, unavailable);
    await check.click();
    await page.getByText(/Save status could not be checked/).waitFor();
    assert.equal(await input.inputValue(), "Newer value"); assert.equal(await save.isDisabled(), true);
    await page.unroute(match, unavailable);
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const delay = async route => {if (route.request().method() !== "GET") return route.fallback(); await gate; await route.continue();};
    await page.route(match, delay);
    try {
      await check.click();
      await page.getByText("Checking save status…", {exact: false}).waitFor();
      await input.fill("Edited during status check");
      release();
      await check.waitFor({state: "hidden"});
      assert.equal(await input.inputValue(), "Edited during status check");
      assert.equal(await handle.evaluate(el => el.isConnected), true);
      assert.equal(await save.isEnabled(), true);
    } finally {release(); await page.unroute(match, delay);}
    await write(page, "PUT", "/" + collection + "/", () => save.click(), 200, true);
    await page.locator(metadata ? ".metadata-save-status" : "#state").filter({hasText: /^Saved$/}).waitFor();
    const after = (await read()).body;
    if (!metadata) assert.deepEqual(content(after), content({...before.body, "schema:description": "Edited during status check"}));
    else {
      assert.equal(after.Notes["@value"], "Edited during status check");
      assert.equal(after.Keep["@value"], "Untouched");
      assert.equal(after.Visits[0]["@id"], before.body.Visits[0]["@id"]);
      assert.equal(after.Visits[1].Detail["@value"], "New visit");
      if (committed) assert.equal(after.Visits[1]["@id"], afterAttempt.body.Visits[1]["@id"]);
      assert.match(after.Visits[1]["@id"], /^https?:\/\//);
    }
    await page.reload();
    if (!metadata) {
      await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
      if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
    }
    await input.waitFor(); assert.equal(await input.inputValue(), "Edited during status check");
    pass(`${kind}: an interrupted ${committed ? "committed" : "uncommitted"} save recovers through an authoritative status check, retains newer edits and safely saves again`);
    if (!committed && ["template", "metadata"].includes(kind)) {
      const beforeLate = await read();
      await input.fill("Late original save");
      await page.route(match, lose); await save.click(); await check.waitFor(); await page.unroute(match, lose);
      await input.fill("Newer retry must survive");
      await check.click(); await check.waitFor({state: "hidden"});
      const late = await call(user.auth, "PUT", path, submitted, {headers: {"If-Match": beforeLate.headers.get("etag")}});
      assert.equal(late.status, 200, late.text);
      await write(page, "PUT", "/" + collection + "/", () => save.click(), 412, true);
      assert.equal(await input.inputValue(), "Newer retry must survive");
      assert.equal(await save.isDisabled(), true);
      const expected = structuredClone(beforeLate.body);
      if (metadata) expected.Notes = {"@value": "Late original save"};
      else expected["schema:description"] = "Late original save";
      assert.deepEqual(content((await read()).body), content(expected));
      pass(`${kind}: a late first commit after an unchanged status check refuses the stale retry and preserves newer local input`);
    }
  }
}
