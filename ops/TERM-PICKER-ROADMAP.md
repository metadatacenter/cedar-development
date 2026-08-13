# CEDAR Term Picker — Roadmap

Open work for `cedar-term-picker`, a Web Component that lets an author choose what
constrains a CEDAR field. Building and running it is in
[TERM-PICKER-RUNBOOK.md](./TERM-PICKER-RUNBOOK.md); the terminology server it reads from is
in [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md) and
[BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md); the other Angular Web Component in the estate,
whose setup this one follows, is in [CEE-RUNBOOK.md](./CEE-RUNBOOK.md).

The repository exists and carries its license, conventions and README. No component code
has been written, so every item below is open.

## What It Replaces, and Why

The Workbench picker (`cedar-template-editor/app/scripts/controlled-term/`, about 3,600
lines of JavaScript and a 32 KB template) asks an author to choose a search mode before
searching: a term, an ontology to explore, or a value set. The author finds out whether
that mode had anything to offer only afterwards, and switching modes restarts the search.

The new component inverts that. One query runs against every kind at once, and the author
picks the kind from what the query actually found. An author filling a field usually knows
which kind they want before they open the picker, and the ones who do not are better served
by seeing all four answers than by guessing.

## Decisions Taken

**The picker searches four kinds: ontologies, branches, terms and value sets.** Searching for
an existing CEDAR field to reuse was considered and dropped. Every kind the picker returns is
therefore a value constraint on the field, which keeps the result contract to one shape, keeps
the component to one server, and leaves field reuse to whatever surface in the Template
Designer owns it.

**The Template Designer is the only host.** The picker belongs to template authoring, where
constraints are written; CEE is the metadata viewing and entry surface and does its own
value lookup at fill time. The two never load on one page, so the picker ships as a custom
element rather than a library some other component imports, and the Angular runtime it
carries is paid once by the page that uses it. CEE's fill-time term lookup stays where it
is and is not a consumer of this component.

The host being the AngularJS Template Designer has a consequence worth stating: the
integration is DOM-level, setting properties and listening for events on the element, with
no framework interop between AngularJS and Angular 22 in either direction.

**The picker emits one selection and closes.** A field can carry several constraints of
mixed kinds, and they accumulate outside the picker: an author adding a second constraint
opens it again. This keeps the component to one job — turn a query into a choice — and it
matches what the old picker already does. That picker shows a confirmation row for the one
selection in flight and never displays the field's constraint set; the set is rendered by
the field's configuration panel
(`cedar-template-editor/app/scripts/form/partials/configuration-options.partial.html`, four
repeats over `_valueConstraints`), and the picker touches it only to merge its addition back
on save.

**Latest is the default, and choosing it writes nothing.** Freeze-on-publish resolves an
unpinned constraint at publish time, so latest keeps meaning latest until the template is
published. A `version` appears on a constraint only when the author steps off latest.

**Version selection is per constraint.** Each constraint carries its own version, which is
how the backend already stores and freezes them, so nothing has to be reconciled across the
constraints on one field.

**A branch hit is a class hit that has descendants.** The Branches tab answers the same
query as the Terms tab, filtered to hits with something beneath them and framed as
"constrain to everything under this". The tab strip therefore keeps its promise that one
query answers every tab.

**Every settled keystroke queries all four kinds**, debounced and with superseded requests
cancelled, so a badge never describes a query the author has moved on from.

**A tab badge shows an exact count when it is small and a capped one when it is not.** The
shape is `500+` above the threshold; the threshold itself is still to be set.

**A query matches preferred labels, synonyms and labels in any language.** The local store
already serves that recall, and taking it is the difference between an author finding a
term by the name they know and not finding it at all.

**An author can narrow a search to named ontologies, and the narrowing applies to every
tab.** One filter constrains terms, branches and value sets together, which is also the
cheapest way to make a query with hundreds of thousands of hits usable.

**Provisional term and value-set creation is retired.** The old picker offers it from its
first screen; the new one does not, and the capability leaves the authoring surface with it.
Retiring creation does not retire the data — provisional terms already referenced by
templates have to keep resolving — so the retirement is a decision about the picker, not
about the terminology server's provisional endpoints.

**The repository publishes itself**, as CEE and the TypeScript model library do. Its version
moves when the component changes rather than with the platform release run. `cedar-cli` has
no entry for it and needs none: `skip_from_release` filters repos that are already
registered, so a repository the CLI does not know is excluded already. Registering it later
would buy the estate-wide checkout, pull and status commands, which run over the unfiltered
list, and the entry would carry `skip_from_release` to stay out of the release run.

