# CEDAR Embeddable Editor (CEE) — Development Runbook

Building, running and testing **CEE** (`cedar-embeddable-editor`) locally.
Everything here has been run on macOS (Apple silicon) against `develop` @ CEE
1.5.2.

Sibling runbooks:
- [CEE-ROADMAP.md](./CEE-ROADMAP.md) — the framework-upgrade programme, open
  findings and known defects.
- [CEE-RELEASE-RUNBOOK.md](./CEE-RELEASE-RUNBOOK.md) — cutting a CEE version and
  publishing it to npm.
- [DEVELOPMENT-RUNBOOK.md](./DEVELOPMENT-RUNBOOK.md) — running the full CEDAR
  stack locally.

> CEE is a standalone Angular web component. It does **not** need the CEDAR
> stack running — none of the commands below depend on the microservices.

---

## Node versions — read this first

**Two different Node versions are required, and using the wrong one is the most
common way to lose an hour.**

| What | Node | Why |
|---|---|---|
| The Angular app (`npm install`, `ng build`, `ng serve`) | **18** | Angular 14's CLI and build pipeline. Node 20+ is untested here and Node 22+ will refuse. |
| `harness/` (Vitest domain tests) | **20** | Vitest 1.6 and the ESM config. Imports no Angular, so it has no Angular-era constraint. |
| `cedar-model-typescript-library` | 18 or 20 | Webpack 5 / TS 5.3; both work. |

Install both once:

```bash
brew install nvm && mkdir -p ~/.nvm
```

Add to `~/.zshrc` (the Homebrew formula does not do this for you):

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
```

```bash
nvm install 18 && nvm install 20
```

Then `nvm use 18` or `nvm use 20` per the table above.

Nothing here needs Java. The one exception is the canonical validator, which
needs **JDK 17** specifically — see
[Checking output against the CEDAR model](#checking-output-against-the-cedar-model).

---

## Running the app

CEE's standalone dev mode needs a second repo for the sample templates it loads.

```bash
git clone https://github.com/metadatacenter/cedar-component-distribution.git
```

Configuration for dev mode lives in `src/app/app.component.dev.ts` — it is
TypeScript, not JSON, and is compiled in. Point
`sampleTemplateLocationPrefix` at wherever the component-distribution server is
serving from.

Terminal 1 — the sample templates:

```bash
cd cedar-component-distribution && npm install && npx ng serve
```

Terminal 2 — CEE itself:

```bash
nvm use 18 && npm install && npx ng serve
```

Then open `http://localhost:4400/`.

## Building the web component

This is the real deliverable — a single JS file embeddable in any page.

```bash
nvm use 18 && npx ng build --configuration=production
```

```bash
cat dist/cedar-embeddable-editor/{runtime,polyfills,main}.js > cedar-embeddable-editor.js
```

The concat order matters and the filenames are Angular 14's. **This step changes
shape at Angular 17**, when the build moves to esbuild/vite and stops emitting
these three files — see [CEE-ROADMAP.md](./CEE-ROADMAP.md) Phase 3.

## Running the domain test harness

The harness depends on the model library's built `dist/`, not its source, so the
library must be built first.

```bash
cd ../cedar-model-typescript-library && npm install && npm run build
```

```bash
nvm use 20 && cd harness && npm install && npm test
```

Expect **1,047 passing** on `develop`, **1,699** on `cee-with-model-library`. Watch mode is `npm run test:watch`.

