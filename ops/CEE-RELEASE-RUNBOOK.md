# CEDAR Embeddable Editor (CEE) — npm Release Runbook

How to cut a new **CEE** version and publish it to **npmjs** (`cedar-embeddable-editor`), then
propagate it to the CEDAR repos that embed it. Synthesized from the working release notes
(latest: 1.5.1, 2026-07-16). Example version below is **1.5.2** — substitute your `X.Y.Z`.

Sibling runbooks:
- [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) — cutting a full CEDAR release.
- [PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) — deploying CEDAR to prod (step 6 rebuilds the
  template editor against the CEE version — that's how CEE reaches prod).
- [DEVELOPMENT-RUNBOOK.md](./DEVELOPMENT-RUNBOOK.md) — running CEDAR locally.

> `gocee`, `gocedar`, `goartifacts`, `gobridging` are CEDAR profile aliases (cd to the respective
> repo). `cedarcli build this` builds the repo you're standing in. Run in an interactive `cedar`
> login shell. **Never commit npm tokens, passwords, or OTPs.**

## Prerequisites — npm auth (the usual blocker)

Publishing goes to **public npmjs** (the `dist-npm` package has no `publishConfig`, so it uses the
default registry). You need publish rights on the `cedar-embeddable-editor` package.

```
npm login
#   username: metadatacenter
#   password: KeePassX  (metadatacenter npm entry)
#   OTP:      TOTP delivered to the metadatacenter@gmail.com inbox
```

> **Gotcha (hit on the 1.5.1 release):** `npm publish` can still 401 after an interactive
> `npm login`. Fix: create an **automation/publish token** in the npmjs account
> (npmjs.com → Access Tokens → Generate → *Automation*), add it to `~/.npmrc`, then re-run publish:
> ```
> //registry.npmjs.org/:_authToken=<TOKEN>
> ```
> The token is a credential — keep it in `~/.npmrc` only, never in a repo or these notes.

## 1 · Bump the version everywhere

CEE carries the version in **six** files plus a build stamp. Miss one and the published package or
the in-app version display disagrees.

```
gocee
```
Set `X.Y.Z` in:

| File | Occurrences |
|---|---|
| `package.json` | 1 (`"version"`) |
| `package-lock.json` | 2 (top-level `"version"` + the root `""` package entry) |
| `dist-npm/cedar-embeddable-editor/package.json` | 1 |
| `dist-npm/cedar-embeddable-editor/package-lock.json` | 2 |
| `CHANGELOG.md` | new `## [X.Y.Z] - <date>` section with the notes |

Then:
- **Copy** `README.md` over `dist-npm/cedar-embeddable-editor/README.md` (keep the published readme current).
- **Bump the build stamp** in
  `src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts`
  → `private static INNER_VERSION = '<YYYY-MM-DD HH:MM>';` (a freeform trace stamp logged at load —
  separate from `ceeVersion`, which now derives from `package.json` automatically).

> `ceeVersion` is read from `package.json` at runtime and is also exposed as
> `window.cedarEmbeddableEditorVersion` (host apps read it — e.g. the template-editor settings page).
> So bumping `package.json` is what drives the visible version; `INNER_VERSION` is just the load-trace stamp.

## 2 · Build

```
gocee
cedarcli build this        # produces the dist; the publish bundle is dist-npm/.../cedar-embeddable-editor.js
```

> If building the single web-component bundle by hand instead (per the CEE README):
> `ng build --configuration=production` then
> `cat dist/cedar-embeddable-editor/{runtime,polyfills,main}.js > dist-npm/cedar-embeddable-editor/cedar-embeddable-editor.js`.

## 3 · Commit, merge to main, tag

```
gocee
git add -A && git commit -m "Release X.Y.Z"
git checkout main
git pull
git merge develop -m "Release X.Y.Z"
git push
git tag release-X.Y.Z
git push origin release-X.Y.Z
git checkout develop
```

> The 1.5.1 run tagged directly off `develop` and skipped the `main` merge. Do the merge for a
> clean `main` unless your team deliberately tags off `develop`.

## 4 · Publish to npm

```
gocedar
cd cedar-embeddable-editor/dist-npm/cedar-embeddable-editor
npm publish
```
Verify it went live: `npm view cedar-embeddable-editor version` → should print `X.Y.Z`.

## 5 · Propagate to the embedding repos

`cedar-template-editor` depends on CEE with a caret (`^1.x`), so it picks up the new version on the
next `npm install` + `gulp` — that happens during a prod deploy
([PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) step 6). The repos below pin CEE and must be
bumped explicitly. For each: set the CEE version in its `package.json`, reinstall, rebuild, commit, push.

```
# cedar-artifacts
# edit cedar-artifacts/cedar-artifacts-src/package.json  (CEE -> X.Y.Z)
goartifacts && npm install && cd .. && cedarcli build this
git add . && git commit -m "Upgrade CEE to X.Y.Z" && git push

# cedar-bridging
# edit cedar-bridging/cedar-bridging-src/package.json  (CEE -> X.Y.Z)
gobridging && npm install && cd .. && cedarcli build this
git add . && git commit -m "Upgrade CEE to X.Y.Z" && git push

# cedar-component-demo (four sub-apps — edit each package.json, then reinstall)
gocedar && cd cedar-component-demo/cedar-cee-demo-angular-src/ && npm install --legacy-peer-deps
gocedar && cd cedar-component-demo/cedar-cee-demo-ember-src   && npm install
gocedar && cd cedar-component-demo/cedar-cee-demo-react       && npm install
gocedar && cd cedar-component-demo/cedar-cee-docs-angular-src/ && npm install
gocedar && cd cedar-component-demo && cedarcli build this
git add . && git commit -m "Upgrade CEE to X.Y.Z" && git push
```

> `cedar-cee-demo-angular-src` needs `--legacy-peer-deps`; the others do not.

## Verify

- `npm view cedar-embeddable-editor version` → `X.Y.Z`.
- After the template editor is rebuilt against it, the **Settings → About CEDAR → CEE version** row
  shows `X.Y.Z` (not `unknown`/an old value). A stale value there means the bundle wasn't re-vendored
  or the frontend cache/CDN wasn't busted — see the frontend-caching notes.

## Gotchas

- **Six version spots + the build stamp.** The two `package-lock.json`s each carry the version twice.
  Miss one and either the publish fails the lockfile check or the shown version is wrong.
- **`npm publish` targets public npmjs, not Nexus.** The `dist-npm` `package.json` has no
  `publishConfig`; the root's Nexus `publishConfig` does **not** apply to the publish (you publish
  from `dist-npm`). Confirm with `npm config get registry` if unsure.
- **Auth 401 after login** → automation token in `~/.npmrc` (see Prerequisites).
- **Reaching prod is a separate step.** Publishing to npm does nothing for prod until the template
  editor is rebuilt against it *and* `CEDAR_VERSION_MODIFIER` is bumped so clients drop the cached
  bundle (PROD-DEPLOY-RUNBOOK + frontend-caching).