**The component renders in shadow DOM** and exposes a small set of CSS custom properties for
the host to theme it through, which is the contract CEE arrived at.

**It takes CEE's design values, by copying them.** `_cee-tokens.scss` and the three embedded
Roboto weights are copied into the picker verbatim, under CEE's filenames and with its `$cee-`
prefixes, so a `diff` against the original is one command. CEE publishes only a built bundle to
npm, so consuming the values from the package is not available, and a shared package is the
thing to consider the first time a value has to change in both rather than work to do now. The
controls themselves stay ours: Angular Material would make the two genuinely match, at the cost
of a large dependency, and CEE's own M2-to-M3 migration is still open.

**The neutrals are gathered rather than copied.** CEE has no neutral palette: its greys are
literals written where each is used. So `_cedar-neutrals.scss` collects the recurring ones from
what CEE renders — `#777` for a control border, `#555` for secondary text, `#f5f5f5` for a panel,
`#d7e0df` for the tinted rule under its header — with each value's source noted. Body text is
`rgba(0, 0, 0, 0.87)`, which CEE renders by inheriting Material's default rather than by stating
it. That file is picker-owned and has nothing upstream to diff against. Consolidating these back
into CEE would improve both and is not this repository's to do.

Still open is spacing, which neither repository has as a scale. Embedding all three font weights
also costs about 184 kB, most of the bundle; what that does to the budget is in
[TERM-PICKER-RUNBOOK.md](./TERM-PICKER-RUNBOOK.md).

**Terms is the tab the picker opens on**, every time, so the landing place never moves under
an author who is typing.

**Search ordering is a prerequisite, not a parallel track.** The picker rests on an author
reading the first handful of hits and recognizing one, so it does not ship on ordering that
leaves the head of the list arbitrary.

**The picker requires the local store, and says so when it is missing.** An earlier decision
had it degrade instead — searching through BioPortal with the version controls simply absent —
and the endpoint below supersedes that: it reports unavailable when no catalog is configured,
and the picker tells the author the search service is unavailable rather than quietly serving
unpinnable results. This forces the open production question rather than working around it:
either production carries a catalog or it has no term picker.

**The terminology server gains a version-aware authoring search**, and the picker is built
against it rather than against `/bioportal/search`. Being able to search *at a version* is the
reason, and it is a correctness matter rather than a feature: `/bioportal/search` takes no
version, so an author who steps back to an older DOID would be searching the current one and
could pin a constraint to a term that does not exist in the version they pinned — manufacturing
the irreproducibility this whole effort exists to remove. `integrated-search` is version-aware
and shaped for the wrong moment, since it takes a constraint and asks what may fill it.

Four things settled about it:
- **A new root path, `POST /search`**, the first resource in the service outside `/bioportal`.
  That namespace exists because CEDAR proxied BioPortal, and this is not a BioPortal client.
  POST rather than GET because the request carries a version per source alongside the kinds and
  the scoping, which is the same reason `integrated-search` is a POST.
- **It replaces `/bioportal/search` once its consumers move.** The old route stays while CEE and
  the Template Designer still use it, and then goes. Ordering, obsolete and language work land
  once, in the new endpoint, rather than being maintained in two places that quietly diverge.
- **The local store is assumed.** No catalog, no answer — the endpoint reports unavailable
  instead of falling back to BioPortal for everything.
- **Per-ontology proxying survives, at latest only.** An ontology the store cannot hold — the
  UMLS-licensed ones, SNOMEDCT, MEDDRA, RCD, ICPC2P — is still served from BioPortal, and can
  never be pinned. Without somewhere for that to be said, an author pins a SNOMEDCT constraint
  and finds out at publish time, when freeze raises `PinnedVersionUnavailableException` as a 422
  — the failure landing a long way from the mistake.
- **That is said once per source, in the response envelope, not on every hit.** The fact is a
  property of an ontology within a request, not of an individual term: every SNOMEDCT hit is
  unpinnable for the same reason, and repeating it a hundred times would state it a hundred
  times and let the copies disagree. Hits already carry `source`, so the client joins.

  The block earns its place beyond pinnability, because it is the natural home for what a
  version-aware search has to report and today's has no way to say: **which version each source
  was actually searched at.** Served locally at a named version, or proxied at whatever
  BioPortal currently holds — an author who pinned a version needs the answer confirmed rather
  than assumed, and a client cannot derive it from the hits.

Work on it is on the `version-aware-search` branch of `cedar-terminology-server`.

