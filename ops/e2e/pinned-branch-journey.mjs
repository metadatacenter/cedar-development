import assert from "node:assert/strict";
import { artifactBody, call, enc, TERMINOLOGY } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { editorStatus } from "./metadata-journey-fixtures.mjs";
import { editorSave, pathId } from "./workspace-journey-fixtures.mjs";

// An author can pin a controlled-term branch to a release other than the newest, and the record a
// user then fills must offer the branch as that release had it. NCIT's Melanoma branch serves as the
// example because the store holds many of its releases and the branch changed between them. In
// release 24.01e it holds "Melanomatosis", which later releases place elsewhere, and it lacks "Acral
// Melanoma", which they add. A field that silently read the newest release would offer the second
// and not the first, so the pair tells the two readings apart in both directions.
//
// The journey picks the release in Designer through the real term picker, reads the saved template
// back, and then fills a record in Editor. It checks what the field offers, that every search Editor
// sends names the pinned release, and that the server stores the chosen term and accepts it as a
// member of the branch at that release, which at the newest release it is not. Publishing the template
// must then keep the author's release, and a record of the published template must read the branch
// at that release too. The REST freeze suite covers the other half of publishing: an unpinned
// constraint is frozen at the current release.
//
// The journey acts as the runner's first test user only and never signs in as another account.

const NCIT = "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl";
const MELANOMA = NCIT + "#C3224";
const RELEASE = {
  id: "4d680c1a97514e31f7433e942d97f01c6909a6dfc1766a675b7fc095c048207d",
  effectiveDate: "2024-02-01T00:00:00.000+00:00",
  declaredVersion: "24.01e",
};
/** In the branch at the pinned release and not at the newest. */
const PINNED_ONLY = { iri: NCIT + "#C9499", label: "Melanomatosis" };
/** In the branch at the newest release and not at the pinned one. */
const NEWEST_ONLY = { iri: NCIT + "#C204883", label: "Acral Melanoma" };
/** In the branch at both, so a search for "Acral" has an answer to wait for either way. */
const IN_BOTH = "Acral Lentiginous Melanoma";

const branch = version => ({ acronym: "NCIT", uri: MELANOMA, maxDepth: 0, ...(version ? { version } : {}) });

/** The labels the terminology server offers for a search of the Melanoma branch, at a release or the newest. */
async function offered(inputText, version) {
  const reply = await call(null, "POST", "/bioportal/integrated-search", {
    parameterObject: {
      inputText,
      valueConstraints: { ontologies: [], valueSets: [], classes: [], branches: [branch(version)], actions: [] },
    },
    page: 1,
    pageSize: 50,
  }, { base: TERMINOLOGY });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.collection.map(term => term.prefLabel);
}

/**
 * The store must still hold the release and still tell the two readings apart, or the journey proves
 * nothing. A failure here concerns the local terminology store, not the components under test.
 */
async function storeDistinguishesReleases() {
  const pinned = { id: RELEASE.id };
  const facts = {
    pinnedHas: (await offered(PINNED_ONLY.label, pinned)).includes(PINNED_ONLY.label),
    pinnedLacks: !(await offered("Acral", pinned)).includes(NEWEST_ONLY.label),
    newestLacks: !(await offered(PINNED_ONLY.label)).includes(PINNED_ONLY.label),
    newestHas: (await offered("Acral")).includes(NEWEST_ONLY.label),
  };
  assert.ok(Object.values(facts).every(Boolean),
    `the local terminology store no longer distinguishes NCIT ${RELEASE.declaredVersion} from the newest release `
    + `in the Melanoma branch, so this journey cannot tell a pinned search from an unpinned one: ${JSON.stringify(facts)}`);
}

/**
 * Types into a controlled-term field and returns the suggestions once they are the answer to that
 * text: its search has been answered, and every suggestion shown comes from that answer. Until then
 * the list can still hold an earlier search's answer, where an absent term proves nothing.
 */
async function suggestionsFor(page, field, text) {
  const answer = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/bioportal/integrated-search")
    && response.request().postDataJSON()?.parameterObject?.inputText === text);
  await field.fill(text);
  const answered = new Set((await (await answer).json()).collection.map(term => term.prefLabel));
  const options = page.getByRole("option");
  const deadline = Date.now() + 20_000;
  for (;;) {
    const shown = (await options.allInnerTexts()).map(label => label.trim());
    if (shown.length && shown.every(label => answered.has(label))) return shown;
    if (Date.now() > deadline)
      throw new Error(`the suggestions for ${JSON.stringify(text)} never became its answer: shown ${JSON.stringify(shown)}, `
        + `answered ${JSON.stringify([...answered])}`);
    await page.waitForTimeout(250);
  }
}

