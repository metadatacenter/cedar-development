import {recoveryElementEditsJourney} from "./recovery-element-edits-journey.mjs";
import {accessRecheckJourney} from "./access-recheck-journey.mjs";
import {saveStatusJourney} from "./save-status-journey.mjs";
import assert from "node:assert/strict";
import {chromium} from "playwright";
import {actors, call, mutate, enc} from "./rest/lib.mjs";
import {initialLoadJourney} from "./initial-load-journey.mjs";
import {validationRejectionJourney} from "./validation-rejection-journey.mjs";
import {duplicationJourney} from "./duplication-journey.mjs";
import {templateEvolutionJourney} from "./template-evolution-journey.mjs";
import {partialMoveJourney} from "./partial-move-journey.mjs";
import {currentTemplateConstraintJourney} from "./current-template-constraint-journey.mjs";
import {uncertainMoveJourney} from "./uncertain-move-journey.mjs";
import {olderKeyRenameJourney} from "./older-key-rename-journey.mjs";
import {designerPendingSaveJourney} from "./designer-pending-save-journey.mjs";

// Run self-contained journeys against the live stack without provisioning the
// unrelated sharing/versioning fixtures in the full Workspace smoke.
const journeys = {"recovery-element-edits": recoveryElementEditsJourney, "access-recheck": accessRecheckJourney, "save-status": saveStatusJourney, "initial-load": initialLoadJourney, "validation-rejection": validationRejectionJourney,
  duplication: duplicationJourney, "template-evolution": templateEvolutionJourney, "partial-move": partialMoveJourney,
  "current-template-constraint": currentTemplateConstraintJourney, "uncertain-move": uncertainMoveJourney,
  "older-key-rename": olderKeyRenameJourney, "designer-pending-save": designerPendingSaveJourney};
const selected = process.argv.slice(2);
assert.ok(selected.length && selected.every(key => journeys[key]), "Choose: " + Object.keys(journeys).join(", "));
const base = process.env.CEDAR_BASE || "https://workspace.metadatacenter.orgx";
const designer = process.env.CEDAR_DESIGNER_BASE || "https://designer.metadatacenter.orgx";
const {user1} = await actors();
const browser = await chromium.launch({headless: !process.env.HEADED});
const created = [], errors = [];
let page;
async function write(p, method, path, gesture, status = 200, conditional = false) {
  const [response] = await Promise.all([
    p.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname.startsWith(path)), gesture(),
  ]);
  assert.equal(response.status(), status, await response.text());
  if (conditional) assert.ok(await response.request().headerValue("if-match"));
  const body = await response.json();
  if (method === "POST" && body?.["@id"] && !created.some(item => item.id === body["@id"]))
    created.push({collection: new URL(response.url()).pathname.split("/")[1], id: body["@id"]});
  return body;
}
try {
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1500, height: 1000}});
  context.setDefaultTimeout(25000);
  page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base + "/dashboard");
  await page.locator("#username").fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || "test1@test.com");
  await page.locator("#password").fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || "test1");
  await page.locator("#kc-login").click();
  await page.getByRole("button", {name: "New", exact: true}).waitFor();
  const name = "Focused journey " + Date.now();
  const folder = await call(user1.auth, "POST", "/folders", {folderId: user1.profile.homeFolderId, name, description: "Temporary journey"});
  assert.equal(folder.status, 201, folder.text);
  created.push({collection: "folders", id: folder.body["@id"]});
  for (const key of selected) await journeys[key]({page, base, designer, user: user1,
    folderId: folder.body["@id"], name, created, write, pass: message => console.log("PASS: " + message)});
  assert.deepEqual(errors, [], "uncaught browser errors");
} catch (error) {
  console.error(await page?.locator("body").innerText().catch(() => "Page unavailable"));
  throw error;
} finally {
  await browser.close();
  const failures = [];
  for (const item of created.reverse()) {
    const removed = await mutate(user1.auth, "DELETE", "/" + item.collection + "/" + enc(item.id));
    if (![200, 204, 404].includes(removed.status)) failures.push(`${item.collection}/${item.id}: ${removed.status}`);
  }
  assert.deepEqual(failures, [], "fixture cleanup");
  console.log("Focused journey fixtures removed");
}
