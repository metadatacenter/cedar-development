# CEDAR Term Picker — Roadmap

Open work for `cedar-term-picker`, a Web Component that lets an author choose what
constrains a CEDAR field. Building and running it is in
[TERM-PICKER-RUNBOOK.md](./TERM-PICKER-RUNBOOK.md); the terminology server it reads from is
in [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md) and
[BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md); the other Angular Web Component in the estate,
whose setup this one follows, is in [CEE-RUNBOOK.md](./CEE-RUNBOOK.md).

The picker searches. What that took, and what it measured on the way, is below; the numbered
items are what is left.

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

**A tab badge shows an exact count when it is small and a capped one when it is not**, and for the
terms tab the count is of distinct labels rather than of hits. Measured 2026-08-13, a hit count is
not a badge: every query anyone types saturates any cap on terms, so it would read the same for
"melanoma" as for "aspirin". The collapsed count is what the author will actually see once identical
labels are folded into one row, and it varies — melanoma 2,552, blood pressure 1,601, diabetes
3,107, aspirin 1,720, against hit counts of 5,439, 3,019, 5,824 and 3,122. Counting stops at ten
thousand and says "more than" above it, which is where a broad query lands and where no number is
actionable anyway.

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

**Ontologies are found by name first, then by the vocabularies the query landed in.** Name and
acronym matches lead, ordered by match quality and then alphabetically. After them come the
vocabularies whose terms the query actually matched, each with how many — which is a group-by over
the same search, not a tally of the page.

This revises an earlier decision to match on names alone, and the evidence is what revised it.
Measured against the built index on 2026-08-13: "melanoma" finds MELO by name and then NCIT (950
terms), BERO (782), PR (238); "blood pressure" and "aspirin" name no vocabulary at all while
matching terms in 164 and 97 of them. A name-only tab is empty for most of what a picker sees, and
"which vocabulary should this field draw from" is the authoring question that the same query already
answers.

Ranking by CEDAR's own use of an ontology — how many templates already reference it, which
`ops/cedar_ontology_usage.py` can harvest — remains dropped, and the count is not shown. It would
have entrenched what authors already chose, and it would have made the tab depend on a number
somebody has to keep current.

**Identical labels collapse into one row.** A corpus-wide query for "melanoma" leads with the exact
string from VALUESETS, IRAEO, MDM, NCIT, CSEO and RH-MESH, measured against the index on 2026-08-13; the author's question at that point is which vocabulary,
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
melanoma"*, *matched French label*. The search response carries `matchType` and `matchedLabels`,
so the chip needs no new backend work. Without it a synonym hit reads as a defect rather than as
recall — and on a row whose own label answers the query, the chip is the noise it exists to
prevent, which is why the server withholds it there.

**Ontologies — which vocabulary this field draws from.** Name and acronym matching over the
cached list, ordered by how well the name matches, with the ontology's size and its current
version on the row. The tab answers a different question from the others and returns far less:
"melanoma" finds one ontology, MELO, against 90 DOID terms (measured 2026-08-13), and a query
naming no vocabulary finds none. Its empty state therefore has to do real work — say that nothing is named this, and point at
where the query did find something — or the tab reads as broken on exactly the queries the
picker is best at.

**Branches — which part of a vocabulary.** Only hits with descendants, and the row has to
answer what an author would be capturing: the class label, its ontology, its path from the
root as a breadcrumb, the descendant count, and two or three example descendants inline. The
breadcrumb is what separates *disease* in DOID from *disease* in an upper ontology, and the
examples are what tell an author whether the subtree is the one they pictured.

**Value sets — whether the list already exists.** The tab stays, though CEDARVS is the only
value-set collection in the served catalog: a value set is a distinct constraint kind with its own
shape, and more collections are expected — storing caDSR's is already on the versioning roadmap. A
search naming no source looks in every collection the catalog knows, so an author is shown what is
there without having to name it.

It is the one tab where showing contents is cheap,
because value sets are small and enumerable. The row gives the name, its collection, how many
values it holds, which of its values matched the query, and the first few values inline. An
author can usually decide without opening anything, which is not true of the other three.

## What Is Built

The component runs against the live corpus and the four tabs answer. `POST /search` on the
terminology server backs it, on the `version-aware-search` branch, and a cross-snapshot index
backs corpus-wide queries.

**The endpoint.** A query at a named version or the current one, across the four constraint
types, in one call. Per-source blocks say which snapshot answered, whether it can be pinned, and
— for a source that could not be searched — why, rather than letting its absence read as an
absence of matches. A source may be named once per request, because a hit carries the addressing
pair and no version of its own.

