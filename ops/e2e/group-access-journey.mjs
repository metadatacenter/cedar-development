import assert from "node:assert/strict";
import { call, mutate, mutateGroup, enc } from "./rest/lib.mjs";
import { editorStatus } from "./metadata-journey-fixtures.mjs";
import { noteFixture } from "./split-steps.mjs";

// Membership changes happen in the administrator's browser while the member
// keeps an unsaved artifact open. There must be no direct grant masking the loss.
//
// The journey signs nobody in. It works in the reader page it is given, which the caller has signed
// in as the member, and opens the administrator's page in the owner's own browser context.
export async function groupAccessJourney({page, reader, base, designer, owner, member,
  templateId, instancePath, metadataUrl, name, write, pass}) {
  const admin = await page.context().newPage();
  const templatePath = "/templates/" + enc(templateId);
  const originals = new Map();
  const failures = [];
  let groupPath;
  const memberName = [member.profile.firstName, member.profile.lastName].filter(Boolean).join(" ");
  async function groupWrite(method, path, gesture, expected = 200) {
    const [response] = await Promise.all([
      admin.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname === path),
      gesture(),
    ]);
    assert.equal(response.status(), expected, await response.text());
    if (method === "PUT") assert.ok(await response.request().headerValue("if-match"));
    return response.json();
  }
  async function addMember() {
    await admin.getByRole("combobox", {name: "Add a member", exact: true}).fill(memberName);
    await admin.getByRole("option", {name: memberName, exact: true}).click();
    await groupWrite("PUT", groupPath + "/users",
      () => admin.getByRole("button", {name: "Add member", exact: true}).click());
    await admin.getByRole("listitem", {name: memberName, exact: true}).waitFor();
  }
  try {
    await admin.goto(base + "/groups");
    await admin.getByRole("tab", {name: "Create group", exact: true}).click();
    await admin.getByLabel("Group name", {exact: true}).fill(name + " access group");
    const made = await groupWrite("POST", "/groups",
      () => admin.getByRole("button", {name: "Create group", exact: true}).click(), 201);
    groupPath = "/groups/" + enc(made["@id"]);
    // The browser created the group, so the REST helper never noted it. Noted here, it is deleted by
    // the sweep after a kill, and the member's membership ends with it.
    noteFixture({collection: "groups", id: made["@id"], base: "group"});
    await addMember();
    for (const path of [templatePath, instancePath]) {
      const acl = await call(owner.auth, "GET", path + "/permissions");
      assert.equal(acl.status, 200);
      // The GET includes display information that the strict write DTO rejects.
      originals.set(path, {
        owner: {"@id": acl.body.owner["@id"]},
        userPermissions: acl.body.userPermissions.map(({user, role}) => ({user: {"@id": user["@id"]}, role})),
        groupPermissions: acl.body.groupPermissions.map(({group, role}) => ({group: {"@id": group["@id"]}, role})),
      });
      assert.equal((await mutate(owner.auth, "PUT", path + "/permissions", {
        owner: {"@id": owner.profile["@id"]}, userPermissions: [],
        groupPermissions: [{group: {"@id": made["@id"]}, role: "editor"}],
      })).status, 200);
    }
    for (const host of ["Designer", "Editor"]) {
      const designing = host === "Designer";
      const path = designing ? templatePath : instancePath;
      const input = designing
        ? reader.getByPlaceholder("Add description...", {exact: true}).first()
        : reader.locator("cedar-embeddable-editor").getByRole("textbox", {name: /^Notes(?:\s|$)/}).first();
      const save = reader.locator(designing ? "#save" : "#button-save-metadata");
      const status = text => designing ? reader.locator("#state").filter({hasText: text}) : editorStatus(reader, text);
      const reload = designing ? reader.locator("#reload")
        : reader.getByRole("button", {name: "Reload metadata", exact: true});
      await reader.goto(designing ? designer + "/templates/edit/" + enc(templateId) : metadataUrl);
      await input.waitFor();
      // Once the page has loaded, it has decided whether to offer a retained draft.
      await status(/^Unmodified$/).waitFor();
      // This scenario starts from current content. A reader page that earlier work left holding a
      // refused draft offers that draft here, and it is discarded.
      const discard = designing ? reader.locator("#discard-draft")
        : reader.getByRole("button", {name: "Discard recovery draft", exact: true});
      if (await discard.isVisible()) {
        await discard.click();
        if (!designing) await reader.locator("dialog.confirmation-dialog")
          .getByRole("button", {name: "Yes", exact: true}).click();
        await discard.waitFor({state: "hidden"});
      }
      const draft = host + " draft before group membership loss";
      await input.fill(draft);
      await status(/^Modified$/).waitFor();
      assert.equal(await save.isEnabled(), true);
      const before = await call(owner.auth, "GET", path);
      assert.equal(before.status, 200);
      await groupWrite("PUT", groupPath + "/users", () => admin
        .getByRole("listitem", {name: memberName, exact: true})
        .getByRole("button", {name: /^Remove .* from the group$/}).click());
      assert.ok([403, 404].includes((await call(member.auth, "GET", path)).status),
        "removing group membership must remove access, with no direct grant to fall back on");
      if (designing) {
        // Total access loss can refuse the impact check before a PUT is allowed.
        const [denied] = await Promise.all([
          reader.waitForResponse(r => r.status() >= 400 && (
            r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/command/check-update-template/") ||
            r.request().method() === "PUT" && new URL(r.url()).pathname.startsWith("/templates/"))),
          save.click(),
        ]);
        assert.equal(denied.status(), 403);
        if (denied.request().method() === "PUT") assert.ok(await denied.request().headerValue("if-match"));
      } else {
        await write(reader, "PUT", "/template-instances/", () => save.click(), 403, true);
      }
      await reader.waitForFunction(id => document.getElementById(id)?.disabled,
        designing ? "save" : "button-save-metadata");
      assert.equal(await input.inputValue(), draft);
      assert.deepEqual((await call(owner.auth, "GET", path)).body, before.body);
      // Reload asks before discarding the draft, and the answer is settled once the question has closed.
      if (designing) {
        reader.removeAllListeners("dialog");
        const asked = reader.waitForEvent("dialog");
        reader.once("dialog", dialog => dialog.dismiss());
        await reload.click();
        assert.equal((await asked).type(), "confirm");
        reader.on("dialog", dialog => dialog.accept());
      } else {
        await reload.click();
        const confirmation = reader.locator("dialog.confirmation-dialog");
        await confirmation.getByRole("button", {name: "Cancel", exact: true}).click();
        await confirmation.waitFor({state: "hidden"});
      }
      assert.equal(await input.inputValue(), draft, "cancelling reload must preserve the refused draft");
      const recheck = reader.getByRole("button", {name: "Recheck access", exact: true});
      await recheck.click();
      await reader.getByText(/Access could not be checked/).waitFor();
      assert.equal(await input.inputValue(), draft);
      assert.equal(await save.isDisabled(), true);
      // Nothing on the member's page reports a membership change, so count its writes until the
      // explicit recheck has settled. Only the save after that may send the draft again.
      let resent = 0;
      const collection = designing ? "/templates/" : "/template-instances/";
      const countWrites = request => { if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith(collection)) resent++; };
      reader.on("request", countWrites);
      await addMember();
      assert.equal((await call(member.auth, "GET", path)).status, 200);
      assert.equal(await save.isDisabled(), true, "membership restoration must not silently retry a refused save");
      const component = await reader.locator(designing ? "cedar-embeddable-designer" : "cedar-embeddable-editor").elementHandle();
      await recheck.click();
      await recheck.waitFor({state: "hidden"});
      reader.off("request", countWrites);
      assert.equal(resent, 0, "membership restoration must not silently retry a refused save");
      assert.equal(await input.inputValue(), draft, "access recovery must retain the refused draft");
      assert.equal(await component.evaluate(el => el.isConnected), true);
      assert.equal(await save.isEnabled(), true);
      const recovered = draft;
      await write(reader, "PUT", designing ? "/templates/" : "/template-instances/",
        () => save.click(), 200, true);
      await reader.locator(designing ? "#state" : ".metadata-toolbar [role=status]")
        .filter({hasText: /^Saved$/}).waitFor();
      const stored = await call(owner.auth, "GET", path);
      assert.equal(stored.status, 200);
      assert.equal(designing ? stored.body["schema:description"] : stored.body.Notes["@value"], recovered);
      assert.equal(stored.body["@id"], before.body["@id"]);
      pass(`${host} group membership loss refuses save without losing the draft; an explicit access recheck restores saving of that same draft without reload`);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const [path, acl] of originals) {
      try {
        const restored = await mutate(owner.auth, "PUT", path + "/permissions", acl);
        assert.equal(restored.status, 200, restored.text);
      } catch (error) { failures.push(error); }
    }
    if (groupPath) {
      try {
        const result = await mutateGroup(owner.auth, "DELETE", groupPath);
        assert.ok([200, 204, 404].includes(result.status), `group cleanup: ${result.status}`);
      } catch (error) { failures.push(error); }
    }
    await admin.close();
    if (failures.length) throw new AggregateError(failures, "group access journey or cleanup failed");
  }
}
