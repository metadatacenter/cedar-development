# CEDAR TypeScript Model Library Runbook

How to build and test `cedar-model-typescript-library`, and what its CI does.
The open work on the library, and how it is meant to reach parity with the Java
model library, are tracked separately in
[TS-MODEL-LIBRARY-ROADMAP.md](./TS-MODEL-LIBRARY-ROADMAP.md) and
[MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md).

## Node version

The library needs **Node 20**; `package.json` declares `>=20.19.0` and CI pins
20.20.2. This is the same version the CEE test gate uses, so one `nvm use
20.20.2` covers both.

## Building and testing

Everything runs from the repository root, and nothing needs a sibling
checkout: the test corpus is vendored under `cedar-test-artifacts/`, and the
reference templates it compares against are vendored with it.

```bash
npm ci
npm run lint          # eslint over src, the eslint config and the smoke test
npm run typecheck     # tsc --noEmit
npm run test          # jest
npm run test:coverage # jest with coverage thresholds enforced
```

`npm run build` synchronizes the version into `package-dist.json`, runs
webpack, and assembles `dist/` as the package consumers actually install —
which is why the published name differs from the repository name.
`package.json` is `cedar-model-typescript-library`; `package-dist.json`, and
therefore the published package, is `@org.metadatacenter/cedar-model-typescript-library`.

## Testing the distributable

```bash
npm run test:package
```

This is the check worth knowing about. It builds the real tarball, installs it
into a throwaway project outside the repository, and imports it as a consumer
would — through CommonJS, through ESM, and against the shipped type
declarations. A library that passes its own unit tests can still ship a broken
`dist/`: a missing export map entry, a declaration file that does not resolve,
a dependency that was only ever a devDependency. Unit tests import from `src/`
and never see any of that.

## What CI runs

`.github/workflows/test.yml` runs on every push and pull request to `develop`,
on `ubuntu-latest`, with a fifteen-minute ceiling. Nothing here renders or
screenshots, so it needs no macOS runner and no browser install — unlike the
CEE gate, which needs both.

The job is the sequence above in order: `npm ci`, lint, typecheck,
`test:coverage`, then `test:package`. A single checkout is enough, again
because the corpora are vendored.

## Publishing

Nothing is published from CI. The package is consumed from the BMIR Nexus npm
registry — CEE resolves `@org.metadatacenter/*` from
`https://nexus.bmir.stanford.edu/repository/npm-cedar/` through its own
`.npmrc`, and pins an exact version such as `0.9.2-dev.20260805.50ef2b3`, where
the suffix carries the build date and commit.

The publish step itself is not written down anywhere, including here: it is not
in [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) or
[CEE-RELEASE-RUNBOOK.md](./CEE-RELEASE-RUNBOOK.md), and the repository carries
no `.npmrc` or `publishConfig` that would record the target registry. Whoever
publishes next should capture the procedure here rather than rediscover it.
