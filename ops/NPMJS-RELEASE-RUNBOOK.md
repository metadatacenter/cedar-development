# CEDAR npmjs Release Runbook

Four packages reach public npmjs outside the normal CEDAR release, each on a version of its own:

- `cedar-model-typescript-library`, the TypeScript model library
- `cedar-embeddable-editor` (CEE)
- `cedar-embeddable-designer` (CED)
- `cedar-embeddable-term-picker` (CETP)

`cedarcli release npm` publishes them. It records each run in a ledger, carries every package from
its preparation on `develop` to its publication from `main` and back to the next development
version, and stops wherever it cannot prove that a step succeeded. The route alone writes each
repository's `main` and its `release-<version>` tags. CED's and CETP's `release-2.9.x` tags are
older: they mark CEDAR platform releases from before the two packages took versions of their own.

For development and test gates, see [FRONTEND-RUNBOOK.md](./FRONTEND-RUNBOOK.md#cee). For the
platform release that consumes the public CEE, CED and CETP packages, see
[RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md).

Publication is not a prerequisite for a development frontend build. Use `cedarcli build frontends`
for the complete local SNAPSHOT workflow or `cedarcli test frontends` for source checks. Both
include uncommitted sources and resolve component packages automatically. The explicit versions,
clean trees, commits and registry waits here apply only to the requested publication.

## Release Contract

The model library, CEE, CED and CETP have independent public versions. The route infers none from
another, and it never substitutes the newest public model for one the operator did not name.

A stable build of CEE, CED or CETP pins `cedar-model-typescript-library` exactly in every manifest
that names it: CEE's root and visual manifests, and the root manifest of CED and of CETP. The
production bundle contains that library; the published manifest does not leave it as a runtime
dependency for the embedding application to resolve. Consequently:

- releasing the model does not change an existing CEE, CED or CETP package;
- a component may deliberately embed an older public model version;
- a component release that pins a new model version follows the model's release, in the same run
  or an earlier one;
- the CEDAR release needs explicit public CEE, CED and CETP versions, not a model-version argument;
  and
- proving each public package executable byte-equivalent to the train's after the declared
  provenance substitutions also proves the bundled model code.

The Template Designer serves all three components from one shared build, and that build refuses a
component whose integration manifest records a model runtime other than the one the host installs.
Release CEE, CED and CETP against the same public model, therefore, or the Template Designer
cannot take them together.

### The Design Tokens Are a Build-Time Dependency

`@org.metadatacenter/cedar-design-tokens` supplies the shared font, type scale and palette from
CEDAR Nexus. Sass compiles those values into the bundle.

The package stays a build-time `devDependency`, because a public package must not require its
consumers to resolve CEDAR's Nexus packages. The route refuses a staged manifest that lists any
`@org.metadatacenter/` package among its dependencies.

A release builds with the token version the package's lock names. Nexus deletes development packages
a few days after they are published, so the route refuses to start when a lock names a Nexus package
Nexus no longer serves. Move the pin with `cedarcli publish components --apply` and plan again. If
token changes are required, publish them and move the pins before planning. Build trains enforce
token-first ordering automatically.

## Prerequisites

The route needs Node 24.22.1, which `cedarcli` puts first on `PATH` itself when the shell offers
another version. It also needs Java 17 for the model library's parity checks, which it resolves the
same way.

`npm whoami --registry=https://registry.npmjs.org/` must answer `metadatacenter`. Two-factor
authentication makes an interactive login awkward at publish time, so the working route is a
granular access token from the `metadatacenter` account with read and write permission on all
packages, placed in `~/.npmrc` as `//registry.npmjs.org/:_authToken=`. A token bypasses the OTP prompt
that `npm publish` would otherwise raise.

Keep npm credentials only in `~/.npmrc`. Never put a token, password, or OTP in a repository,
command transcript, release note, or runbook. Remove obsolete authentication settings such as
`always-auth`, which the route refuses. Harmless author-metadata warnings are advisory; see the
[shared install policy](RELEASE-RUNBOOK.md#what-plan-checks).

`gh` must be authenticated with write access to every repository a run releases, since the route
opens and merges a pull request, pushes a tag and drafts a GitHub release in each.

## Choosing the Inputs

A run names each package it releases as `<package>@<version>`, where the package is `model`,
`cee`, `ced` or `cetp`. Every version is explicit:

- `--next <package>@<base>` gives the base of each package's next development version, which must
  exceed the version being released.
- `--model-version <version>` gives the public model version CEE, CED and CETP pin, when the run
  does not release the model. When it does, they pin the model version the run publishes.
- `--notes <package>=<file>` gives the bullets of the package's release entry. CEE, CED and CETP
  require it, since each one's `CHANGELOG.md` takes the entry. For the model, which keeps no
  changelog, it is optional and supplies the GitHub release draft.

A notes file holds bullet lines, which may be grouped under Keep a Changelog subsection headings
such as `### Added`, and nothing else. The route writes the heading, the date and, for CEE, CED and
CETP, the sentence naming the model the package aligns with. CEE's 2.0.33 entry shows the result:

```markdown
## [2.0.33] - 2026-11-07

Aligns with `cedar-model-typescript-library@1.0.27`.

- Defers RDF processors in coordinated host builds and adopts the hosted-font design tokens.
- Isolates editor and field translation state and reuses strictly parsed field models during initialization.
```

`plan` checks every precondition and changes nothing:

```bash
cedarcli release npm plan model@1.0.28 cee@2.0.34 ced@0.1.0 cetp@0.1.0 \
  --next model@1.0.29 --next cee@2.0.35 --next ced@0.1.1 --next cetp@0.1.1 \
  --notes model=model-notes.md --notes cee=cee-notes.md \
  --notes ced=ced-notes.md --notes cetp=cetp-notes.md
```

It refuses a run when any of the following holds:

- a checkout is not on `develop`, holds uncommitted or untracked files, or differs from
  `origin/develop`;
- `main` holds commits `develop` lacks, since the release merge would then publish a tree nobody
  gated;
- the release tag already exists, a pull request from `develop` to `main` is already open, or the
  version is already on npmjs or is not newer than the public `latest`;
- a changelog holds notes under `## [Unreleased]`, which the release entry would leave above it,
  so they belong in `--notes` and the section comes off `develop` first;
- a component pins a model version npmjs does not serve, and the run does not release it;
- a lock names a Nexus package Nexus no longer serves;
- a component's `develop` does not pin one development model that Nexus still serves, which the
  route returns to after the release, and `--dev-model-version` names no other; or
- Node, npm, `~/.npmrc` or `gh` is not as the prerequisites describe.

`start` takes the same arguments, runs the same checks and then drives the run.

## The Route

The route releases the model first and then CEE, CED and CETP, one package at a time. Each package
passes through the stages below, and each stage records the evidence of its outcome in the ledger
before the next begins.

On `develop`, the route prepares and gates the release:

1. **prepare** sets the release version with `npm version`, which also updates the model's
   `package-dist.json` through its version hook, and gives that manifest the unscoped public name.
   For CEE, CED and CETP it instead pins the public model with `npm install --save-exact` in every
   graph that names it, and each must then resolve the same npmjs tarball. It also adds the
   changelog entry, changing nothing else in the file, and for CEE stamps `INNER_VERSION` with the
   preparation time. Notes under `## [Unreleased]` stay where they are, because the platform
   release cuts the new entry out again to prove each public package a promotion of its train's.
2. **gate** runs `npm ci` in every directory the package installs, which for CED and CETP includes
   `browser/`, then `npm run test:ci`. For CEE it also runs `cedarcli test cee-demos` against the
   staged package. The tree must be the one
   prepared, before and after.
3. **commit** commits the prepared paths, as `Prepare CEE release 2.0.34 with model library 1.0.28`
   or `Prepare TypeScript model library release 1.0.28`.
4. **push** pushes `develop`, which must not have moved on `origin` since the plan.

Through the pull request, the route waits for GitHub to test the commit:

5. **pull-request** opens a pull request from `develop` to `main`.
6. **checks** runs the repository's CI here on the preparation commit, through `cedarcli ci run`,
   when [local CI](BACKEND-RUNBOOK.md#local-ci) covers the repository, and posts the
   `cedar/local-ci` status. Where it does not, the stage waits until every workflow run on the
   commit, for the push and for the pull request, has finished green, and every check the pull
   request reports has passed. A run GitHub failed to start is rerun rather than taken for red.
7. **merge** merges with a merge commit, refusing if the pull request's head has moved, and proves
   that `origin/main` is that merge commit and holds the gated tree.

On `main`, the route builds and publishes:

8. **build-main** checks out the merge commit and runs `npm run test:package`, or `npm run dist`
   for CED and CETP. The staged manifest
   must carry the unscoped name and the release version, no `private` flag, no `publishConfig` and
   no Nexus-only dependency, and its README must be the repository's. The route packs that directory
   into a tarball, runs the CEE framework demos against the tarball, and makes a dry run that must
   name npmjs and the `latest` tag.
9. **publish** publishes the tarball itself, so the bytes on npmjs are the bytes the route gated and
   recorded. A version already on npmjs is accepted only when its integrity is the recorded one.
10. **verify** downloads the tarball npmjs serves and requires its SHA-512 and SHA-256 to be the
    recorded ones, `latest` to name the version, and the registry README to open with the
    repository's title. npmjs serves a new version a minute or two after the publish returns, so
    the route asks again for several minutes before it stops.
11. **tag** tags the merge commit `release-<version>` and proves `origin` holds the tag there.
12. **notes** drafts the GitHub release on the tag from the notes, linking the npm package. The draft
    stays unpublished.

Back on `develop`, the route returns the repository to development:

13. **develop** fast-forwards `develop` to the merge commit, or merges it when others pushed to
    `develop` meanwhile, which changes no tree. It sets `<next>-dev.<date>.<sha>` as the version and,
    for the model, restores the scoped Nexus name. CEE, CED and CETP return to the development
    model each pinned before the release. The route then runs the package's own check, commits
    `Advance CEE to the next development version` and pushes.
14. **development-checks** answers for the advance commit the same way: local CI where it covers
    the repository, otherwise every workflow run on the commit finished green. GitHub's run on that
    commit publishes the model's and CEE's development packages to Nexus, so when local CI answers,
    those packages appear only once GitHub's run finishes. CED's and CETP's CI publishes nothing.

The version committed in **develop** names the merge commit below it rather than the advance
commit, which does not exist while `npm version` runs. Whatever publishes the development package
derives its own `<base>-dev.<date>.<sha>` from the commit it builds, so the committed string is a
placeholder rather than an address. Against Nexus, `npm view` answers only for an exact
version, so the registry cannot be asked for it either. Derive the published version from the
advance commit, exactly as the workflow does:

```bash
printf '%s-dev.%s.%s\n' \
  "$(node -p "require('./package.json').version.split('-')[0]")" \
  "$(TZ=UTC git show -s --format=%cd --date=format:%Y%m%d HEAD)" \
  "$(git rev-parse --short=7 HEAD)"
```

Once every package is released, one closing stage runs for the whole run:

15. **baselines** refreshes the reviewed lock baselines of the released repositories, as
    `cedarcli publish baselines --refresh` does, and commits `ops/frontend-train.json` alone in
    `cedar-development`, leaving any other edit in that checkout untouched. While a platform release
    is active, the commit would move a repository its train captured, so the stage waits until that
    release concludes. `--defer-baselines` leaves the refresh to the operator instead. Leave it
    deferred, too, when a build train is waiting to back a CEDAR release that has not started, since
    the release refuses a `cedar-development` whose `develop` has moved since the train.

## Where the Route Stops

The route stops in one of two ways, and `cedarcli release npm resume` continues from the stage it
stopped at.

It **waits**, exiting with status 2, when something outside it has not happened yet: CI still
running three hours after the route began asking, npmjs not yet serving a published version, or a
platform release still active at the baselines stage. Nothing needs repairing; resume once the wait
is over.

It **fails**, exiting with status 1, when a stage's outcome is wrong: a red gate or CI run, a moved
`develop` or pull request head, a merge commit that does not hold the gated tree, or a published
version with other bytes. The ledger names the stage and the cause. Repair the cause and resume.

Every stage first asks whether its outcome already holds, so a run interrupted anywhere resumes
safely, including between a remote step and the record of it. A publish whose connection dropped
after the upload, for example, is proved on resume by the integrity npmjs reports.

`cedarcli release npm status` shows the run's stages and any wait or failure. The ledger and each
stage's command output are under `~/.cedar/npm-releases`, or the directory
`CEDAR_NPM_RELEASE_STATE_DIR` names. One run is active at a time.

`resume --dev-model-version <version>` names the development model CEE returns to, when Nexus has
deleted the one it pinned before the release.

A run carries its packages one after another, and an earlier package can wait hours for CI. A later
package's `develop` may move meanwhile, and its prepare stage then refuses a head the plan never
checked. `resume --rebase` runs the preflight again for every package the run has not started and
takes `develop`'s present head as its base. With `--notes <package>=<file>` it also replaces that
package's notes, for instance to fold in an entry the new commits added under `## [Unreleased]`.

`cedarcli release npm abandon --reason "<why>"` closes a run before any package has merged to `main`.
It lists what the run already pushed: a preparation commit on `develop` to revert and a pull request
to close. After a merge, `main` holds the release preparation, so the run can only be resumed.

## After the Route

The route publishes and tags. Four steps remain the operator's:

- Review and publish each GitHub release draft the route names, in the shape
  [Release Notes](#release-notes) describes. The model's release notes are its GitHub release;
  write them on the tag when the run had no model notes.
- Pin a public CEE in its consumers, as the next section describes. Publishing is not deployment.
  A public CED or CETP needs no such step: the next platform release, which names it with
  `--ced-version` or `--cetp-version`, pins it into the Template Designer.
- Once CI has published CEE's and the model's advanced `develop` heads to Nexus, `cedarcli publish
  components --apply` moves every CEE consumer from the public CEE onto that development package,
  and the model's consumers onto the model's newest one. It also builds and publishes CED's and
  CETP's advanced heads, which their CI does not, and moves the Template Designer onto them.
  [Recording a Pin](FRONTEND-RUNBOOK.md#recording-a-pin) describes how it follows each.
- Refresh and commit the lock baselines when the run deferred them.

## Propagate a Stable CEE Release

Publishing CEE does not update a frontend or an environment. Pin the exact stable version in all
declared consumer manifests and lockfiles with the maintained inventory helper:

```bash
node "$CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs" --apply <CEE_VERSION>
node "$CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs" --check <CEE_VERSION>
```

Review and commit each owning repository separately. Rebuild every deployed CEE host and verify the
served bundle hash; a manifest edit alone does not change a running frontend. The helper owns the consumer inventory; do not substitute a remembered list. Consumer installs
and lock regeneration must use the same peer-dependency mode as their CI (currently plain installs).
Local rebuild paths are in [FRONTEND-RUNBOOK.md](./FRONTEND-RUNBOOK.md#cee-getting-a-local-build-into-the-frontends);
served payloads and cache invalidation are in [PROD-DEPLOY-RUNBOOK.md](PROD-DEPLOY-RUNBOOK.md#6--verify-and-rebuild-every-cee-host-to-the-intended-version).

Pinning the release rewrites every one of those lockfiles, so all consumer dependency-graph digests the
train's dispatch preflight reads go stale at once and the next `cedarcli publish train` refuses with
`npm dependency graph changed for <repo>:<lockfile>`. Refresh the whole set rather than CEE's alone:

```bash
cedarcli publish baselines --refresh
git -C $CEDAR_HOME/cedar-development commit -m "Refresh the npm audit baselines the CEE pin moved" ops/frontend-train.json
git -C $CEDAR_HOME/cedar-development push origin develop
```

Review the refreshed digests and advisory counts before committing. Changed counts require a
dependency review; unchanged totals alone do not prove that the advisory identities are unchanged.

**Commit baselines before smoke.** A later commit invalidates the smoke record for the train's
source. Order: propagate, commit consumers, refresh and commit baselines, rebuild deployed
frontends, then run `cedarcli check ci` and `cedarcli test e2e`.

## Use the Public Packages in a Train-Backed CEDAR Release

The CEDAR release inputs are explicit. The CEDAR version is not parsed from the dev train string,
and the operator does not track or pass a manifest path:

```bash
cedarcli release plan \
  --version <CEDAR_VERSION> \
  --next-version <NEXT_SNAPSHOT_VERSION> \
  --from-train <TRAIN_ID> \
  --cee-version <CEE_VERSION> \
  --ced-version <CED_VERSION> \
  --cetp-version <CETP_VERSION>

cedarcli release start \
  --version <CEDAR_VERSION> \
  --next-version <NEXT_SNAPSHOT_VERSION> \
  --from-train <TRAIN_ID> \
  --cee-version <CEE_VERSION> \
  --ced-version <CED_VERSION> \
  --cetp-version <CETP_VERSION>
```

Each public package must have been published from the source the train tested. A commit to CEE, CED
or CETP on `develop` between its npm release and the train's capture changes what the train builds,
and the plan then refuses that package. Release the packages first, then dispatch the train.

The CLI owns its internal release manifest and resumes it with `cedarcli release resume`. The plan
first verifies each tarball and its own bundle manifest. It then requires the same package file set
and normalizes only this closed release-provenance list:

- package name, version, publish channel, and root lock identity;
- the one embedded CEE version and load trace in the browser bundle;
- the three strings an embedded root `package.json` carries, where the bundle embeds one, as CEE's
  did until 2.0.30: the model-package identity; the one design-token pin in its `devDependencies`,
  where the development pin must equal the train's planned token package and the public pin must
  be exact; and CEE's exact `allowScripts` install policy, which the planner reads from the train's
  captured CEE commit and permits exactly once. A bundle that embeds only its version carries none
  of the three, and both bundles must carry the same ones. Compiled styles remain subject to the
  full byte comparison; no other dependency or code is normalized;
- the bundle manifest derived from those browser-bundle bytes; and
- one dated changelog entry for the public CEE version, which must name one exact public model
  version. If the train predates that entry, removing it must reproduce the train changelog byte for
  byte; if the train already contains it, the two changelogs must already be byte-identical.

Packages carrying `integration.mjs` also prove that module's executable bytes. Its manifest may
change its source fingerprint and model package provenance only after the planner downloads both
exact model tarballs, verifies registry integrity, recomputes both recorded fingerprints and proves
the same model ESM and resolver metadata. Only model `name`, `version` and `publishConfig` are
removed for that comparison; every other runtime dependency must match exactly. The module's
licenses remain subject to the package-wide byte comparison, except for one exact notice heading
changing from `Package: @org.metadatacenter/cedar-model-typescript-library` to
`Package: cedar-model-typescript-library` after that runtime proof succeeds. Both headings must
occur exactly once in their respective packages, with no opposite-channel heading present; every
byte of license text and every other package notice must still match.

After those substitutions every remaining packaged byte must be identical, and the browser bundle
must be identical too, except for renaming short minified lexical bindings, which esbuild's
frequency-ordered name alphabet can produce from the provenance strings alone. The CLI's pinned
Acorn parser and ESLint scope analyzer resolve every declaration and reference: independent scopes
may reuse a name or rename it differently, but a reference must still resolve to the same binding.
Properties, public exports, imported names, globals, strings, regular expressions, punctuation and
longer identifiers cannot change. Renaming in a bundle with direct `eval` is refused. The CLI installs
these locked parser dependencies under `cedar-cli/scripts/javascript/node_modules` when needed;
CI installs them before testing. An undeclared or malformed install policy, adjacent JavaScript changes, a second
occurrence of a provenance literal, a changed older changelog entry, an extra file, or any other
JavaScript difference is a hard failure. This normalized byte proof is also the
proof for the model-library code compiled into CEE. The train development base may be newer than
the public version (for example, `2.0.4-dev…` versus `2.0.3`); version-name similarity is not release
evidence and is deliberately not a prerequisite for running the proof.

CED and CETP are proved by the same rules, with three differences. Their bundles carry no load trace
and embed no `package.json`, so none of the embedded policies above applies. A CED bundle reports
its version as one quoted literal, and a CETP bundle reports none. The proof is directional:
replacing that literal in the train's bundle with the public version must reproduce the public
bundle byte for byte. A short version such as `0.1.0` also occurs inside unrelated strings of the
bundle, so the proof never searches the public bundle for it. Each bundle manifest records
fingerprints of the build's inputs and output, which cover the package's `package.json` and its
installed model and so change with the channel. Those two fingerprints alone are set aside; every
other field of the manifest must match.

On `start`, that proven public CEE is pinned in all declared frontend consumers before either source
variant is stamped. The proven public CED and CETP are pinned into the Template Designer, their one
consumer, in place of the train's retained development copies. Both the release and next-development
Git trees retain the stable pins; the next-development tree does not silently return to the train's
development packages. The route then integrates those exact trees into `main` and `develop`,
publishes the stable frontend npm packages, and verifies their downloaded registry tarballs.
Workspace publishes with the other platform frontends. Operational details and resume rules are in
[RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md#the-route).

## Release Notes

The route drafts each GitHub release from the run's notes, opening with the npm package link and,
for CEE, CED and CETP, the sentence naming the model the package aligns with. Edit the draft before
publishing it.

CEE, CED and CETP release notes address embedders. Open with the version and npm package link, then
a short paragraph describing the main change. Use the changelog's Added, Changed, Removed, Fixed and
Security headings as applicable; lead bullets with the concrete change. Keep bullets to one or two
sentences (normally 20–30 words), selecting changes embedders need to know about rather than copying
the full changelog. Close with the prerelease-build information and full changelog link.

## Failure Rules

- A version already on npmjs is immutable. Choose a new version; never try to overwrite it.
- Never publish by hand while a run is active. Resume the run, so the published bytes stay the ones
  it gated and recorded.
- Never run `npm audit fix --force` during a release. Review dependency updates separately.
- If CEE staging says the browser bundle and manifest differ, resume the run, which rebuilds and
  reruns the gate.
- If a local CEE production build crashes but the exact commit is green in CI, do not publish old
  local output. Diagnose the host, or recover the exact `cee-production-dist` artifact from that CI
  run, regenerate the bundle and package from it, and confirm its SHA-256 matches the green gate
  before publishing.
- Publishing is not deployment. Consumer propagation, rebuild, served-byte verification, and cache
  invalidation remain required before an environment is running the release.
