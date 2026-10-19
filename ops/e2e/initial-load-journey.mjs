import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";

// Break only the test page's reads. The service and stored fixtures stay intact.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function initialLoadJourney({page, base, designer, user, folderId, name, created, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "initial load");
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body["@id"];
  }
  const template = artifactBody("template", name + " load template");
  template.properties.Notes = artifactBody("field", "Notes");
  template.properties["@context"].properties.Notes = {enum: ["https://example.org/load/Notes"]};
  template._ui.order.push("Notes");
  template._ui.propertyLabels.Notes = "Notes";
  template.required.push("Notes");
  const templateId = await create("templates", template);
  const instance = artifactBody("instance", name + " load metadata", {
    "schema:isBasedOn": templateId, Notes: {"@value": "Stored answer"},
  });
  instance["@context"].Notes = "https://example.org/load/Notes";
  const instanceId = await create("template-instances", instance);
  const resourceOrigin = new URL(RESOURCE).origin;
  const uuid = id => id.split("/").at(-1);
  const artifact = (collection, id, suffix = "") => url => url.origin === resourceOrigin &&
    url.pathname.startsWith("/" + collection + "/") && url.pathname.endsWith(suffix) &&
    uuid(decodeURIComponent(url.pathname.slice(0, suffix ? -suffix.length : undefined))) === uuid(id);
  const hostFile = (origin, path) => url => url.origin === new URL(origin).origin && url.pathname === path;
  const cases = [
    ["Designer", "artifact", artifact("templates", templateId)],
    ["Designer", "permissions", artifact("templates", templateId, "/report")],
    ["Designer", "manifest", hostFile(designer, "/components/manifest.json")],
    ["Editor", "metadata", artifact("template-instances", instanceId)],
    ["Editor", "permissions", artifact("template-instances", instanceId, "/report")],
    ["Editor", "template", artifact("templates", templateId)],
    ["Editor", "configuration", hostFile(base, "/config/embeddable-editor-config.json")],
    ["Editor", "component", url => url.origin === new URL(base).origin &&
      /^\/third_party_components\/cedar-embeddable-editor\/cedar-embeddable-editor(?:\.host-fonts)?\.js$/.test(url.pathname)],
  ];
  const stored = [];
  for (const [collection, id] of [["templates", templateId], ["template-instances", instanceId]]) {
    const result = await call(user.auth, "GET", "/" + collection + "/" + enc(id));
    assert.equal(result.status, 200);
    stored.push({path: "/" + collection + "/" + enc(id), body: result.body});
  }
  const writes = [];
  const observe = request => {
    if (new URL(request.url()).origin === resourceOrigin && ["POST", "PUT", "DELETE"].includes(request.method()))
      writes.push(request.method() + " " + request.url());
  };
  page.on("request", observe);
  try {
    for (const [surface, dependency, matcher] of cases) {
      for (const failure of ["503", "connection"]) {
        let intercepted = 0;
        const refuse = async route => {
          if (route.request().method() !== "GET") return route.fallback();
          intercepted++;
          if (failure === "connection") await route.abort("connectionfailed");
          else await route.fulfill({status: 503, contentType: "application/json", body: JSON.stringify({message: "Temporary journey outage"})});
        };
        await page.route(matcher, refuse);
        const isDesigner = surface === "Designer";
        try {
          await page.goto(isDesigner ? designer + "/templates/edit/" + enc(templateId) : base + "/instances/edit/" + enc(instanceId));
          await page.locator(isDesigner ? "#state" : ".metadata-toolbar [role=status]").filter({hasText: /Unable to load/}).waitFor();
          assert.ok(intercepted > 0, dependency + " failure must actually be injected");
          const save = page.locator(isDesigner ? "#save" : "#button-save-metadata");
          assert.ok(!(await save.count()) || await save.isDisabled(), "incomplete loading must not enable Save");
          assert.equal(await page.getByLabel("Notes", {exact: true}).isVisible(), false);
          assert.ok((await page.locator(isDesigner ? "#message" : "p.alert").innerText()).trim());
          assert.deepEqual(writes, [], "loading failures must never write artifacts");
        } finally {
          await page.unroute(matcher, refuse);
        }
        await page.locator(isDesigner ? "#reload" : "p.alert button").click();
        await page.locator(isDesigner ? "#state" : ".metadata-toolbar [role=status]").filter({hasText: /^Unmodified$/}).waitFor();
        assert.equal(await page.locator(isDesigner ? "#save" : "#button-save-metadata").isEnabled(), true);
        if (!isDesigner) {
          const notes = page.getByLabel("Notes", {exact: true});
          await notes.waitFor();
          assert.equal(await notes.inputValue(), "Stored answer");
        }
        pass(`opening-${surface}-${dependency}-${failure}`, `${surface} safely refuses opening when ${dependency} loading fails with ${failure}, then retries without changing stored content`);
      }
    }
    assert.deepEqual(writes, []);
    for (const before of stored) {
      const result = await call(user.auth, "GET", before.path);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, before.body);
    }
  } finally { page.off("request", observe); }
}
