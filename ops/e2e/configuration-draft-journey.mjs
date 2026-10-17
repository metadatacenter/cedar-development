import assert from "node:assert/strict";
import { artifactBody } from "./rest/lib.mjs";
import {
  metadataFixture,
  numericField,
  comparable,
  editorStatus,
} from "./metadata-journey-fixtures.mjs";
import {
  schemaFixture,
  fieldConfiguration,
} from "./repeated-schema-journey.mjs";
import { settled } from "./recovery-boundary-journey.mjs";

// The journey acts as the runner's first test user only and never signs in as another account.
export async function configurationDraftJourney(args) {
  const { page, write, pass } = args;
  for (const kind of ["template", "metadata"])
    for (const fault of ["503", "invalid-json"]) {
      const metadata = kind === "metadata";
      let f;
      if (metadata) {
        const field = numericField("Amount");
        field._valueConstraints.decimalPlace = 1;
        f = await metadataFixture(
          args,
          "unfinished config " + fault,
          { Amount: field, Keep: artifactBody("field", "Keep") },
          {
            Amount: { "@value": "1.2", "@type": "xsd:decimal" },
            Keep: { "@value": "Preserved" },
          },
        );
      } else f = await schemaFixture(args, kind, "unfinished config " + fault);
      const read = async () =>
          metadata ? (await f.read()).body : await f.read(),
        before = await read();
      await page.goto(f.url);
      const amount = page
        .locator("cedar-embeddable-editor")
        .getByLabel("Amount", { exact: true });
      const status = (text) =>
        metadata
          ? editorStatus(page, text)
          : page.locator("#state").filter({ hasText: text });
      await status(/^Unmodified$/).waitFor();
      let settings;
      // The metadata editor retains its draft in the step that marks the page Modified, so the
      // snapshot below waits for that status.
      if (metadata) {
        await amount.fill("1.234");
        await status(/^Modified$/).waitFor();
      } else {
        settings = await fieldConfiguration(page);
        await settings
          .getByRole("checkbox", { name: "Allow multiple", exact: true })
          .check();
        await settings.getByLabel("Minimum", { exact: true }).fill("2");
        await settings.getByLabel("Maximum", { exact: true }).fill("5");
        await settings.getByLabel("Minimum", { exact: true }).fill("8");
        await settings.getByRole("alert").waitFor();
        await status(/^Modified$/).waitFor();
      }
      const save = page.locator(metadata ? "#button-save-metadata" : "#save");
      assert.equal(await save.isDisabled(), true);
      const retained = await page.evaluate(() =>
        Object.entries(sessionStorage).filter(([key]) =>
          key.startsWith("cedar."),
        ),
      );
      const matcher = (url) =>
        url.pathname ===
        (metadata
          ? "/config/embeddable-editor-config.json"
          : "/config/host.json");
      let failures = 0;
      const fail = (route) => {
        failures++;
        return route.fulfill(
          fault === "503"
            ? { status: 503, json: { message: "Configuration unavailable" } }
            : {
                status: 200,
                contentType: "application/json",
                body: "{unfinished",
              },
        );
      };
      await page.route(matcher, fail);
      try {
        await page.reload();
        await page
          .locator(metadata ? ".metadata-toolbar [role=status]" : "#state")
          .filter({ hasText: "Unable to load" })
          .waitFor();
        assert.ok(failures > 0);
        assert.deepEqual(
          await page.evaluate(() =>
            Object.entries(sessionStorage).filter(([key]) =>
              key.startsWith("cedar."),
            ),
          ),
          retained,
          "failed configuration must not rewrite retained work",
        );
        assert.deepEqual(await read(), before);
        // Designer configuration fails before it can identify the current account;
        // it must preserve storage without exposing another account's draft.
        if (!metadata)
          assert.equal(
            await page
              .getByRole("button", { name: "Restore draft", exact: true })
              .isVisible(),
            false,
          );
      } finally {
        await page.unroute(matcher, fail);
      }
      await page
        .getByRole("button", {
          name: metadata ? "Retry" : "Reload designer",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "Restore draft", exact: true })
        .click();
      if (metadata) await settled(amount, "1.234");
      else {
        settings = await fieldConfiguration(page);
        await settled(settings.getByLabel("Minimum", { exact: true }), "8");
        assert.equal(
          await settings.getByLabel("Maximum", { exact: true }).inputValue(),
          "5",
        );
        await settings.getByRole("alert").waitFor();
      }
      assert.equal(await save.isDisabled(), true);
      assert.deepEqual(await read(), before);
      if (metadata) await amount.fill("1.3");
      else await settings.getByLabel("Minimum", { exact: true }).fill("2");
      await write(
        page,
        "PUT",
        metadata ? "/template-instances/" : "/" + f.collection + "/",
        () => save.click(),
        200,
        true,
      );
      await page
        .locator(metadata ? ".metadata-save-status" : "#state")
        .filter({ hasText: /^Saved$/ })
        .waitFor();
      const after = await read();
      if (metadata) {
        const expected = structuredClone(before);
        expected.Amount["@value"] = "1.3";
        assert.deepEqual(comparable(after), comparable(expected));
      } else {
        assert.equal(after.properties.Notes.minItems, 2);
        assert.equal(after.properties.Notes.maxItems, 5);
        assert.deepEqual(after.properties.Keep, before.properties.Keep);
      }
      await page.reload();
      await status(/^Unmodified$/).waitFor();
      if (metadata) await settled(amount, "1.3");
      else {
        settings = await fieldConfiguration(page);
        assert.equal(
          await settings.getByLabel("Minimum", { exact: true }).inputValue(),
          "2",
        );
      }
      pass(
        `${kind}: ${fault} configuration failure retains unfinished invalid input through retry, restoration, correction and explicit save/reopen`,
      );
    }
}
