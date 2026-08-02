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

Expect **1,016 passing**. Watch mode is `npm run test:watch`.

To run one file (note: paths are relative to the repo root, not `harness/`,
because `vitest.config.ts` sets `root` to the repo):

```bash
npx vitest run harness/test/controlled-terms.spec.ts
```

### Running against the old template parser

CEE builds its component tree with the CEDAR Model TypeScript Library. The
hand-written JSON walk it used before is still in the tree, and the whole suite
has to pass with either one underneath:

```bash
CEE_TEMPLATE_PARSER=json-walk npm test
```

Expect **1,016 passing** here too. Four rendered list fields across the corpus
genuinely differ — `multipleChoice` normalised against the property's
cardinality rather than copied verbatim — and `harness/test/corpus.spec.ts`
names them one by one, so a difference that stops happening fails as loudly as a
new one. Run this before and after anything that touches
`factory/model-library-template-parser.ts`.

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