A green run here means CEE agrees with itself. For whether its output is
actually a valid CEDAR instance, see
[Checking output against the CEDAR model](#checking-output-against-the-cedar-model).

### Coverage

```bash
nvm use 20 && cd harness && npm run test:coverage
```

Over `shared/factory`, `shared/handler`, `shared/util` and `shared/validation` —
the domain layer the harness actually targets — expect roughly **95%
statements**. The rest of `shared/` is Angular services, REST response models
and pipes, which the harness does not load and should not, so the headline
number for all of `shared/` is meaningless.

Read the *never-called-function* list rather than the percentage. That is what
found the attribute-value hole in August 2026 — three functions no test had ever
entered, one of them the widget's delete button — and, right after it, a bug
that had been losing everything inside an element on reload.

To run one file (note: paths are relative to the repo root, not `harness/`,
because `vitest.config.ts` sets `root` to the repo):

```bash
npx vitest run harness/test/controlled-terms.spec.ts
```

### Reading a template from YAML

CEE parses templates through the CEDAR Model TypeScript Library, which reads
YAML into the same model it reads JSON into — so a template written either way
produces the same form. `harness/test/format-independence.spec.ts` checks that
over all 37 corpus templates, and `harness/test/instance-output.spec.ts` checks
the same for the instance CEE emits.

If either starts failing after a change to the parser or the emitter, the
question to ask is which of the two formats the new code is quietly assuming.

### Running against the old template parser

**Historical.** The hand-written JSON walk was kept alongside the
library-backed parser during the migration so the whole suite could be run
against either, which is what caught most of the defects. Both walks were
deleted once the swap had settled, and `CEE_TEMPLATE_PARSER` /
`CEE_INSTANCE_READER` no longer exist. On `develop` — before the migration —
the walk is the only implementation:

```bash
CEE_TEMPLATE_PARSER=json-walk npm test
```

Expect the same count either way. Four rendered list fields across the corpus
genuinely differ — `multipleChoice` normalised against the property's
cardinality rather than copied verbatim — and `harness/test/corpus.spec.ts`
names them one by one, so a difference that stops happening fails as loudly as a
new one. Run this before and after anything that touches
`factory/model-library-template-parser.ts`.

## Checking output against the CEDAR model

Everything above checks CEE against itself. This checks it against the model.

The distinction is not academic. In August 2026 the harness had 1,488 passing
tests, including a pair that compare CEE's JSON output against its YAML output
and find them equivalent — and **zero** of the 37 instances CEE produced
validated against the template it built them from. The tests all agreed with
each other. None of them asked the model.

### Why a template can validate its own instances

A CEDAR template *is* a JSON Schema (draft-04) for its instances. Not a
description of one — the document itself, `properties` and `required` and all.
That is exactly how `cedar-model-validation-library` validates an instance:
`CedarValidator.validateTemplateInstance(instanceNode, schemaNode)` hands the
template to a JSON Schema validator as the schema.

So there is nothing to derive and no mapping to trust. Any draft-04 validator
can answer the question.

### The canonical check — cedar-model-validation-library

`cedar-model-validation-library` is the arbiter. When it and anything else
disagree, it wins.

It needs **JDK 17** — the POM enforces `[17,18)` and will refuse 21 or 23 with
`RequireJavaVersion` — and its parent POM `org.metadatacenter:cedar-parent`,
which resolves only against the CEDAR nexus. Clone and `mvn install`
`cedar-parent` first if you have not; the public repos return 402 for it.

```bash
cd ../cedar-model-validation-library && export JAVA_HOME=$(/usr/libexec/java_home -v 17) && mvn test
```

Expect **210 passing, 7 skipped**.

Its own fixtures are the thing to read: `src/test/resources/instances/*.jsonld`
paired with `src/test/resources/templates/*.json`, and
`TemplateInstanceValidationTest`, which is nine `shouldFail` cases each deleting
one required key. That list is the definition of the instance envelope.

The `scripts/validate-*.sh` wrappers do not currently run — they call `python`
rather than `python3`, want a `jsonschema` module that is not installed, and
point at a `template-schema.json` that is generated rather than committed. Use
`mvn test`, or add a fixture to the Java suite.

### The same check, in the harness

Running Maven is not something to do per-edit, so the harness runs the
equivalent check on every `npm test` with `ajv-draft-04`:

```bash
npx vitest run harness/test/model-conformance.spec.ts
```

For each corpus template it builds CEE's instance and validates it against that
template. **31 of 37 pass.** The six that do not are listed by name in
`KNOWN_NON_CONFORMANT` at the top of the file with what is wrong with each, and
a separate test asserts the failing set *equals* that list — so a template that
starts conforming fails just as loudly as one that stops. The number is a
defect count. It should only go down.

Two of the six are not CEE's fault (template 001 has no `@id`; template 003 is
malformed). The other four are real: see [CEE-ROADMAP.md](./CEE-ROADMAP.md) →
Open findings.

### Why the harness check can be trusted

ajv is not the Java validator, so the agreement has to be demonstrated rather
than assumed:

```bash
npx vitest run harness/test/validator-agreement.spec.ts
```

This runs the canonical library's *own* instance fixtures through ajv — the
seven it requires to pass and the nine mutations it requires to fail — and
checks the verdicts match. All 17 do. It skips itself if
`cedar-model-validation-library` is not checked out beside CEE.

