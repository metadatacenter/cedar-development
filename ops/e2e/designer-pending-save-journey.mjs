import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";

const content = document => {
  const result = structuredClone(document);
  delete result["pav:lastUpdatedOn"];
  delete result["oslc:modifiedBy"];
  return result;
};

// Delay an actual successful PUT reply, not the write itself. Designer's
// existing workflow freezes editing until it acknowledges that snapshot.
export async function designerPendingSaveJourney({page, designer, user, folderId, name, created, write, pass}) {
  for (const [kind, collection] of [["template", "templates"], ["element", "template-elements"], ["field", "template-fields"]]) {
    const source = artifactBody(kind, name + " pending " + kind);
    source._annotations = {"https://example.org/pending/note": {"@value": "Keep annotation"}};
    if (kind !== "field") {
      source.properties.Notes = artifactBody("field", "Notes");
      source.properties["@context"].properties.Notes = {enum: ["https://example.org/pending/Notes"]};
      source._ui.order.push("Notes");
      source._ui.propertyLabels.Notes = "Notes";
      source.required.push("Notes");
    }
    const made = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), source);
    assert.equal(made.status, 201, made.text);
    const id = made.body["@id"];
    created.push({collection, id});
    const path = "/" + collection + "/" + enc(id);
    async function read() {
      const result = await call(user.auth, "GET", path);
      assert.equal(result.status, 200, result.text);
      return result;
    }
    const before = (await read()).body;
    await page.goto(designer + "/" + kind + "s/edit/" + enc(id));
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    const component = await page.locator(kind === "field" ? "cedar-embeddable-field-designer" : "cedar-embeddable-designer").elementHandle();
    if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
    const description = page.getByPlaceholder(kind === "field" ? "Field description" : "Add description...", {exact: true}).first();
    await description.fill("Submitted description");
    const matcher = url => url.origin === new URL(RESOURCE).origin && url.pathname.startsWith("/" + collection + "/") &&
      decodeURIComponent(url.pathname.split("/").at(-1)).split("/").at(-1) === id.split("/").at(-1);
    let release, announce, reject;
    const gate = new Promise(resolve => { release = resolve; });
    const committed = new Promise((resolve, failure) => { announce = resolve; reject = failure; });
    const hold = async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      try {
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        assert.ok(route.request().headers()["if-match"]);
        announce();
        await gate;
        await route.fulfill({response});
      } catch (error) { reject(error); await route.abort(); }
    };
    await page.route(matcher, hold);
    const timeout = setTimeout(() => reject(new Error("No successful save reached the response gate")), 30000);
    try {
      await page.locator("#save").click();
      await committed;
      clearTimeout(timeout);
      await page.locator("#state").filter({hasText: /^Saving/}).waitFor();
      assert.equal(await page.locator("#save").isDisabled(), true);
      assert.deepEqual(content((await read()).body), content({...before, "schema:description": "Submitted description"}));
      assert.equal(await component.evaluate(element => element.inert), true);
      await description.focus();
      assert.equal(await description.evaluate(element => element.getRootNode().activeElement === element), false,
        "an inert designer must not accept focus into an editing control");
      await page.keyboard.type("Input while saving");
      assert.equal(await description.inputValue(), "Submitted description");
      release();
      await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
      assert.equal(await description.inputValue(), "Submitted description");
      assert.equal(await component.evaluate(element => element.isConnected), true, "acknowledgement must retain the open component");
      assert.equal(await component.evaluate(element => element.inert), false);
      assert.equal(await page.locator("#save").isEnabled(), true);
    } finally {
      clearTimeout(timeout);
      release();
      await page.unroute(matcher, hold);
    }
    // Success of this second conditional write also proves acknowledgement
    // adopted the first write's revision rather than reusing the opened ETag.
    await description.fill("Next description after save");
    await page.locator("#state").filter({hasText: /^Modified$/}).waitFor();
    await write(page, "PUT", "/" + collection + "/", () => page.locator("#save").click(), 200, true);
    await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
    assert.deepEqual(content((await read()).body), content({...before, "schema:description": "Next description after save"}));
    await page.reload();
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click();
    assert.equal(await description.inputValue(), "Next description after save");
    pass(`Designer freezes editing during a pending ${kind} save, resumes without replacing the component, and saves the next edit with the new revision`);
  }
}
