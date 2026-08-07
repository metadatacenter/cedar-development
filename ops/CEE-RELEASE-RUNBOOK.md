# CEDAR Embeddable Editor (CEE) — npm Release Runbook

How to cut a **CEE** build and publish it, then propagate it to the CEDAR repos that embed it.

There are two different targets, and they are not two ways of doing one thing:

- **Dev builds → Stanford Nexus**, as the scoped package `@org.metadatacenter/cedar-embeddable-editor`
  under the `dev` tag. This is what the repo's tooling produces today, and it is the path described
  below. Nothing picks a dev build up implicitly — every embedding repo pins the *unscoped* package.
- **Stable releases → public npmjs**, as the unscoped `cedar-embeddable-editor`. This is what all
  eight embedding manifests still depend on (`^1.5.2`), and the last one published this way was
  1.5.1. **The current tooling does not produce it** — see "Stable releases" at the end before
  attempting one.

Sibling runbooks:
- [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) — building and testing CEE.
- [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) — cutting a full CEDAR release.
- [PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) — deploying CEDAR to prod (step 6 rebuilds the
  template editor against the CEE version — that's how CEE reaches prod).

> `gocee`, `gocedar`, `goartifacts`, `gobridging` are CEDAR profile aliases (cd to the respective
> repo). **Never commit npm tokens, passwords, or OTPs.**

## Prerequisites — registry auth

A dev publish needs a Nexus credential, already present on a configured machine as
`//nexus.bmir.stanford.edu/repository/npm-cedar/:_authToken` in `~/.npmrc`, together with
`@org.metadatacenter:registry` pointing at the same Nexus repository. Confirm both without printing
the token:

```bash
npm config get @org.metadatacenter:registry
```

That should print the Nexus URL. A token is a credential — keep it in `~/.npmrc` only, never in a
repo or these notes.

## 1 · Bump the version

The dev version names the commit whose content is being published:
`1.6.0-dev.<YYYYMMDD>.<sha>`, where the date is that commit's date. So the bump commit itself
carries a version naming its *parent*, which is expected.

Only **two** files hold the version by hand:

| File | Occurrences |
|---|---|
| `package.json` | 1 (`"version"`) |
| `package-lock.json` | 2 (top-level `"version"` + the root `""` package entry) |

The `dist-npm/cedar-embeddable-editor/` manifests are **generated** — `scripts/npm-package.mjs`
derives them from the root `package.json`. Do not hand-edit them; staging overwrites them. (Older
notes describing "six version spots" predate that script.)

Then add a `## [X.Y.Z] - <date>` section to `CHANGELOG.md`, and bump the load-trace stamp in
`src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts`
→ `private static INNER_VERSION = '<YYYY-MM-DD HH:MM>';`.

> `ceeVersion` derives from `package.json` and is exposed as `window.cedarEmbeddableEditorVersion`,
> so bumping `package.json` is what drives the visible version. `INNER_VERSION` is only the stamp
> logged at load. `README.md` and `CHANGELOG.md` are copied into the package by staging — no manual
> `cp` step.

## 2 · Build and browser-test

```bash
npm run test:visual
```

This builds production and runs the Playwright baseline, and it is not optional: staging publishes
`visual/public/cedar-embeddable-editor.js` and refuses to run unless that file's sha256 and byte
count match `visual/public/bundle-manifest.json`. The published artifact is therefore always the
exact bundle a browser exercised — that guarantee is the reason the step exists, so don't reach for
a bare `ng build` to save a minute.

## 3 · Stage the package

```bash
npm run package:npm:prebuilt
```

Checks the bundle is fresh and within its size budget, writes the five-file package into
`dist-npm/cedar-embeddable-editor/`, then re-verifies every staged byte against its source. It
prints the version, size and sha256 it staged — read them.

## 4 · Publish to Nexus

```bash
cd dist-npm/cedar-embeddable-editor && npm publish --tag dev
```

> **Pass `--tag dev` explicitly.** The staged manifest carries `publishConfig.tag: "dev"`, and on
> npm 10.8.2 that is *not* enough: a dry run reports "Publishing to … **with tag latest**" and only
> honours `dev` when the flag is on the command line. Without it a dev build becomes the default
> install for the scoped package. Verify with a dry run first — it names both the registry and the
> tag, which is the cheapest way to catch a wrong target before it is permanent:
>
> ```bash
> npm publish --dry-run --tag dev
> ```

Then confirm what moved:

```bash
npm dist-tag ls @org.metadatacenter/cedar-embeddable-editor
```

Only `dev` should point at the new version. If a `latest` appears, a dev build was published
without the flag.

## 5 · Propagate

Eight manifests across six repos depend on CEE, all on the unscoped `cedar-embeddable-editor`:

| Repo | Manifest |
|---|---|
| `cedar-template-editor` | `package.json` |
| `cedar-artifacts` | `cedar-artifacts-src/package.json` |
| `cedar-bridging` | `cedar-bridging-src/package.json` |
| `cedar-openview` | `cedar-openview-src/package.json` |
| `cedar-component-demo` | `cedar-cee-demo-angular-src`, `cedar-cee-demo-ember-src`, `cedar-cee-demo-react`, `cedar-cee-docs-angular-src` |

**A Nexus dev build reaches none of them**, because it is a different package name. To try one in a
consumer, install the scoped package there deliberately; don't expect a reinstall to find it.

For a stable npmjs release, each repo takes the new version in its `package.json`, then reinstall,
rebuild, commit, push. `cedar-template-editor` uses a caret and picks it up on the next
`npm install` + `gulp`, which happens during a prod deploy
([PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) step 6).

```bash
goartifacts && npm install && cd .. && cedarcli build this
gobridging  && npm install && cd .. && cedarcli build this
```

> `cedar-cee-demo-angular-src` needs `npm install --legacy-peer-deps`; the others do not.

## Stable releases to public npmjs

Read this before cutting one. The tooling in `scripts/npm-package.mjs` hardcodes the scoped name and
takes its registry from the root `package.json`'s `publishConfig`, which points at Nexus. So there
is currently **no supported path that produces the unscoped npmjs package** the embedding repos
depend on — publishing one means either changing that script or hand-assembling a package, and it is
a decision about where CEE is distributed rather than a command to run. Raise it before improvising.

What the older notes said about npmjs auth still applies if that decision is taken: publishing needs
rights on `cedar-embeddable-editor`, npm requires 2FA (`npm publish --otp=<code>`, or a granular
access token with "Bypass 2FA" in `~/.npmrc`), and an `E404` on publish means unauthenticated rather
than missing — check `npm whoami`.

## Gotchas

- **`publishConfig.tag` is not honoured on npm 10.8.2.** Pass `--tag dev`. A dry run tells you which
  tag will actually be used.
- **Publish only from `dist-npm/cedar-embeddable-editor/`.** From the repo root, `npm publish` uses
  the root manifest and packs the whole source tree.
- **Staging refuses a stale bundle** rather than shipping one. `browser bundle does not match its
  manifest` means run `npm run test:visual` again; it is the guard working, not a fault.
- **Reaching prod is a separate step.** Publishing does nothing for prod until the template editor is
  rebuilt against the new version *and* `CEDAR_VERSION_MODIFIER` is bumped so clients drop the cached
  bundle (PROD-DEPLOY-RUNBOOK + frontend-caching).
