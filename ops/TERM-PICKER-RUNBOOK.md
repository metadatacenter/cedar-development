# CEDAR Term Picker — Development Runbook

Working on `cedar-term-picker`, the Web Component that lets an author choose what
constrains a CEDAR field. Its host is the Template Designer (`cedar-template-editor`),
whose controlled-term picker it replaces, and no other frontend embeds it. Open work is in
[TERM-PICKER-ROADMAP.md](./TERM-PICKER-ROADMAP.md).

Sibling runbooks:
- [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) — the CEDAR Embeddable Editor, the other Angular Web
  Component in the estate and the setup this repository follows.
- [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) — running the CEDAR stack, including the
  terminology server this component reads from.

> **State of the repository.** The picker searches. It runs against `POST /search` on the
> terminology server, renders the four tabs with live counts, folds repeated labels, and steps a
> constraint back through an ontology's releases. What is left is on
> [TERM-PICKER-ROADMAP.md](./TERM-PICKER-ROADMAP.md) — chiefly paging past the first page, the
> ontology narrowing filter, and embedding it in the Template Designer.
>
> It needs a terminology server carrying a catalog and a cross-snapshot index. The dev stack's
> server on 9004 has the local store disabled and proxies everything to BioPortal, so the picker
> cannot use it; run a second instance as below.

---

## The Repository

`$CEDAR_HOME/cedar-term-picker`, beside every other CEDAR repository. The default branch is
`develop`, matching the rest of the estate.

Committed conventions, all taken from CEE so a developer moving between the two meets one
set of rules:

| File | What it fixes |
|---|---|
| `.nvmrc` | Node 24.19.0, the version Angular 22 accepts and CEE's CI pins |
| `.npmrc` | the `@org.metadatacenter` scope resolves from the Stanford Nexus registry |
| `.prettierrc` | single quotes, trailing commas, two-space indent, 120 columns |
| `.editorconfig` | UTF-8, two-space indent, final newline, trimmed trailing whitespace |
| `.gitignore` | build output, `node_modules`, and a guard against committing a sibling CEDAR repository cloned inside this one |

Install Node keg-only so it does not displace the version the other CEDAR frontends use:

```bash
brew install node@24
```

and put it in front for work in this repository:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

Nothing here needs Java.

## What the Component Reads

All four kinds of hit — ontologies, branches, terms and value sets — come from the
terminology server, which listens on port 9004. Bring the stack up with the sequence in
[BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md).

Set the environment first, `CEDAR_HOME` exported before the profile is sourced or its
variables come out empty:

```bash
export CEDAR_HOME=/Users/martin/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh
```

### Terms and Value Sets

`GET /bioportal/search` answers both, and its `scope` parameter picks which — `classes`,
`value_sets`, `values`, or `all`. It builds an anonymous request context, so it answers
without a credential. The response wraps the hits in paging metadata: `page`, `pageSize`,
`pageCount`, `totalCount`, `prevPage`, `nextPage` and `collection`.

```bash
curl -s 'http://localhost:9004/bioportal/search?q=disease&scope=classes&page_size=50' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print({k:v for k,v in d.items() if k!="collection"})'
# verified 2026-08-13
# -> {'page': 1, 'pageCount': 4764, 'pageSize': 50, 'totalCount': 238163, 'prevPage': None, 'nextPage': 2}
```

The same query under `scope=value_sets` returns `totalCount` 13. The gap between 13 and
238,163 is what the tab-badge item on the roadmap has to answer, and the "500 results" the
Workbench displays for this query is its own cap rather than either number.

### Ontologies

`GET /bioportal/ontologies` returns the whole list in one response — 1,300 entries as of
2026-08-13 — each carrying `id`, `name` and a `details` block with `numberOfClasses`. There
is no server-side ontology search, so the ontology tab filters this list in the client,
which is why the list is worth caching once per session rather than per keystroke.

Unlike `/bioportal/search`, this endpoint requires a credential:

```bash
curl -s -H "Authorization: apiKey $CEDAR_ADMIN_USER_API_KEY" \
  'http://localhost:9004/bioportal/ontologies' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'
# verified 2026-08-13 -> 1300
```

Without the header it returns `UNAUTHORIZED` with `suggestedAction: provideAuthorizationHeader`.

### Branches

Nothing to call. A branch is a class used as a subtree root, so a branch hit is a class hit
presented differently, and `/bioportal/ontologies/{acronym}/classes/{id}/children` and
`/descendants` walk it once one is chosen.

### Versions

`GET /bioportal/ontologies/{acronym}/versions` lists what an ontology can be pinned to,
`/versions/current` gives the one in force, and `/versions/diff` compares two. Only the local
versioned store answers these; with no catalog configured they do not resolve. Which mode the
server is in is in [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) under the local terminology
store.

## Running It

`npm start` serves the development host on port 4500 — `src/index.html`, a page standing in
for the Template Designer, which sets the element's `query` attribute and listens for its
`cancelled` event. Nothing on that page ships.

```bash
npm --prefix $CEDAR_HOME/cedar-term-picker start
```