**The picker holds the author's own credentials and uses them everywhere.** One credential
for terminology search and for the ontology list, which means the terminology server has to
accept a user credential where it expects an API key today.

**Property search and relation-type selection are retired**, on the same terms as
provisional creation: the picker keeps to the four kinds it advertises.

**Ontologies are found by name, and ordered by how well the name matches.** The tab filters the
ontology list by name and acronym rather than asking which ontologies answer the query, so it
is independent of the class search. Ties break on match quality and then alphabetically: an
exact acronym, then a name starting with the query, then a name containing it, then A–Z.
Ranking by CEDAR's own use of an ontology — how many templates already reference it, which
`ops/cedar_ontology_usage.py` can harvest — was considered and dropped, and the count is not
shown either. It would have entrenched what authors already chose, and it would have made the
tab depend on a number somebody has to keep current.

**Identical labels collapse into one row.** A query for "melanoma" returns the same string from
MESH, MEDDRA, LOINC and thirty more; the author's question at that point is which vocabulary,
not which of thirty near-identical rows. One row per distinct label, expanding to the
vocabularies offering it.

**Obsolete terms are shown, marked and demoted**, never hidden and never excluded. An author
sometimes needs a deprecated term deliberately, to match data that already uses it.

**Constraints written by the old picker are not migrated.** An absent `sourceSystem` already
means BioPortal, and the acronym derives the rest, which is how the backend reads them
today. The canonical-IRI backfill on the versioning roadmap stays a robustness improvement
rather than something this work depends on.

## What Each Tab Shows

The four kinds are one question at three scales plus a fourth thing. How much of a vocabulary
may this field draw from — all of it, a subtree, a single concept? A value set answers
something else: whether somebody has already written the list by hand.

Two of the tabs are views over one search. Terms and branches come from a single class query,
branches being the hits that have descendants, so their counts are related rather than
independent. Ontologies filter a list cached once per session, and value sets are their own
corpus.

**Terms — which concept, and whose.** One row per distinct preferred label, expanding to the
vocabularies that offer it. A row carries the label, the ontology, a definition snippet, and a
match-reason chip wherever the reason is not the label on screen: *matched synonym "cutaneous
melanoma"*, *matched French label*. The search response already carries `matchType` and
`matchedSynonyms`, so the chip needs no new backend work. Without it a synonym hit reads as a
defect rather than as recall.

**Ontologies — which vocabulary this field draws from.** Name and acronym matching over the
cached list, ordered by how well the name matches, with the ontology's size and its current
version on the row. The tab is often empty by construction: no ontology is named "melanoma".
Its empty state therefore has to do real work — say that nothing is named this, and point at
where the query did find something — or the tab reads as broken on exactly the queries the
picker is best at.

**Branches — which part of a vocabulary.** Only hits with descendants, and the row has to
answer what an author would be capturing: the class label, its ontology, its path from the
root as a breadcrumb, the descendant count, and two or three example descendants inline. The
breadcrumb is what separates *disease* in DOID from *disease* in an upper ontology, and the
examples are what tell an author whether the subtree is the one they pictured.

**Value sets — whether the list already exists.** The one tab where showing contents is cheap,
because value sets are small and enumerable. The row gives the name, its collection, how many
values it holds, which of its values matched the query, and the first few values inline. An
author can usually decide without opening anything, which is not true of the other three.

## Decide Before Writing Component Code

1. **Inventory what the old picker does.** The line count is not the feature count.
   Provisional term and value-set creation, narrowing a search to named ontologies,
   class-tree browsing, property search and relation types all live in those files, as does
   the merge that folds a new constraint into the ones a field already carries. Write the
   inventory down before deleting anything, so what the replacement drops is dropped on
   purpose rather than discovered missing after cutover.
2. **Design the result contract first, before any UI.** All four kinds — ontology, branch,
   class, value set — produce a value constraint, so the component emits one shape
   discriminated by kind rather than a union of unrelated things. Give every kind
   `sourceSystem`, the canonical `sourceIri` alongside the acronym, and a version, and the
   provenance shape the versioning work needs (items 1 and 5 of
   [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md)) follows from the contract rather than
   being retrofitted onto it. The four kinds are not uniform underneath — a class constraint
   takes no version, a branch names a class and an ontology — so what the contract has to
   settle is which fields each kind carries and which are common to all of them. Publish it
   as TypeScript declarations, as CEE now does for its host contract.