The failing half is the informative one: a validator that accepted everything
would pass the seven. If a future CEDAR release tightens a rule ajv does not
implement, this is where it surfaces, rather than in a quietly over-optimistic
conformance number.

### When to run which

Change the emitter, the envelope, or `data-object-builder.handler.ts` →
`model-conformance.spec.ts`, which `npm test` runs anyway.

Upgrade the model library, take a new CEDAR release, or find yourself arguing
with the harness about what the model requires → run Maven. The Java suite is
the tie-breaker, and `validator-agreement.spec.ts` is where its verdict gets
written back down into the harness.

## Running the visual baseline

Screenshot regression against the built bundle. Requires a fresh `dist/`, so
build the app first (Node 18), then switch to Node 20 to run Playwright.

```bash
nvm use 18 && npx ng build --configuration=production
```

```bash
nvm use 20 && cd visual && npm install && npx playwright install chromium
```

```bash
npm run prepare:all && npm test
```

Expect **16 passing** in about 5 seconds. `prepare:all` re-concatenates the
bundle from `../dist` and regenerates the template fixtures; run it after any
rebuild, or the suite silently tests a stale bundle.

To accept an intentional visual change:

```bash
npm run update
```

Review every changed PNG before committing — a baseline update asserts the new
rendering is correct.

## Running the legacy Angular specs

```bash
nvm use 18 && npx ng test
```

These are 40 CLI-generated `expect(component).toBeTruthy()` stubs. They assert
nothing and are slated for deletion — see [CEE-ROADMAP.md](./CEE-ROADMAP.md) Phase 4. Do not read a green
run here as coverage.

---

## Troubleshooting

**`ng` refuses to run, or `npm install` fails with engine errors**
Wrong Node. `nvm use 18` for anything Angular.

**Harness: `SyntaxError: Invalid or unexpected token` pointing at line 1 of a
CEE source file**
esbuild transformed the file but left `@Injectable()` in place, or the file was
externalized and never transformed at all. Both are handled in
`harness/vitest.config.ts` — `esbuild.tsconfigRaw.experimentalDecorators` and
the `TRANSFORM` patterns respectively. CEE sets `experimentalDecorators` in
`tsconfig.base.json`, but esbuild reads the nearest `tsconfig.json`, where it is
absent.

**Harness: a suite reports "no tests" but exits green**
`deps.inline` is matching too broadly and has inlined `vitest` itself, giving
the spec files a second copy of `describe`/`it` that the runner never sees. Keep
the `TRANSFORM` patterns narrow. This failure mode looks exactly like success —
check the test count, not the exit code.

**Harness: `Failed to load url lodash-es`**
Resolution from `../src` walks up to a repo root with no `node_modules`. The
`ceeStubs` plugin in `vitest.config.ts` maps bare deps to the harness's copy;
add any new one there.

**A model library change reaches the harness but not the built app**
The harness consumes `dist/` through node's CommonJS entry; the Angular build
takes the ES module one. Both come out of `npm run build` in the library, but
only the ESM bundle exports named symbols, and it does so only because
`webpack.config.js` sets `output.library.type: 'module'` on that config. Without
it the file exports nothing but `default`, every import resolves to `undefined`,
and nothing fails until the widget runs in a browser — the domain harness stays
green throughout. The visual baseline is what catches it.

**Model library changes aren't visible to the harness**
The harness consumes `dist/`. Re-run `npm run build` in
`cedar-model-typescript-library` — there is no watch link between them.

**A test asserts something that looks wrong**
Check whether it sits in a "known defects (characterized, not endorsed)" block.
Those assert what CEE *does*, deliberately. See [CEE-ROADMAP.md](./CEE-ROADMAP.md) → Open findings.

---

## Release

`main` is owned by the release process. Work lands on `develop`.

Cutting and publishing a version is **[CEE-RELEASE-RUNBOOK.md](./CEE-RELEASE-RUNBOOK.md)** —
npm auth, the 2FA gotcha, and propagating the new version to the repos that
embed CEE. Don't duplicate any of that here.

One thing worth knowing before reading either doc: the root `package.json`
declares a `publishConfig` pointing at the Stanford Nexus registry, but that is
**not** what a release publishes. The release publishes the generated
`dist-npm` package, which has no `publishConfig` and therefore goes to public
npmjs. Reading the root manifest alone gives you the wrong answer.

Version is surfaced at runtime as `window.cedarEmbeddableEditorVersion`.