Nothing here needs the CEDAR stack until the component starts reading from it.

## Running the Picker Against a Store

The picker needs a terminology server with both a catalog and a search index, and the dev stack's
does not carry either. Run a second instance on its own ports, leaving 9004 alone:

```bash
export CEDAR_HOME=/Users/martin/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export CEDAR_TERMINOLOGY_HTTP_PORT=29004 CEDAR_TERMINOLOGY_ADMIN_PORT=29104 CEDAR_TERMINOLOGY_STOP_PORT=29204
java -DterminologyStore.catalogPath=$CEDAR_HOME/cedar-term/prod/catalog.sqlite \
     -DterminologyStore.searchIndexPath=$CEDAR_HOME/cedar-term/prod/search-index.sqlite \
     -DterminologyStore.localOntologies="$CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES" \
     -DterminologyStore.localRootsOntologies="$CEDAR_TERMINOLOGY_LOCAL_ROOTS_ONTOLOGIES" \
     -jar $CEDAR_HOME/cedar-terminology-server/cedar-terminology-server-application/target/\
cedar-terminology-server-application-$CEDAR_VERSION.jar \
     server $CEDAR_HOME/cedar-terminology-server/cedar-terminology-server-application/src/main/resources/config.yml
```

The startup log says which mode it is in — "Cross-snapshot search index opened from …" and "Local
terminology store enabled from …". Not 19004: the application tests bind those ports, and a server
sitting on them fails the suite with a bind error that reads like a code fault.

`npm start` then serves the picker on 4500 and proxies `/search` to 29004 through
`proxy.conf.json`, which is what keeps the call same-origin and CORS out of the picture.

## Building and Testing

| Command | What it does |
|---|---|
| `npm run build:production` | the custom-element bundle, into `dist/cedar-term-picker` |
| `npm test` | unit tests, through the Angular CLI's Vitest builder |
| `npm run lint` | ESLint over TypeScript and templates, Prettier included |
| `npm run typecheck` | `tsc` over every file under `src/`, including ones no build or test reaches |
| `npm run test:ci` | the gate: lint, typecheck, tests, then the production build |
| `npm run audit:prod` | advisories against what actually ships |

`.github/workflows/test.yml` runs the gate on push and pull request, on the Node version
`.nvmrc` pins, with the audit as a separate step so a disclosure does not fail somebody's
unrelated pull request with an error they cannot fix there.

Three details of the setup are worth knowing before they surprise you.

**The build is zoneless.** Angular 22 generates a project without `zone.js`, and this one
keeps it that way. Change detection runs on signals, so a view updates on a microtask after
the signal is set rather than synchronously: a test or a console probe that reads the DOM in
the same tick as the change sees the old value. `await fixture.whenStable()` is the fix in a
spec.

**`ng test` is the Angular CLI's own Vitest builder**, not a hand-written `vitest.config`.
CEE predates it and carries its own; nothing here needs to.

**The production bundle is unhashed**, because a host page loads it by name. It is 310.07 kB raw
and 172.22 kB transferred, of which about 184 kB is the three embedded Roboto weights. That part
is fixed and does not compress — base64 of an already-compressed woff2 — so the transfer figure
is close to the raw one and stays that way. The remaining ~126 kB is the application.

The budgets are set around that: `initial` warns at 400 kB and fails at 550 kB, leaving roughly
90 kB of growth before anyone is told. `anyComponentStyle` had to go to 190/200 kB, because the
font registrar's stylesheet *is* those 184 kB, and Angular's budgets cannot exempt one file. The
consequence is worth knowing rather than discovering: that budget no longer says anything useful
about an ordinary component stylesheet, since another one would have to reach 190 kB to trip it.

## Fonts, and Why There Is a Component That Renders Nothing

Browsers do not register `@font-face` from inside a shadow root, so the picker cannot simply put
the faces in its own encapsulated stylesheet. `FontRegistrar` is the answer CEE also arrived at:
a component with `ViewEncapsulation.None` and an empty template, whose stylesheet holds the
font faces and no selectors at all. Angular sends an unencapsulated component's styles to the
document head, which is what registers the fonts; it also copies them into the shadow root, so
the base64 exists twice in the DOM at runtime. That is a memory cost rather than a transfer one.

The selectors matter: an unencapsulated stylesheet reaches the host page, so anything beyond a
`@font-face` in that file would leak out of the component.

Verified in a browser rather than assumed — `document.fonts` carries `CEE Roboto` at 400 and 500
and `document.fonts.check('14px "CEE Roboto"')` returns true.

A global stylesheet in `angular.json` would be the ordinary way to reach the document, and it
does not work here: the CLI emits it as a separate `styles.css` that a host page never loads.
`"styles": []` is deliberate, in this repository and in CEE.

## Releasing

Nothing has been released. The repository will publish itself to npm rather than moving with
the platform release run, and `cedar-cli` has no entry for it — see
[TERM-PICKER-ROADMAP.md](./TERM-PICKER-ROADMAP.md). This section gets its commands when the
first release is cut.