3. **Keep the terminology client framework-free.** Search, paging, cancellation, caching,
   count aggregation and version resolution belong in a plain TypeScript module with no
   Angular in it. Sharing it with CEE is no longer a reason, since CEE is not a consumer, so
   what remains is that it can be tested without a DOM and that it keeps the framework
   choice reversible. Both still hold, but this is a preference now rather than a
   requirement, and it should not be allowed to cost more than it returns.
4. **Scaffold the repository on CEE's setup.** Angular 22 with `@angular/elements`, the
   `@angular/build` application builder, ESLint with Prettier, Vitest for units, Playwright
   for behaviour and appearance, and a GitHub Actions gate that builds the production bundle
   and tests that artifact rather than a development one. CEE's `angular.json`,
   `eslint.config.mjs`, `vitest.config.mts` and workflow transfer nearly verbatim. Set a
   bundle budget deliberately: the Template Designer does not load an Angular 22 runtime
   today, and this component adds one.

## The Component

5. **The search box and the four tabs.** One input, four tabs beneath it — ontologies,
   branches, terms, value sets — each showing what the current query found, and each
   updating as the query is refined. Four kinds against a moving query is where a naive
   implementation renders stale results, so the debounce and the cancellation are the
   component's first real engineering rather than a detail. Because a query matches synonyms
   and other languages, a hit has to say *why* it matched when the reason is not the label on
   screen, or a result that is correct will read as unrelated. The ontology narrowing filter
   lives here too, applying to every tab at once rather than to the one in front of the
   author.
6. **Show a branch hit's reach.** A branch hit is a class hit with descendants, so the row
   has to carry the descendant count and enough of the surrounding tree for an author to see
   what they would be constraining to. Sequenced behind items 15 and 16, and deliberately not
   built lazily in the meantime: resolving each row's reach on expand means a tab whose badge
   cannot be computed and a click before an author learns what a branch holds, which is worse
   than the tab arriving a release later.
7. **Set the badge threshold, and get the numbers behind it right.** Measured on 2026-08-13
   against the local server, `q=disease&scope=classes` reports `totalCount` 238,163 while the
   Workbench displays "500 results" — the 500 is a frontend cap rather than a total. Value
   sets return 13 for the same query, which is a count worth showing exactly. The threshold
   between the two cases is a judgement about how many hits an author will scan, and it
   should be set against real queries rather than picked.
8. **Offer version selection natively, latest by default.** An author constraining a field
   to an ontology, a branch or a value set gets the latest version without asking for it,
   sees that older ones exist, and can step backwards through them one at a time rather than
   choosing from a list of content hashes. Individual classes are not offered a version, by
   design — they have no snapshot of their own. This is what the version picker item in
   [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md) now points at, and it needs three things
   the endpoints do not obviously give yet:
   - **A legible sequence to step through.** `GET /ontologies/{acronym}/versions` returns
     snapshots; stepping needs them ordered and labelled by something an author can read —
     `effectiveDate`, falling back to `declaredVersion` — with the content hash kept as
     identity rather than shown as a name.
   - **A cheap "older versions exist" signal.** The indicator appears before an author asks
     for the version list, so a per-row call is too expensive on the ontology tab. Either the
     ontology list carries a version count, or the indicator waits until a row is selected.
   - **Nothing written while the author stays on latest**, per the decision above, so the
     component has to distinguish "the author accepted the default" from "the author stepped
     back and then forward again to the newest version". The second pins; the first does not.
   - **Nothing to offer on a proxied ontology**, since a hit BioPortal served has no snapshot
     to step through. The control is absent rather than disabled, and the row says why.
9. **Make one credential work across the terminology server.** It does not agree with itself
   today about what a caller must hold: `/bioportal/search` builds an anonymous request
   context and answers without a header, while `/bioportal/ontologies` returns
   `UNAUTHORIZED` without an API key (both measured 2026-08-13). The picker carries the
   author's credentials, so the work is to accept a user credential where an API key is
   expected while keeping the anonymous path working for whatever else relies on it. Worth
   revisiting once, now that the resource server has left the picture: making
   `/bioportal/ontologies` anonymous like its sibling is the cheaper way to reach the same
   place, and the only reason to prefer a user credential is if the picker will eventually
   need one for something else.
10. **Show the pinned version in the field's configuration panel.** The panel already lists
    everything constraining a field, one repeat per kind over `_valueConstraints`, and it
    keeps that job — the picker adds one constraint and closes, as it does today. What the
    panel does not show is the version, which becomes visible state the moment constraints
    can be pinned: a field constrained to two branches of DOID at different versions looks
    identical there to one pinned at neither. Those four tables gain a version, and the
    constraint the picker hands back has to land in them unchanged.
