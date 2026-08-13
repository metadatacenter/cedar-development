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

> **State of the repository.** `cedar-term-picker` holds its license, conventions and
> README. There is no `package.json`, no application and no test gate yet, so the sections
> on building, testing and releasing describe the intended shape rather than commands that
> run today. What the component reads is real and can be exercised now, and those commands
> are marked as verified with the date they were run.

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

## Building, Testing and Releasing

Not yet true — the repository has no build. The intended shape, once the scaffold lands, is
CEE's: `npm start` for the standalone development app, `npm run build:production` for the
custom element, Vitest for unit tests, Playwright for behaviour and appearance, and a GitHub
Actions gate that builds the production bundle and then tests that artifact rather than a
development one. This section gets real commands when they exist, and the roadmap's scaffold
item is what puts them here.