**The index.** 1,215 ontologies, 13,939,470 terms, 24,278,806 names, built in 226 seconds into
5.4 GB, answering a corpus-wide query in about a quarter of a second. It holds each ontology's
current version and no other, which is a property of the question: a corpus-wide search cannot be
pinned, since there is no one version to pin it to. Matching is FTS5 — token prefixes, folded
diacritics, so `aquifere` finds `aquifère`. Ranking happens in SQL because the cap truncates
before a caller can reorder; ordering by label length alone filled it with coded vocabularies'
numeric ids and dropped the terms named after the query.

**Hits rank on what matched.** An exact preferred label first, then an exact synonym, then any
other exact name, then a prefix, with hidden labels last, and length only as a tie-break within a
tier. Obsolete terms rank second, so a retired term is shown and marked but sits below the live
terms that answer as well — not below every live term that answers worse, which would bury an
exact hit on a retired label. A query for melanoma now leads with the three ontologies that call a
class exactly that; before, it led with "Malignant Melanoma".

**A version reads as its ontology declares it.** No synthesised `v`, which was wrong about the
string as often as not: the catalog holds `V2`, `v1.0.0`, `2026-07-06` and `latest`, rendered as
`vV2`, `vv1.0.0` and `vlatest`. Declared means arbitrary — `owl:versionInfo` is free text, and of
the 998 snapshots that fill it, 915 are 20 characters or fewer while the longest is 782 characters
of prose, newlines and a table of HTML. The row elides from the middle at 20 and carries the whole
string in its title, so a version that is prose costs a hover rather than the layout. A row with
more than one release says how many, which is the only thing on it inviting a step.

**The rows of a tab share one set of columns.** Counts, versions and the step arrows sit in tracks
the whole list declares, through CSS subgrid, so a row keeps its own box — it tints when marked and
rules off from its neighbours — while its trailing cells line up with every other row's. The step
control is a button where there is something to step to and an empty span where there is not, since
a row emitting fewer cells than its neighbours shifts every cell after it. Counts run right against
their column, so the repeated words align rather than starting wherever a number ends.

**Dismissal is a glyph.** The bar's ✕ emits `cancelled` and nothing else, so a host that closes on
it closes with the field's constraints as they were. Spelling it "Close" gave the one control that
answers nothing the weight of a choice, beside the field where the choices are made.

**A row is chosen in two acts.** A click marks it and a double click, or Enter on a focused row,
emits it. The per-row buttons are gone with that: a "Use" on every line spent the width the names
need, and the narrowing button duplicated the filter panel above the tabs, which is where narrowing
belongs. One click no longer decides anything, which matters when the rows are a line tall and
adjacent. Enter carries the decision for the keyboard, since a double click has no equivalent
there.

**Both list tabs page by distinct label**, not by hit, and carry every hit of the labels on the
page. Paging by hit made folding impossible to do honestly — a page of twenty-five hits for a
common word is one label — so a row could only ever claim a count "on this page". Terms fold
across ontologies; branches fold across and within, because a thesaurus can place one concept
several times in its own tree.

**A theming contract of ten custom properties**, and a discipline about what is missing from it.
A host sets the brand, the text and surface colours, the border, the warning colour, and the font
family and base size; row geometry, control padding and the meaning of a colour stay with the
component, because a host able to re-point those could make an obsolete term look ordinary. The
type scale moves with the base and the tint is mixed from the brand, so neither is left behind by
a host that changes one. Escape leaves the picker.

**Thirteen browser tests drive the built bundle**, with the terminology server stubbed, so the
suite is hermetic and says what the component does with an answer rather than whether the answer
was good. They hold the faults this work found by hand, which is every fault it found: a fold that
swallowed a group, a panel that cleared the list an author was choosing from, rows reading "BERO
BERO", a row three times the height of its neighbours. They drive the production bundle over a
static server rather than `ng serve`, because a build that breaks the bundle while leaving the dev
server working is the failure worth catching.

**Narrowing and paging.** One filter serves every tab, chosen from a panel ranked by how much of
the query each ontology holds — a different order from the ontologies tab, which leads with a
vocabulary named after the query. For melanoma that is the difference between MELO, aptly named
and holding 38 terms, and NCIT with 950. Narrowing keeps the index rather than dropping to the
snapshots, so the same search runs over less rather than a different search running. Each tab
pages independently, and the source blocks accumulate as later pages name ontologies the first
did not.

**The rows.** One line each, folding what an author cannot choose between and opening onto what
they can. A long label folds from the middle, keeping both ends, because LOINC puts a whole
question in the label and its axis codes after it. A row leads with the name that matched when the ontology's label is a bare code. A
branch shows its parent, since a label does not always identify a class. An ontology row ranks
name matches and term matches together, because segregating them spent the first page
alphabetically and never reached the vocabularies that hold the terms.

**Version stepping.** Rows for the pinnable kinds carry `‹ v2026-06-30 ›` where the store holds
more than one release. Stepping forward to current unpins rather than pinning to today's version,
so a constraint records a version only when the author chose one. Terms have no stepper: a class
carries no snapshot of its own.