11. **Retire three capabilities cleanly: provisional creation, property search, relation
    types.** All three are being dropped, so the work is making sure nothing falls over
    behind them. Find who creates provisional terms today and what they do instead, confirm
    that templates already referencing one still resolve it, decide whether the terminology
    server's provisional endpoints keep serving reads once nothing writes to them, and check
    whether anything in production authored constraints through property search.
12. **Define the theming surface, and make the overlay behave.** Shadow DOM is settled; what
    is not is which CSS custom properties the Template Designer gets and what they are
    allowed to move. Reuse CEE's token approach and its rule that Material internals are not
    host API. The overlay is the part shadow DOM makes harder rather than easier: a modal
    inside a shadow root has to stack above the host's own layers and trap focus without
    reaching into them.
13. **Build the test gate with the component, not after it.** Unit tests over the
    framework-free client against recorded terminology-server responses, behaviour and
    appearance tests in a browser, and a production-artifact gate in CI. The real query
    corpus that `cedar_usage_matrix.py` harvests from production templates gives the client's
    tests inputs that reflect what CEDAR actually looks up.

## Backend It Depends On

14. **Search ordering.** The picker's whole premise is that an author reads the first
    handful of hits and recognizes the one they want. Today's ordering leaves BioPortal's
    entire top ten tied at edit distance zero, so which ten CEDAR shows is effectively
    arbitrary — measured and written up as the term-ordering item in
    [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md). A count of 238,163 advertises a
    haystack the ordering cannot search, so this belongs on the critical path and should start
    before the component does. It lands in item 15's new endpoint rather than in
    `/bioportal/search`, which is what makes it safe: a route with no consumers yet cannot
    change results underneath CEE or the Template Designer.
15. **Build `POST /search`, the version-aware authoring search.** The one backend dependency
    the picker cannot start without, on the `version-aware-search` branch. What it answers, in
    one call: a query at a named version or the current one, across the kinds, with per-kind
    counts and each kind's first page, saying when a count is capped rather than computed. What
    a hit carries beyond today's `prefLabel`/`definition`/`source`/`matchType`/`matchedSynonyms`
    is the part that unblocks the tabs — all of it data the store already holds, so this is one
    change to a hit shape rather than several endpoints:
    - `hasChildren` and a descendant count, without which the branch tab cannot be built at all;
    - obsolete, and the replacement IRI the store records beside it, without which "shown,
      marked and demoted" cannot be implemented;
    - the matched label in the language it matched, so a hit found through a French label does
      not display an English one with no explanation. `lang=` is ignored on
      `/bioportal/search` today — measured 2026-08-13, GEMET returns identical labels with and
      without it — which the versioning roadmap records as deferred by decision.

    Alongside the hits, a per-source block in the envelope: for each source the results touch,
    the version it was searched at, whether it was served locally or proxied, and therefore
    whether a constraint on it can be pinned.

    One thing that block leaves open. When a request pins a source to a version the store does
    not hold, `integrated-search` fails the whole request loud, and deliberately so: it resolves
    one constraint for filling, where silently serving latest would corrupt an instance. A
    search spanning many sources is a different shape, and failing everything because one source
    cannot be pinned would be poor. Reporting that source as unavailable in its own block, and
    returning the rest, holds the same principle — never serve latest as though it were pinned —
    without discarding the answer. Decide it deliberately rather than by inheriting the 422.

    Keep it a general capability rather than a picker API. Collapsing identical labels and the
    match-reason chip belong to the client; an endpoint shaped around one UI is a liability the
    first time a second consumer wants it.
16. **Compute the descendant signal the hit carries.** Item 15 serves it; this is producing it.
    A branch row needs whether a class has descendants, how many, and its path from the root,
    none of which the store materializes today — `hasChildren` appears on class detail, and a
    direct-child count needs its own call, measured at 197 for DOID_4 on 2026-08-13. Cheap to
    compute at ingest, and BioPortal offers none of it, which is another reason the branch tab
    cannot be built against a proxy.
## Cutover

17. **Ship behind a flag for one release, then delete what it replaces.** The new component
    is the default from the day it lands, with the old picker reachable behind a flag so a
    blocking gap found in real use has a way back. The AngularJS directives, controllers and
    templates under `cedar-template-editor/app/scripts/controlled-term/` come out the release
    after, together with the flag — carrying both indefinitely means two pickers writing
    constraints in two ways, which is worse than either. Set the date the old one goes when
    the flag goes in, rather than leaving it to be noticed.
