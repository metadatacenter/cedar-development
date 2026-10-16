import assert from "node:assert/strict";
import { artifactBody, call, mutate, enc, RESOURCE } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";

export async function combinedDeleteJourney(args) {
  const { page, base, user, name, created, pass } = args;
  for (const outcome of ["uncommitted", "committed"])
    for (const fault of ["503", "disconnect"]) {
      const folderId = await journeyFolder(
          args,
          "combined deletion " + outcome + " " + fault,
        ),
        items = [];
      async function create(collection, parent, label) {
        const r = await call(
          user.auth,
          "POST",
          "/" +
            collection +
            (collection === "folders" ? "" : "?folder_id=" + enc(parent)),
          collection === "folders"
            ? {
                folderId: parent,
                name: label,
                description: "Temporary deletion journey",
              }
            : artifactBody("field", label),
        );
        assert.equal(r.status, 201, r.text);
        const item = { collection, id: r.body["@id"] };
        created.push(item);
        items.push(item);
        return item;
      }
      const folder = await create("folders", folderId, "A recursive " + name),
        nested = await create("template-fields", folder.id, "Nested " + name);
      const uncertain = await create(
          "template-fields",
          folderId,
          "B uncertain " + name,
        ),
        remaining = await create(
          "template-fields",
          folderId,
          "C remaining " + name,
        );
      const selected = [folder, uncertain, remaining],
        row = (item) => page.locator(`[data-resource-id="${item.id}"]`),
        path = (item) => "/" + item.collection + "/" + enc(item.id);
      for (let attempt = 0; ; attempt++) {
        await page.goto(base + "/dashboard?folderId=" + enc(folderId));
        await page.getByRole("button", { name: "New", exact: true }).waitFor();
        const list = page.getByRole("button", {
          name: "List view",
          exact: true,
        });
        if (await list.count()) await list.click();
        await page.waitForFunction(
          () =>
            document
              .querySelector(".table-scroll")
              ?.getAttribute("aria-busy") === "false",
        );
        if (
          await row(remaining)
            .waitFor({ timeout: 1000 })
            .then(
              () => true,
              () => false,
            )
        )
          break;
        assert.ok(attempt < 15, "deletion fixtures not listed");
      }
      for (const [index, item] of selected.entries())
        await row(item)
          .locator(".resource-icon")
          .click({ modifiers: index ? ["ControlOrMeta"] : [] });
      await page
        .getByRole("button", { name: "Delete (3)", exact: true })
        .click();
      const dialog = page.getByRole("dialog"),
        confirm = dialog.getByRole("button", {
          name: "Delete selected items and contents",
          exact: true,
        }),
        refresh = dialog.getByRole("button", {
          name: "Refresh inventory",
          exact: true,
        });
      await dialog
        .getByText("Total items to delete: 4.", { exact: false })
        .waitFor();
      let listingDown = false,
        inventoryDown = false,
        uncertainOnce = true,
        listingFailures = 0,
        inventoryFailures = 0,
        routeError;
      const writes = [],
        matcher = (url) => url.origin === new URL(RESOURCE).origin;
      const intercept = async (route) => {
        try {
          const req = route.request(),
            pathname = new URL(req.url()).pathname,
            parts = decodeURIComponent(pathname).split("/");
          const item = items.find((candidate) =>
            parts.includes(candidate.id.split("/").at(-1)),
          );
          const unavailable = () =>
            fault === "503"
              ? route.fulfill({
                  status: 503,
                  json: { message: "Temporary recovery outage" },
                })
              : route.abort("connectionclosed");
          if (req.method() === "GET") {
            if (listingDown && pathname.includes("/contents")) {
              listingFailures++;
              return unavailable();
            }
            if (
              inventoryDown &&
              item &&
              (pathname.endsWith("/report") || pathname.endsWith("/deletion"))
            ) {
              inventoryFailures++;
              return unavailable();
            }
            return route.fallback();
          }
          if (!item || !["DELETE", "POST"].includes(req.method()))
            return route.fallback();
          assert.ok(
            selected.includes(item),
            "only selected test resources may be deleted",
          );
          writes.push({ id: item.id, etag: req.headers()["if-match"] });
          if (item !== folder) assert.ok(req.headers()["if-match"]);
          listingDown = true;
          if (item === uncertain && uncertainOnce) {
            uncertainOnce = false;
            if (outcome === "committed") {
              const response = await route.fetch();
              assert.ok(response.ok(), await response.text());
            }
            return route.abort("connectionclosed");
          }
          const response = await route.fetch();
          assert.ok(response.ok(), await response.text());
          return route.fulfill({ response });
        } catch (error) {
          routeError = error;
          return route.abort("failed").catch(() => {});
        }
      };
      await page.route(matcher, intercept);
      try {
        await confirm.click();
        await dialog
          .getByRole("alert")
          .filter({ hasText: "Some items may already have been deleted" })
          .waitFor();
        await page.waitForFunction(
          () =>
            document
              .querySelector(".table-scroll")
              ?.getAttribute("aria-busy") === "false",
        );
        assert.equal(routeError, undefined);
        assert.ok(listingFailures > 0);
        assert.equal(await confirm.isDisabled(), true);
        assert.deepEqual(
          writes.map((w) => w.id),
          [folder.id, uncertain.id],
        );
        const progress = dialog
            .getByText("Confirmed deletions so far", { exact: true })
            .locator("xpath=following-sibling::ul[1]"),
          confirmed = await progress.innerText();
        assert.match(confirmed, /Folders\s*:\s*1/);
        assert.match(confirmed, /Fields\s*:\s*1/);
        for (const item of [folder, nested])
          assert.equal((await call(user.auth, "GET", path(item))).status, 404);
        assert.equal(
          (await call(user.auth, "GET", path(uncertain))).status,
          outcome === "committed" ? 404 : 200,
        );
        assert.equal(
          (await call(user.auth, "GET", path(remaining))).status,
          200,
        );
        inventoryDown = true;
        for (let retry = 0; retry < 2; retry++) {
          const failures = inventoryFailures;
          await refresh.click();
          await dialog
            .getByText(/The complete selection could not be checked/)
            .waitFor();
          const until = Date.now() + 10000;
          while (inventoryFailures === failures) {
            assert.ok(
              Date.now() < until,
              "inventory retry did not reach the server",
            );
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await page.waitForFunction(() =>
            [...document.querySelectorAll("button")].some(
              (b) =>
                b.textContent.trim() === "Refresh inventory" && !b.disabled,
            ),
          );
          assert.ok(inventoryFailures > failures);
          assert.equal(await confirm.isDisabled(), true);
          assert.equal(await progress.innerText(), confirmed);
          assert.equal(writes.length, 2);
        }
        inventoryDown = false;
        const freshEtags = new Map();
        for (const item of outcome === "uncommitted"
          ? [uncertain, remaining]
          : [remaining]) {
          const latest = await call(user.auth, "GET", path(item));
          latest.body["schema:description"] = "Changed during inventory outage";
          const saved = await mutate(user.auth, "PUT", path(item), latest.body);
          assert.equal(saved.status, 200, saved.text);
          freshEtags.set(
            item.id,
            (await call(user.auth, "GET", path(item))).headers.get("etag"),
          );
        }
        await refresh.click();
        if (outcome === "uncommitted") {
          await dialog
            .getByText("Total items to delete: 2.", { exact: false })
            .waitFor();
          assert.equal(await confirm.isDisabled(), false);
          assert.equal(await progress.innerText(), confirmed);
          assert.equal(writes.length, 2);
          await confirm.click();
          await dialog.waitFor({ state: "hidden" });
          assert.deepEqual(
            writes.slice(2),
            [uncertain, remaining].map((item) => ({
              id: item.id,
              etag: freshEtags.get(item.id),
            })),
          );
        } else {
          await dialog
            .getByText(/The complete selection could not be checked/)
            .waitFor();
          assert.equal(await confirm.isDisabled(), true);
          assert.equal(await progress.innerText(), confirmed);
          await dialog
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          const reload = page.getByRole("button", {
            name: "Refresh workspace",
            exact: true,
          });
          const failedListings = listingFailures;
          await reload.click();
          const listingDeadline = Date.now() + 10000;
          while (listingFailures === failedListings) {
            assert.ok(
              Date.now() < listingDeadline,
              "failed listing retry did not reach the server",
            );
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await page.waitForFunction(
            () =>
              document
                .querySelector(".table-scroll")
                ?.getAttribute("aria-busy") === "false",
          );
          assert.equal(writes.length, 2);
          listingDown = false;
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname.includes("/contents") &&
                response.ok(),
            ),
            reload.click(),
          ]);
          await page.waitForFunction(
            () =>
              document.querySelectorAll("tr[data-resource-id]").length === 1 &&
              document
                .querySelector(".table-scroll")
                ?.getAttribute("aria-busy") === "false",
          );
          await row(remaining).waitFor();
          if ((await row(remaining).getAttribute("aria-selected")) !== "true")
            await row(remaining).locator(".resource-icon").click();
          await page
            .getByRole("button", { name: "Delete (1)", exact: true })
            .click();
          await dialog
            .getByRole("button", { name: "Delete", exact: true })
            .click();
          await dialog.waitFor({ state: "hidden" });
          assert.deepEqual(writes.slice(2), [
            { id: remaining.id, etag: freshEtags.get(remaining.id) },
          ]);
        }
        listingDown = false;
        await page
          .getByRole("button", { name: "Refresh workspace", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document
              .querySelector(".table-scroll")
              ?.getAttribute("aria-busy") === "false",
        );
        for (const item of items)
          assert.equal((await call(user.auth, "GET", path(item))).status, 404);
        assert.equal(routeError, undefined);
        assert.equal(writes.filter((w) => w.id === folder.id).length, 1);
        pass(
          `Recursive bulk deletion survives ${fault} listing/inventory outages after an uncertain ${outcome} delete; confirmed progress remains and recovery deletes only remaining resources with fresh revisions`,
        );
      } finally {
        await page.unroute(matcher, intercept);
      }
    }
}