export async function pinnedBranchJourney(args) {
  const { page, base, designer, user, name, created, write, pass } = args;
  await storeDistinguishesReleases();
  const folderId = await journeyFolder(args, "pinned branch");
  const made = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId),
    artifactBody("template", name + " pinned branch template"));
  assert.equal(made.status, 201, made.text);
  const templateId = made.body["@id"];
  created.push({ collection: "templates", id: templateId });

  // Designer: a Controlled Terms field, constrained through the picker to the branch at 24.01e.
  await page.goto(designer + "/templates/edit/" + pathId(templateId));
  await page.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByRole("button", { name: "Controlled Terms", exact: true }).click();
  const card = page.locator("app-field-card")
    .filter({ has: page.locator(".field-type-label", { hasText: "Controlled Terms" }) });
  await card.getByRole("textbox", { name: "Enter field name", exact: true }).fill("Diagnosis");
  const settings = card.locator("app-field-settings");
  const toggle = settings.locator(".settings-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await settings.getByRole("tab", { name: "Constraints", exact: true }).click();
  await page.getByRole("button", { name: /Edit controlled-term constraints/ }).click();

  const picker = page.locator("cedar-embeddable-term-picker");
  await picker.locator("input[type=search]").fill("Melanoma");
  await picker.locator(".tab", { hasText: "Branches" }).click();
  // A `has` locator is resolved inside each candidate, so it starts from the page, not the picker.
  await picker.locator(".rowhead")
    .filter({ has: page.locator(".title").filter({ hasText: /^melanoma$/i }) }).click();
  const ncit = picker.locator(".child").filter({ has: page.locator(".who").filter({ hasText: /^NCIT$/ }) });
  await ncit.click();
  await ncit.locator("button.of").click();
  const release = picker.locator(".history button.release").filter({ hasText: RELEASE.declaredVersion });
  // The release list says which release each entry is, by the hash that a pin records.
  await release.filter({ hasText: RELEASE.id.slice(0, 12) }).click();
  const chosen = picker.locator(".chosen");
  await chosen.filter({ hasText: RELEASE.declaredVersion }).waitFor();
  await picker.locator(".hierarchy-choice").getByRole("button", { name: "Select", exact: true }).click();
  const table = picker.locator(".constraint-table").first();
  await table.locator("tbody tr").filter({ hasText: "Melanoma" }).filter({ hasText: RELEASE.declaredVersion }).waitFor();
  assert.equal(await table.locator("tbody tr").count(), 1, "the field has one constraint, the branch");
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await picker.waitFor({ state: "detached" });
  await editorSave(page, write, "PUT", "templates");

  const template = (await call(user.auth, "GET", "/templates/" + enc(templateId))).body;
  const constraints = template.properties.Diagnosis._valueConstraints;
  assert.deepEqual(
    { ontologies: constraints.ontologies, classes: constraints.classes, valueSets: constraints.valueSets },
    { ontologies: [], classes: [], valueSets: [] }, "the branch is the field's only constraint");
  assert.equal(constraints.branches.length, 1);
  assert.equal(constraints.branches[0].uri, MELANOMA);
  assert.equal(constraints.branches[0].acronym, "NCIT");
  assert.deepEqual(constraints.branches[0].version, RELEASE, "the template records the release the author chose");
  pass("pin-branch-release", `Designer's term picker pins NCIT's Melanoma branch to release ${RELEASE.declaredVersion}, `
    + "and the saved template records that release's identifier, date and declared version");

  // Editor: a new record of the draft template, whose field searches the branch at the pinned release.
  const diagnosis = await newRecord(args, templateId, folderId, "draft");
  await offersPinnedBranch(page, diagnosis);
  pass("pinned-branch-values", `Editor offers the branch as release ${RELEASE.declaredVersion} holds it: `
    + `"${PINNED_ONLY.label}" and not "${NEWEST_ONLY.label}", the reverse of the newest release, and every search names the pin`);

  await page.getByRole("option", { name: PINNED_ONLY.label, exact: true }).click();
  const saved = await write(page, "PUT", "/template-instances/",
    () => page.locator("#button-save-metadata").click(), 201);
  await editorStatus(page, /^Saved$/).waitFor();
  const record = (await call(user.auth, "GET", "/template-instances/" + enc(saved["@id"]))).body;
  assert.equal(record.Diagnosis["@id"], PINNED_ONLY.iri);
  assert.equal(record.Diagnosis["rdfs:label"], PINNED_ONLY.label);
  const report = await call(user.auth, "POST", "/command/validate?resource_type=instance", record);
  assert.equal(report.status, 200, report.text);
  assert.equal(report.body.isValid, true, report.text);
  // The newest release does not hold the term in the branch, so a pass here is a check at the pin.
  assert.ok(report.body.findings.some(finding => finding.path === "/Diagnosis/@id"
    && finding.code === "controlledTermVerified" && finding.verificationStatus === "passed"), report.text);
  await page.reload();
  await editorStatus(page, /^Unmodified$/).waitFor();
  assert.equal(await diagnosis.inputValue(), PINNED_ONLY.label);
  pass("pinned-value-saved", `A term only release ${RELEASE.declaredVersion} places in the branch saves, `
    + "the server verifies it against the pinned release, and the record reopens with it");

  // Publishing freezes every unpinned constraint at the current release. A constraint the author
  // pinned already names a release, and publishing must leave it at that one.
  const published = await call(user.auth, "POST", "/command/publish-artifact", { "@id": templateId, newVersion: "1.0.0" });
  assert.ok([200, 201].includes(published.status), published.text);
  const frozen = (await call(user.auth, "GET", "/templates/" + enc(templateId))).body;
  assert.equal(frozen["bibo:status"], "bibo:published");
  assert.deepEqual(frozen.properties.Diagnosis._valueConstraints.branches.map(entry => entry.version), [RELEASE],
    "publishing keeps the release the author pinned rather than freezing the current one");
  await offersPinnedBranch(page, await newRecord(args, templateId, folderId, "published"));
  pass("published-pin-kept", `Publishing keeps the branch at release ${RELEASE.declaredVersion}, `
    + "and a record of the published template offers the branch as that release holds it");
}

