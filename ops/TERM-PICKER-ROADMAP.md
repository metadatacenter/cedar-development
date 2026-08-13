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

**Terms is the tab the picker opens on**, every time, so the landing place never moves under
an author who is typing.

**Search ordering is a prerequisite, not a parallel track.** The picker rests on an author
reading the first handful of hits and recognizing one, so it does not ship on ordering that
leaves the head of the list arbitrary.

**Without a local catalog the picker degrades rather than fails.** Search and browse work
through BioPortal and the version controls do not appear at all, since nothing can answer
the versions endpoints.

**The terminology server gains one call that answers all four tabs**, returning per-kind
counts and each kind's first page, rather than the component making several.

**The picker holds the author's own credentials and uses them everywhere.** One credential
for terminology search and for the ontology list, which means the terminology server has to
accept a user credential where it expects an API key today.

**Property search and relation-type selection are retired**, on the same terms as
provisional creation: the picker keeps to the four kinds it advertises.

**Constraints written by the old picker are not migrated.** An absent `sourceSystem` already
means BioPortal, and the acronym derives the rest, which is how the backend reads them
today. The canonical-IRI backfill on the versioning roadmap stays a robustness improvement
rather than something this work depends on.

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
   what they would be constraining to. Needs the signal in item 16.
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
   - **A way to tell that no catalog is configured**, since the controls are hidden entirely
     in that case. Treating a failed `/versions` call as the signal works but conflates a
     missing store with a broken one; the server knows which mode it is in and could say so.
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
    haystack the ordering cannot search. This is the one backend item the picker cannot ship
    without, so it belongs on the critical path and should start before the component does.
15. **Build the one call that answers four tabs.** Terms and value sets need separate
    `/bioportal/search` calls to get separate totals, because one call with
    `scope=classes,value_sets` returns a combined total that cannot be split. The replacement
    returns per-kind counts and each kind's first page in one response, and it has to say
    when a count is capped rather than computed. Dropping the fields tab thinned the case for
    this: with the ontology list cached per session and branches riding on the class results,
    a settled keystroke now costs two calls rather than four. It is worth building because
    every tab then agrees about one query, and because the count and the ordering are decided
    in the same place — not because two calls are expensive.
16. **A descendant signal on class hits.** Item 6's branch tab needs to know whether a class
    has descendants, and how many, without a second call per row. The local store can compute
    it at ingest; BioPortal does not offer it.

## Cutover

17. **Ship behind a flag for one release, then delete what it replaces.** The new component
    is the default from the day it lands, with the old picker reachable behind a flag so a
    blocking gap found in real use has a way back. The AngularJS directives, controllers and
    templates under `cedar-template-editor/app/scripts/controlled-term/` come out the release
    after, together with the flag — carrying both indefinitely means two pickers writing
    constraints in two ways, which is worse than either. Set the date the old one goes when
    the flag goes in, rather than leaving it to be noticed.
