import assert from "node:assert/strict";
import { actors, call, mutate, enc } from "./rest/lib.mjs";
import { recoveryFixture, settled } from "./recovery-boundary-journey.mjs";
import { comparable } from "./metadata-journey-fixtures.mjs";

// The journey logs out and signs in as each test user in turn, in a browser context of its own, so
// it belongs in the identity lane. A logout ends that context's single sign-on session, which is
// why no other journey may share the context.
export async function accountSwitchJourney(args) {
  const { base, user, pass } = args,
    { user2 } = await actors();
  const context = await args.page
    .context()
    .browser()
    .newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1500, height: 1000 },
    });
  context.setDefaultTimeout(25000);
  const page = await context.newPage(),
    errors = [];
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (error) => errors.push(error.message));
  async function login(number, logout = true) {
    await page.goto(base + (logout ? "/logout" : "/dashboard"));
    await page.locator("#username").waitFor();
    await page
      .locator("#username")
      .fill(
        process.env[`CEDAR_FRONTEND_local_USER${number}_LOGIN`] ||
          `test${number}@test.com`,
      );
    await page
      .locator("#password")
      .fill(
        process.env[`CEDAR_FRONTEND_local_USER${number}_PASSWORD`] ||
          `test${number}`,
      );
    await page.locator("#kc-login").click();
    await page.getByRole("button", { name: "New", exact: true }).waitFor();
  }
  async function grant(path, role) {
    const r = await mutate(user.auth, "PUT", path + "/permissions", {
      owner: { "@id": user.profile["@id"] },
      userPermissions: [{ user: { "@id": user2.profile["@id"] }, role }],
      groupPermissions: [],
    });
    assert.equal(r.status, 200, r.text);
  }
  try {
    await login(1, false);
    for (const kind of ["template", "metadata"]) {
      const f = await recoveryFixture(
        { ...args, page },
        kind,
        "actual account switch",
      );
      // Each host retains a draft in the step that marks its page Modified, so the journey waits for
      // that status before it leaves the page.
      const modified = () =>
        page
          .locator(f.metadata ? ".metadata-toolbar [role=status]" : "#state")
          .filter({ hasText: /^Modified$/ })
          .waitFor();
      if (f.templateId)
        await grant("/templates/" + enc(f.templateId), "viewer");
      await grant(f.path, "editor");
      const before = (await call(user.auth, "GET", f.path)).body;
      let writes = 0;
      const count = (r) => {
        if (r.method() === "PUT" && f.matcher(new URL(r.url()))) writes++;
      };
      page.on("request", count);
      await f.input(page).fill("Owner retained work");
      await modified();
      await login(2);
      await page.goto(f.url);
      await f.ready(page);
      assert.equal(
        await page
          .getByRole("button", { name: "Restore draft", exact: true })
          .isVisible(),
        false,
      );
      assert.notEqual(await f.input(page).inputValue(), "Owner retained work");
      await f.input(page).fill("Collaborator retained work");
      await modified();
      await login(1);
      await page.goto(f.url);
      await page
        .getByRole("button", { name: "Restore draft", exact: true })
        .click();
      await f.ready(page);
      await settled(f.input(page), "Owner retained work");
      await grant(f.path, "viewer");
      await login(2);
      await page.goto(f.url);
      await page
        .getByRole("button", { name: "Restore draft", exact: true })
        .click();
      await page.waitForFunction(
        ({ selector }) =>
          JSON.stringify(
            document.querySelector(selector)?.captureDraft?.(),
          )?.includes("Collaborator retained work"),
        {
          selector: f.metadata
            ? "cedar-embeddable-editor"
            : "cedar-embeddable-designer",
        },
      );
      assert.ok(
        !(await f.save(page).count()) || (await f.save(page).isDisabled()),
        "old editor permission cannot survive a new login",
      );
      assert.equal(writes, 0);
      assert.deepEqual((await call(user.auth, "GET", f.path)).body, before);
      const recheck = page.getByRole("button", {
        name: "Recheck access",
        exact: true,
      });
      await recheck.click();
      await page
        .getByText(/do not currently have permission to update/)
        .waitFor();
      assert.equal(writes, 0);
      await grant(f.path, "editor");
      await recheck.click();
      await recheck.waitFor({ state: "hidden" });
      await f.ready(page);
      await settled(f.input(page), "Collaborator retained work");
      await args.write(
        page,
        "PUT",
        "/" + f.collection + "/",
        () => f.save(page).click(),
        200,
        true,
      );
      await page
        .locator(f.metadata ? ".metadata-save-status" : "#state")
        .filter({ hasText: /^Saved$/ })
        .waitFor();
      assert.equal(writes, 1);
      const expected = structuredClone(before);
      if (f.metadata) expected.Notes["@value"] = "Collaborator retained work";
      else expected["schema:description"] = "Collaborator retained work";
      assert.deepEqual(
        comparable((await call(user.auth, "GET", f.path)).body),
        comparable(expected),
      );
      await page.reload();
      await f.ready(page);
      await settled(f.input(page), "Collaborator retained work");
      page.off("request", count);
      pass(
        `${kind}: real same-tab logout keeps each account's draft separate, refreshes reduced permissions on return and saves only after a new access grant`,
      );
      await login(1);
    }
    assert.deepEqual(errors, [], "uncaught account-switch browser errors");
  } catch (error) {
    console.error(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    throw error;
  } finally {
    await context.close();
  }
}