Three things the work measured that the plan below rests on:

- A corpus-wide query needs at least two characters. One matched a large fraction of 24 million
  names and took 18.6 seconds where "melanoma" takes 0.11.
- Counting stops at ten thousand. Counting every match of a broad query is a deduplication of much
  of the corpus — "cell" takes 3.2 seconds unbounded and 40 milliseconds capped — and nobody acts
  on the difference between ten thousand rows and three hundred thousand.
- The dev server on 9004 has the local store disabled and proxies to BioPortal, so figures read
  from it are BioPortal's. The instance these numbers came from is a separate one, with the
  catalog and index configured.

## The Template Designer

Later work, and deliberately after the component stands on its own. Embedding turns every open
question about the picker into a question about the Workbench as well, and none of the three items
here can be finished without the component being finished first. The component itself has nothing
left that does not need a host.

1. **Embed it in the Template Designer.** The host integration is DOM-level: set properties, listen
   for events. Nothing of it exists — the component runs in its own development host against a
   dev-server proxy, which is what keeps the call same-origin and CORS out of the picture. Whatever
   replaces that proxy in the Workbench is the first real question.
2. **Make the overlay behave, once there is one to behave.** The picker is an inline panel today
   and the Workbench presents its picker as a modal, so this is the half of the theming item that
   could not be finished without a host: a modal inside a shadow root has to stack above the host's
   own layers and trap focus without reaching into them. Escape already leaves. Sequenced with the
   embedding rather than before it, because what the overlay has to sit above is a property of the
   page it sits in.

3. **Show the pinned version in the field's configuration panel.** The panel already lists
   everything constraining a field, one repeat per kind over `_valueConstraints`, and it keeps
   that job — the picker adds one constraint and closes, as it does today. What the panel does not
   show is the version, which becomes visible state the moment constraints can be pinned: a field
   constrained to two branches of DOID at different versions looks identical there to one pinned
   at neither.
4. **Retire three capabilities cleanly: provisional creation, property search, relation types.**
   All three are being dropped, so the work is making sure nothing falls over behind them. Find
   who creates provisional terms today and what they do instead, confirm that templates already
   referencing one still resolve it, decide whether the terminology server's provisional endpoints
   keep serving reads once nothing writes to them, and check whether anything in production
   authored constraints through property search.

## The Terminology Server

5. **Order across ontologies.** Ranking on the match reason is in place, which is the field half
   of what the term-ordering item in [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md) measures.
   The ontology half is not: BioPortal multiplies its field score by a per-ontology prior built
   from its own page visits and UMLS membership, and that measurement puts the prior at most of
   the agreement. Nothing local reproduces it. Counting how many CEDAR templates reference an
   ontology was considered and declined, so the head of a common query is ordered within an
   ontology and arbitrary between them — three ontologies calling a class "melanoma" tie, and the
   IRI breaks it. Deciding what, if anything, plays the prior's part is the open question.
6. **Make one credential work.** The server does not agree with itself: `POST /search` and
   `/bioportal/integrated-search` answer anonymously, `/bioportal/ontologies` and
   `/ontologies/{acronym}/versions` refuse without an API key. The picker sidesteps it by taking
   everything through the search response — the version histories included, which is why a source
   block carries them — but a third answer to the same question is still a third answer.
7. **Proxy the ontologies the store cannot hold.** `proxied` is a designed state the server never
    produces: a source not served locally is reported unavailable, including the UMLS-licensed
    ones — SNOMEDCT, MEDDRA, RCD, ICPC2P — that BioPortal could answer for at latest. Reporting
    them as proxied while returning none of their terms would be the silent wrong answer this
    endpoint exists to prevent, so the state waits until something fills it.
8. **Capture definitions at ingest.** A class hit carries no definition, because the snapshot
    holds none. The design says a row shows one, and a term's definition is often what separates
    two identically-labelled classes when the parent does not.
9. **Keep the index fresh.** A re-ingest moves an ontology's current version and the index does
    not follow until `SearchIndexJob` runs again. It is incremental and takes seconds for a few
    ontologies, but nothing runs it, and an index behind the catalog reports the version it holds
    rather than the one that exists — correctly, and confusingly. Decide what triggers a rebuild.

## Cutover

10. **Ship behind a flag for one release, then delete what it replaces.** The new component is the
    default from the day it lands, with the old picker reachable behind a flag so a blocking gap
    found in real use has a way back. The AngularJS directives, controllers and templates under
    `cedar-template-editor/app/scripts/controlled-term/` come out the release after, together with
    the flag — carrying both indefinitely means two pickers writing constraints in two ways, which
    is worse than either. Set the date the old one goes when the flag goes in, rather than leaving
    it to be noticed.
