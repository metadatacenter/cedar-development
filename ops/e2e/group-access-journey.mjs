import assert from "node:assert/strict";
import { call, mutate, mutateGroup, enc } from "./rest/lib.mjs";

// Membership changes happen in the administrator's browser while the member
// keeps an unsaved artifact open. There must be no direct grant masking the loss.
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
        : reader.locator("cedar-embeddable-editor").getByLabel("Notes", {exact: false}).first();
      const save = reader.locator(designing ? "#save" : "#button-save-metadata");
      const reload = designing ? reader.locator("#reload")
        : reader.getByRole("button", {name: "Reload metadata", exact: true});
      await reader.goto(designing ? designer + "/templates/edit/" + enc(templateId) : metadataUrl);
      const draft = host + " draft before group membership loss";
      await input.fill(draft);
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
      if (designing) {
        reader.removeAllListeners("dialog");
        reader.once("dialog", dialog => dialog.dismiss());
        await reload.click();
        reader.on("dialog", dialog => dialog.accept());
      } else {
        await reload.click();
        await reader.locator("dialog.confirmation-dialog").getByRole("button", {name: "Cancel", exact: true}).click();
      }
      assert.equal(await input.inputValue(), draft, "cancelling reload must preserve the refused draft");
      await addMember();
      assert.equal((await call(member.auth, "GET", path)).status, 200);
      assert.equal(await save.isDisabled(), true, "membership restoration must not silently retry a refused save");
      await reload.click();
      if (!designing) await reader.locator("dialog.confirmation-dialog").getByRole("button", {name: "Yes", exact: true}).click();
      await reload.waitFor({state: "hidden"});
      await input.waitFor();
      const storedValue = designing ? before.body["schema:description"] : before.body.Notes["@value"];
      assert.equal(await input.inputValue(), storedValue, "explicit reload must return to the stored document");
      const recovered = host + " saved after group membership restoration";
      await input.fill(recovered);
      await write(reader, "PUT", designing ? "/templates/" : "/template-instances/",
        () => save.click(), 200, true);
      await reader.locator(designing ? "#state" : ".metadata-toolbar [role=status]")
        .filter({hasText: /^Saved$/}).waitFor();
      const stored = await call(owner.auth, "GET", path);
      assert.equal(stored.status, 200);
      assert.equal(designing ? stored.body["schema:description"] : stored.body.Notes["@value"], recovered);
      assert.equal(stored.body["@id"], before.body["@id"]);
      pass(`${host} group membership loss refuses save without losing the draft; restored membership allows explicit reload and a new save`);
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
