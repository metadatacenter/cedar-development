import assert from "node:assert/strict";
import { call } from "./rest/lib.mjs";
import { recoveryFixture, settled } from "./recovery-boundary-journey.mjs";
import { comparable } from "./metadata-journey-fixtures.mjs";

// The report is injected at the HTTP boundary; restoration, controls and the
// corrected conditional write all use the running application and real store.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function restoredValidationJourney(args) {
  const { page, user, write, pass } = args;
  for (const kind of ["template", "element", "field", "metadata"]) {
    const f = await recoveryFixture(args, kind, "restored validation");
    const before = (await call(user.auth, "GET", f.path)).body;
    await f.input(page).fill("Rejected draft");
    const message = "Review this retained draft",
      location = f.metadata ? "/Notes/@value" : "/schema:description";
    const refuse = (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 400,
            json: {
              message: "Validation failed",
              objects: {
                validationReport: {
                  errors: [{ location, message }],
                  warnings: [],
                },
              },
            },
          })
        : route.fallback();
    await page.route(f.matcher, refuse);
    try {
      await write(
        page,
        "PUT",
        "/" + f.collection + "/",
        () => f.save(page).click(),
        400,
        true,
      );
      const issues = f.metadata
        ? page.getByLabel("Metadata errors", { exact: true })
        : page.locator("#server-issues");
      await issues.waitFor();
      await page.reload();
      await page
        .getByRole("button", { name: "Restore draft", exact: true })
        .click();
      await f.ready(page);
      await settled(f.input(page), "Rejected draft");
      await issues.waitFor();
      assert.equal(await f.save(page).isDisabled(), true);
      await issues.locator("summary").click();
      await issues.getByRole("button", { name: new RegExp(message) }).click();
      assert.equal(await f.input(page).inputValue(), "Rejected draft");
      assert.deepEqual((await call(user.auth, "GET", f.path)).body, before);
    } finally {
      await page.unroute(f.matcher, refuse);
    }
    await f.input(page).fill("Corrected restored draft");
    await write(
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
    const expected = structuredClone(before);
    if (f.metadata) expected.Notes["@value"] = "Corrected restored draft";
    else expected["schema:description"] = "Corrected restored draft";
    assert.deepEqual(
      comparable((await call(user.auth, "GET", f.path)).body),
      comparable(expected),
    );
    await page.reload();
    await f.ready(page);
    await settled(f.input(page), "Corrected restored draft");
    pass(`validation-${kind}`,
      `${kind}: server findings survive draft restoration, block an unchanged retry, locate the rejected control and clear on correction before an exact save/reopen`,
    );
  }
}
