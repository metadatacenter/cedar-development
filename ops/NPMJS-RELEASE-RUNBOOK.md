# CEDAR npmjs Release Runbook

How to publish the two independent public npm packages that sit outside the normal CEDAR release:

- `cedar-model-typescript-library`
- `cedar-embeddable-editor` (CEE)

This is the operational release procedure. For development, architecture, and the complete test
surfaces, see [FRONTEND-RUNBOOK.md](./FRONTEND-RUNBOOK.md#cee). For the platform release that consumes a public
CEE package, see [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md).

## Release Contract

The model library and CEE have independent public versions. Do not infer one from the other and do
not automatically substitute the newest public model into a CEE release.

Choose all versions explicitly before changing a repository:

```bash
export MODEL_VERSION=<public-model-version>       # for example 1.0.3
export CEE_VERSION=<public-cee-version>           # for example 2.0.2
export MODEL_NEXT=<next-model-base>               # for example 1.0.5
export CEE_NEXT=<next-cee-base>                   # for example 2.0.3
```

A stable CEE build pins `cedar-model-typescript-library` exactly in both its root and visual
manifests. The production bundle contains that library; CEE's published manifest does not leave it
as a runtime dependency for the embedding application to resolve. Consequently:

- releasing the model does not change an existing CEE package;
- CEE may deliberately embed an older public model version;
- the CEDAR release needs an explicit public CEE version, not a second model-version argument; and
- proving the public CEE executable byte-equivalent to the train CEE after the declared provenance
  substitutions also proves the bundled model code.

### The Design Tokens Are a Build-Time Dependency

CEDAR's design values — the font stack, the type scale, the brand palettes and the neutrals — are
published from `cedar-design-tokens` as `@org.metadatacenter/cedar-design-tokens`, under the scope
`.npmrc` routes to the CEDAR Nexus registry. Sass reads those values and compiles them away, so a
built bundle carries the numbers and colours and no reference to the package.

The package stays a `devDependency`, and the published manifest may not name it at all. A scoped
name resolves only from Nexus, and an embedding application installing public CEE from npmjs cannot
reach that registry: the install fails with a 404 against a host it holds no credentials for. Check
the staged `dist-npm/cedar-embeddable-editor/package.json`, rather than the repository's manifest:

```bash
node -e "const p=require('./dist-npm/cedar-embeddable-editor/package.json');
console.log(Object.keys({...p.dependencies, ...p.peerDependencies}).filter(d => d.startsWith('@org.metadatacenter/')))"
```

An empty list is the only passing answer.

A release build resolves whatever snapshot Nexus holds when it starts. Publish the tokens first and
raise CEE's dependency to that version before building, or the bundle carries the values of the
previous snapshot — the same ordering `cedarcli` enforces for a build train by registering the
package ahead of every npm repository that consumes it.

## Shared Prerequisites

Use Node 24.19.0 for both repositories. On the CEDAR development machine it is installed by
Homebrew but is not the shell default:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version                    # must print v24.19.0
npm whoami                        # must print metadatacenter
```

Trust the version the binary prints, not the path it came from. Homebrew's `node@NN` opt
directories on this machine are symlinks into whichever single `node` keg is installed, so
`node@25/bin/node` can report v26.

`npm whoami` must answer `metadatacenter`. Two-factor authentication makes an interactive login
awkward at publish time, so the working route is a granular access token from the
`metadatacenter` account with read and write permission on all packages, placed in `~/.npmrc` as
`//registry.npmjs.org/:_authToken=`. A token bypasses the OTP prompt that `npm publish` would
otherwise raise.

Keep npm credentials only in `~/.npmrc`. Never put a token, password, or OTP in a repository,
command transcript, release note, or runbook. The repeated warnings about obsolete `always-auth`,
`email`, and `init.author` keys do not change the package being built; clean them up separately,
not during a release.

Before each release:

```bash
git status --short --branch       # clean working tree
git fetch origin
git tag --list "release-${MODEL_VERSION}"
git tag --list "release-${CEE_VERSION}"
```

The relevant tag must not already exist. Check the public target too: npm versions are immutable,
so a published version cannot be corrected in place.

```bash
npm view "cedar-model-typescript-library@${MODEL_VERSION}" version \
  --registry=https://registry.npmjs.org/
npm view "cedar-embeddable-editor@${CEE_VERSION}" version \
  --registry=https://registry.npmjs.org/
```

An `E404` is expected for a new version. An authentication failure can also appear as `E404`, which
is why `npm whoami` comes first.

## Release the TypeScript Model Library

Skip this section when CEE will embed an already-published model version. A model release is not a
required preamble to every CEE release.

This runbook is the whole procedure. The repository carries no release document of its own.

### Prepare on `develop`

```bash
cd "$CEDAR_HOME/cedar-model-typescript-library"
git checkout develop
git pull --ff-only origin develop
git status --short
node -p "require('./package.json').version"
```

If the root does not already have the requested version, set it through npm so the repository's
version hook synchronizes `package-dist.json`:

```bash
npm version "$MODEL_VERSION" --no-git-tag-version
```

For a public release, `package-dist.json` must contain the unscoped name:

```json
"name": "cedar-model-typescript-library"
```

The scoped `@org.metadatacenter/cedar-model-typescript-library` name belongs only to Nexus dev
snapshots. Confirm all three version locations and the publish identity:

```bash
node - <<'NODE'
const root = require('./package.json');
const lock = require('./package-lock.json');
const dist = require('./package-dist.json');
console.log({
  root: `${root.name}@${root.version}`,
  lock: lock.version,
  lockedRoot: lock.packages[''].version,
  published: `${dist.name}@${dist.version}`,
});
NODE
```

Add or update the release notes required by the repository, then run the complete gate:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run parity:yaml
npm run parity:json
npm run test:package
```

A YAML parity failure that shows the fixture quoted (`type: "text-field"`) against plain output
(`type: text-field`) is a half-updated working tree, with `src/` from one branch and
`itest/resources/` fixtures from another. Let the checkout or merge finish and run it again
rather than reading it as a real failure.

`test:package` builds `dist/`, packs it, installs it into an isolated consumer, and exercises its
CommonJS, ESM, and TypeScript declaration entry points. It also copies the repository `README.md`
into the distributable. Confirm the exact identity and README before committing:

```bash
node -p "require('./dist/package.json').name + '@' + require('./dist/package.json').version"
cmp -s README.md dist/README.md
npm publish ./dist --access public --dry-run
```

The dry run must name `cedar-model-typescript-library@${MODEL_VERSION}`, public npmjs, `index.js` as
`main`, `index.esm.js` as `module`, and the expected README. Always write `./dist`; bare `dist` is
interpreted as an unrelated registry package name by npm 11.

### Commit, Merge, and Publish from `main`

Commit only the release preparation files, push `develop`, and open a pull request to `main`:

```bash
git add package.json package-lock.json package-dist.json README.md
git commit -m "Prepare TypeScript model library release ${MODEL_VERSION}"
git push origin develop
export MODEL_PREP_COMMIT=$(git rev-parse HEAD)
gh pr create --base main --head develop --title "Release ${MODEL_VERSION}"
```

Omit unchanged paths from `git add`. Wait for the required checks, merge the pull request, and
confirm `main` contains exactly the prepared tree:

```bash
gh pr merge --merge
git checkout main
git pull --ff-only origin main
git diff --exit-code "$MODEL_PREP_COMMIT" HEAD
git log -1 --oneline
```

Rebuild and recheck on `main`, then publish that exact directory:

```bash
npm run test:package
cmp -s README.md dist/README.md
npm publish ./dist --access public --dry-run
npm publish ./dist --access public
```

Verify the registry rather than trusting only the publish command's exit status:

```bash
npm view "cedar-model-typescript-library@${MODEL_VERSION}" \
  name version main module types license dist-tags dist --json \
  --registry=https://registry.npmjs.org/
npm view "cedar-model-typescript-library@${MODEL_VERSION}" readme \
  --registry=https://registry.npmjs.org/
```

`latest` must name `${MODEL_VERSION}` and the README must begin with the repository's CEDAR Model
TypeScript Library README, not generated package metadata or unrelated YAML documentation.

npmjs does not serve a new version the moment `npm publish` returns. The publish prints that the
package is being processed, and the first verification can answer `E404` for a minute or two while
it is: 1.0.7 took about a hundred seconds to become visible. Retry the same query rather than
concluding the publish failed, and treat an `E404` as settled only once a later attempt agrees.

The repository keeps no changelog, so its release notes are the GitHub release on the tag. Write
them when tagging, in the shape the previous release used.

Tag the exact `main` commit that produced the tarball:

```bash
git tag "release-${MODEL_VERSION}"
git push origin "release-${MODEL_VERSION}"
```

### Restore Model Development State

Fast-forward `develop` through the release merge, then derive the next dev identity from that exact
merge commit. The dev package is scoped so npm routes it to the CEDAR Nexus registry.

```bash
git checkout develop
git merge --ff-only main
export DEV_SHA=$(git rev-parse --short HEAD)
export DEV_DATE=$(git show -s --format=%cd --date=format:%Y%m%d HEAD)
npm version "${MODEL_NEXT}-dev.${DEV_DATE}.${DEV_SHA}" --no-git-tag-version
```

Restore this name in `package-dist.json`:

```json
"name": "@org.metadatacenter/cedar-model-typescript-library"
```

Run `npm run test:package`, confirm the staged identity is scoped, then commit and push. Do not
publish the dev package merely because the stable release advanced; `cedarcli publish train`
creates and records train-owned dev packages when a train needs one.

```bash
git add package.json package-lock.json package-dist.json
git commit -m "Advance TypeScript model library to the next development version"
git push origin develop
```

**The version committed here is not the version published.** The publishing workflow derives its own
`<base>-dev.<date>.<sha>` from the commit it builds, which is this advance commit — and that commit
does not exist while `npm version` is running, so the string written above can only name the release
merge before it. On 2026-09-14 `package.json` said `1.0.11-dev.20260914.2696f4a` while Nexus received
`1.0.11-dev.20260914.35d400b`.

Nothing there needs correcting. Every commit on `develop` gets a dev package of its own and none
overwrites another, which is the property the workflow derives the version for. What it means is that
the committed string is a placeholder rather than an address: a pin taken from `package.json` answers
`E404`. Nor can the registry be asked — against Nexus, `npm view` answers only for an exact version,
so `dist-tags` and `versions` both come back empty.

Derive it instead, exactly as the workflow does, from the commit just pushed. The date is the commit
date in UTC, which is not always the local one:

```bash
printf '%s-dev.%s.%s\n' \
  "$(node -p "require('./package.json').version.split('-')[0]")" \
  "$(TZ=UTC git show -s --format=%cd --date=format:%Y%m%d HEAD)" \
  "$(git rev-parse --short=7 HEAD)"
```

## Release CEE with an Explicit Model Version

The public model version is an input to the CEE release. It must already exist on npmjs and is
pinned exactly in both CEE dependency graphs.

### Prepare on `develop`

```bash
cd "$CEDAR_HOME/cedar-embeddable-editor"
git checkout develop
git pull --ff-only origin develop
git status --short
npm view "cedar-model-typescript-library@${MODEL_VERSION}" \
  version dist.integrity --json --registry=https://registry.npmjs.org/
```

Incorporate `main` before preparing the release if the branches have diverged. Resolve that merge
on `develop`, never while packaging or after publication.

Set the CEE version only when it is not already correct:

```bash
node -p "require('./package.json').version"
npm version "$CEE_VERSION" --no-git-tag-version
```

Pin the chosen public model version in both graphs and regenerate both lockfiles:

```bash
npm install --save-exact "cedar-model-typescript-library@${MODEL_VERSION}"
npm --prefix visual install --save-exact "cedar-model-typescript-library@${MODEL_VERSION}"
```

Assert the two dependency graphs are identical rather than checking them by eye:

```bash
node - <<'NODE'
const expected = process.env.MODEL_VERSION;
const root = require('./package.json');
const visual = require('./visual/package.json');
const rootLock = require('./package-lock.json');
const visualLock = require('./visual/package-lock.json');
const dependency = 'cedar-model-typescript-library';
const rootResolved = rootLock.packages[`node_modules/${dependency}`];
const visualResolved = visualLock.packages[`node_modules/${dependency}`];

if (root.dependencies[dependency] !== expected || visual.dependencies[dependency] !== expected) {
  throw new Error('root and visual manifests do not pin the requested public model version');
}
if (rootResolved.version !== expected || visualResolved.version !== expected) {
  throw new Error('root and visual lockfiles do not resolve the requested public model version');
}
if (!rootResolved.resolved.startsWith('https://registry.npmjs.org/') ||
    !visualResolved.resolved.startsWith('https://registry.npmjs.org/')) {
  throw new Error('a stable CEE model dependency did not resolve from public npmjs');
}
if (rootResolved.resolved !== visualResolved.resolved ||
    rootResolved.integrity !== visualResolved.integrity) {
  throw new Error('root and visual resolve different model tarballs');
}
console.log(`${dependency}@${expected}`, rootResolved.integrity);
NODE
```

Both manifests now say the same exact unscoped version. Both lockfiles resolve the same npmjs
tarball and integrity; neither resolves `@org.metadatacenter/...` or Nexus in a stable release.

Add `## [${CEE_VERSION}] - <date>` to `CHANGELOG.md`. **Add it and change nothing else.** The release
proves the public package is a promotion of the train's by cutting that one dated entry out of the
public changelog, from its heading to the next `## [`, and requiring what remains to equal the
train's changelog byte for byte. Anything else that moves breaks that equality: entries relocated
from `## [Unreleased]` into the new section leave an empty `Unreleased` behind, which is not what the
train captured, and the release refuses with `CEE promotion changes CHANGELOG.md outside the one
current-release entry`.

So the entry records what this release is — the public model version it aligns to, which it must
declare exactly once — and the notes already under `## [Unreleased]` stay there. The 2.0.3 entry is
the shape to copy: a heading, a sentence naming the model, and one bullet. Its diff is additions
only.

That constraint applies when the train was built before the release entry existed. Publish CEE
first and build the train afterwards and it does not arise at all: the two changelogs are then
identical, and the release compares bundle provenance instead. Either order is supported; the
second is harder to get wrong, and its cost is that the train cannot be built in parallel with the
release preparation.

Update `CedarEmbeddableMetadataEditorComponent.INNER_VERSION` to the release preparation time. That
stamp is only the load trace; `package.json` supplies the public runtime version.

Run the complete release gate:

```bash
npm ci
npm --prefix harness ci
npm --prefix visual ci
npm run test:ci
```

This covers lint, strict type checks, unit/coordinator/domain tests, a production build, all
Playwright browsers and viewports, bundle size, public declarations, the packaged README example,
and byte-for-byte staging under `dist-npm/cedar-embeddable-editor/`.

Confirm the exact publish identity and inputs:

```bash
node - <<'NODE'
const root = require('./package.json');
const visual = require('./visual/package.json');
const staged = require('./dist-npm/cedar-embeddable-editor/package.json');
console.log({
  cee: root.version,
  rootModel: root.dependencies['cedar-model-typescript-library'],
  visualModel: visual.dependencies['cedar-model-typescript-library'],
  staged: `${staged.name}@${staged.version}`,
});
NODE
cmp -s README.md dist-npm/cedar-embeddable-editor/README.md
npm publish ./dist-npm/cedar-embeddable-editor --dry-run
```

The staged identity must be unscoped `cedar-embeddable-editor@${CEE_VERSION}`. The dry run must
name `https://registry.npmjs.org/` and tag `latest`. The README comparison must succeed: the root
GitHub README is intentionally the npm README.

CEE deliberately has no `package-dist.json`. `scripts/npm-package.mjs` derives the public unscoped
identity from a stable version and the scoped Nexus identity from a `-dev.` version. Do not add a
second hand-maintained manifest.

### Commit, Merge, and Publish from `main`

Stage only the release files that actually changed. They normally include the two manifests, two
lockfiles, changelog, and load-trace stamp; package-gate or README improvements may add more.

```bash
git add package.json package-lock.json visual/package.json visual/package-lock.json \
  CHANGELOG.md \
  src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts
git commit -m "Prepare CEE release ${CEE_VERSION} with model library ${MODEL_VERSION}"
git push origin develop
export CEE_PREP_COMMIT=$(git rev-parse HEAD)
gh pr create --base main --head develop --title "Release CEE ${CEE_VERSION}"
```

The token-adoption PR check compares against `main`, so a baseline that passes against the
previous `develop` commit can still fail here. For 2.0.17, one pager padding allowance had grown
since the preceding release. Replacing literal `6px` with the equivalent shared spacing expression
and removing that allowance preserved compiled output while satisfying the release comparison.
Do not raise the baseline to make a release PR green.

Wait for the prepare job and every visual shard. Merge only when they are green:

```bash
gh pr merge --merge
git checkout main
git pull --ff-only origin main
git diff --exit-code "$CEE_PREP_COMMIT" HEAD
git log -1 --oneline
```

Rebuild and stage on `main`, repeat the identity/README/dry-run checks, and then publish the exact
staged directory:

```bash
npm run test:package
cmp -s README.md dist-npm/cedar-embeddable-editor/README.md
npm publish ./dist-npm/cedar-embeddable-editor --dry-run
npm publish ./dist-npm/cedar-embeddable-editor
```

Never run `npm publish` from the repository root. It would pack the source repository instead of
the tested distributable.

Verify the public registry and README:

```bash
npm view "cedar-embeddable-editor@${CEE_VERSION}" \
  name version main types license dist-tags dist --json \
  --registry=https://registry.npmjs.org/
npm view "cedar-embeddable-editor@${CEE_VERSION}" readme \
  --registry=https://registry.npmjs.org/
```

`latest` must name `${CEE_VERSION}` and the README must begin `# CEDAR Embeddable Editor (CEE)`.
The registry takes a minute or two to serve a freshly published version, as it does for the model.
Record the tarball shasum/integrity and the bundle SHA-256 from `bundle-manifest.json` in the release
evidence.

Tag the exact published `main` commit:

```bash
git tag "release-${CEE_VERSION}"
git push origin "release-${CEE_VERSION}"
```

### Restore CEE Development State

Fast-forward `develop` through the release merge. Choose an exact, already-published scoped model
snapshot for development; do not invent or reference a Nexus version that was never published. The
model library's own `package.json` does not name it — derive the published version the way
[Restore model development state](#restore-model-development-state) shows.

CEE's advanced version has the same property: the string committed below names the release merge,
while the push CI publishes one derived from the advance commit it builds.

```bash
export MODEL_DEV_VERSION=<published-model-dev-version>
git checkout develop
git merge --ff-only main
export DEV_SHA=$(git rev-parse --short HEAD)
export DEV_DATE=$(git show -s --format=%cd --date=format:%Y%m%d HEAD)
npm version "${CEE_NEXT}-dev.${DEV_DATE}.${DEV_SHA}" --no-git-tag-version
npm install --save-exact \
  "cedar-model-typescript-library@npm:@org.metadatacenter/cedar-model-typescript-library@${MODEL_DEV_VERSION}"
npm --prefix visual install --save-exact \
  "cedar-model-typescript-library@npm:@org.metadatacenter/cedar-model-typescript-library@${MODEL_DEV_VERSION}"
```

Update `INNER_VERSION` to `<YYYY-MM-DD HH:MM> <DEV_SHA>`. Run the full gate, commit the five normal
post-release files, push, and wait for the push CI to finish:

```bash
npm run test:ci
git add package.json package-lock.json visual/package.json visual/package-lock.json \
  src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts
git commit -m "Advance CEE to the next development version"
git push origin develop
```

The advanced version changes the root lockfile's own version entry, so the train's baseline for
that lock is now stale and the next dispatch would refuse it. Refresh the CEE baselines and commit
the result in `cedar-development`:

```bash
cedarcli publish baselines --refresh --repository cedar-embeddable-editor
git -C $CEDAR_HOME/cedar-development commit -m "Refresh the CEE npm audit baselines" ops/frontend-train.json
git -C $CEDAR_HOME/cedar-development push origin develop
```

That is CEE's own baseline alone. Pinning the release into its consumers moves seven more, so going
straight on to [Propagate a stable CEE release](#propagate-a-stable-cee-release) means refreshing
all eight together there instead of committing the same file twice.

## Propagate a Stable CEE Release

Publishing CEE does not update a frontend or an environment. Pin the exact stable version in all
seven consumer manifests and lockfiles with the maintained inventory helper:

```bash
node "$CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs" --apply "$CEE_VERSION"
node "$CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs" --check "$CEE_VERSION"
```

Review and commit each owning repository separately. Rebuild every deployed CEE host and verify the
served bundle hash; a manifest edit alone does not change a running frontend. The helper owns the consumer inventory; do not substitute a remembered list. Consumer installs
and lock regeneration must use the same peer-dependency mode as their CI (currently plain installs).
Local rebuild paths are in [FRONTEND-RUNBOOK.md](./FRONTEND-RUNBOOK.md#cee-getting-a-local-build-into-the-frontends);
served payloads and cache invalidation are in [PROD-DEPLOY-RUNBOOK.md](PROD-DEPLOY-RUNBOOK.md#6--verify-and-rebuild-every-cee-host-to-the-intended-version).

Pinning the release rewrites every one of those lockfiles, so all seven dependency-graph digests the
train's dispatch preflight reads go stale at once and the next `cedarcli publish train` refuses with
`npm dependency graph changed for <repo>:<lockfile>`. Refresh the whole set rather than CEE's alone:

```bash
cedarcli publish baselines --refresh
git -C $CEDAR_HOME/cedar-development commit -m "Refresh the npm audit baselines the CEE pin moved" ops/frontend-train.json
git -C $CEDAR_HOME/cedar-development push origin develop
```

The refresh prints each digest and the four severity counts on either side of it, and those counts
are the review. Unchanged counts say the new editor carries no advisory the previous one did not.
A count that moved is a dependency review to hold before the train, not after it.

**Refresh before the smoke gate, not after.** Those baselines live in `cedar-development`, which is
itself one of the sources a smoke run records, so committing them after `cedarcli test e2e` moves
that source out from under the record the train is about to ask for — and the dispatch refuses a
second time, with `no passing whole-stack smoke run covers this source`. The order that holds is:
propagate, commit each consumer, refresh and commit the baselines, rebuild the deployed frontends,
then `cedarcli check ci` and `cedarcli test e2e`.

## Use the Public CEE in a Train-Backed CEDAR Release

The CEDAR release inputs are explicit. The CEDAR version is not parsed from the dev train string,
and the operator does not track or pass a manifest path:

```bash
cedarcli release plan \
  --version <CEDAR_VERSION> \
  --next-version <NEXT_SNAPSHOT_VERSION> \
  --from-train <TRAIN_ID> \
  --cee-version "$CEE_VERSION"

cedarcli release start \
  --version <CEDAR_VERSION> \
  --next-version <NEXT_SNAPSHOT_VERSION> \
  --from-train <TRAIN_ID> \
  --cee-version "$CEE_VERSION"
```

The CLI owns its internal release manifest and resumes it with `cedarcli release resume`. The plan
first verifies each tarball and its own bundle manifest. It then requires the same package file set
and normalizes only this closed release-provenance list:

- package name, version, publish channel, and root lock identity;
- the one embedded CEE version, model-package identity, and load trace in the browser bundle;
- the bundle manifest derived from those browser-bundle bytes;
- CEE's exact `allowScripts` install policy if embedded from root `package.json`: the planner reads
  it from the train's captured CEE commit and permits its minified literal exactly once; and
- one dated changelog entry for the public CEE version, which must name one exact public model
  version. If the train predates that entry, removing it must reproduce the train changelog byte for
  byte; if the train already contains it, the two changelogs must already be byte-identical.

After those substitutions every remaining packaged byte must be identical, and the browser bundle
must be identical too, except for a consistent renaming of short minified identifiers, which
esbuild's frequency-ordered name alphabet can produce from the provenance strings alone. Renaming
must be consistent in both directions; properties, reserved words and longer identifiers cannot
change. An undeclared or malformed install policy, adjacent JavaScript changes, a second
occurrence of a provenance literal, a changed older changelog entry, an extra file, or any other
JavaScript difference is a hard failure. This normalized byte proof is also the
proof for the model-library code compiled into CEE. The train development base may be newer than
the public version (for example, `2.0.4-dev…` versus `2.0.3`); version-name similarity is not release
evidence and is deliberately not a prerequisite for running the proof.

On `start`, that proven public CEE is pinned in all seven frontend consumers before either source
variant is stamped. Both the release and next-development Git trees retain the stable CEE pin; the
next-development tree does not silently return to the train's development CEE. The route then
integrates those exact trees into `main` and `develop`, publishes the stable frontend npm packages,
and verifies their downloaded registry tarballs. Workspace receives the same Git wiring but keeps
its independent package publication path. Operational details and resume rules are in
[RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md#the-route).

## Release Notes

CEE release notes address embedders. Open with the version and npm package link, then a short
paragraph describing the main change. Use the changelog's Added, Changed, Removed, Fixed and
Security headings as applicable; lead bullets with the concrete change. Keep bullets to one or two
sentences (normally 20–30 words), selecting changes embedders need to know about rather than copying
the full changelog. Close with the prerelease-build information and full changelog link. Review the
GitHub release draft before publishing it.

## Failure Rules

- A version already on npmjs is immutable. Stop and choose a new version; never try to overwrite it.
- A wrong package name or registry in a dry run is a stop condition, not a warning.
- A dirty worktree is a stop condition because npm does not record which uncommitted bytes it packed.
- `Version not changed` means the requested version is already in `package.json`; verify it and do
  not rerun `npm version`.
- Never run `npm audit fix --force` during a release. Review dependency updates separately.
- If CEE staging says the browser bundle and manifest differ, rebuild and rerun the browser gate.
- If a local CEE production build crashes but the exact commit is green in CI, do not publish old
  local output. Diagnose the host or recover the exact `cee-production-dist` artifact from that CI
  run, regenerate the bundle/package from it, and confirm its SHA-256 matches the green gate before
  publishing.
- Publishing is not deployment. Consumer propagation, rebuild, served-byte verification, and cache
  invalidation remain required before an environment is running the release.