/** Opens a new record of the template in Editor and returns its Diagnosis field. */
async function newRecord({ page, base, name }, templateId, folderId, label) {
  await page.goto(base + "/instances/create/" + enc(templateId) + "?folderId=" + enc(folderId));
  await editorStatus(page, /^Unmodified$/).waitFor();
  await page.locator("#instance-name").fill(`${name} pinned branch ${label} record`);
  return page.locator("cedar-embeddable-editor").getByLabel("Diagnosis", { exact: false }).first();
}

/**
 * Checks that the field offers the branch as the pinned release holds it, in both directions, and that
 * every search the field sends names that release.
 */
async function offersPinnedBranch(page, field) {
  const searches = [];
  const observe = request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/bioportal/integrated-search"))
      searches.push(request.postDataJSON()?.parameterObject);
  };
  page.on("request", observe);
  try {
    const acral = await suggestionsFor(page, field, "Acral");
    assert.ok(acral.includes(IN_BOTH), `"${IN_BOTH}" is in the branch at every release: ${JSON.stringify(acral)}`);
    assert.ok(!acral.includes(NEWEST_ONLY.label),
      `"${NEWEST_ONLY.label}" is offered, but release ${RELEASE.declaredVersion} does not hold it in the branch`);
    const pinnedOnly = await suggestionsFor(page, field, PINNED_ONLY.label);
    assert.ok(pinnedOnly.includes(PINNED_ONLY.label),
      `"${PINNED_ONLY.label}" is in the branch at release ${RELEASE.declaredVersion}: ${JSON.stringify(pinnedOnly)}`);
  } finally {
    page.off("request", observe);
  }
  for (const text of ["Acral", PINNED_ONLY.label])
    assert.ok(searches.some(search => search?.inputText === text), `Editor never searched for ${JSON.stringify(text)}`);
  for (const search of searches) {
    assert.deepEqual(search.valueConstraints.branches.map(entry => entry.version?.id), [RELEASE.id],
      `Editor searched for ${JSON.stringify(search.inputText)} without the pinned release`);
  }
}
