# CEDAR Docker Roadmap

Open work for making the complete CEDAR container estate a repeatable, registry-backed deployment.
The runtime is seven infrastructure, fifteen Java microservice, and seven frontend containers (29
total). The build also produces two Java base images, for 31 core images; four optional
administration images bring `cedarcli docker build all` to 35. Current deployment and operating
procedures are in [DOCKER-RUNBOOK.md](./DOCKER-RUNBOOK.md).

The local build and deployment path is working: `cedarcli` builds dependency bases before their
consumers, applies one validated image prefix across builds and Compose, and validates all four
Compose stacks. Its aggregate workflow preflights the host, selects
full-Docker, native-frontend hybrid, or backend-only routing without mutating the shell, starts each
layer in dependency order, waits for health and route acceptance, records the active mode, and stops
the deployment without deleting data. Full 29-container deployments and both REST and browser smoke
suites have passed locally. The numbered items below are the remaining delivery and operational
work.

1. **Publish complete core-image releases to Nexus.** Publish the seven infrastructure images, two
   Java bases, fifteen servers, and seven frontends only after their source and image builds pass.
   Keep a readable release tag, but identify the deployable set by immutable digests so rebuilding
   a mutable development version cannot change an existing deployment. Record each image's source
   commit, input artifact or npm package version, platform, and digest. A clean Docker engine must
   be able to authenticate and pull all 31 images, and a failed or partial build must never update
   the deployable alias. Treat the four administration images as a separate optional set.

2. **Define release promotion and rollback around one image manifest.** Generate a manifest for
   the complete digest set that passed CI and promote that same set through development, staging,
   and production without rebuilding it. Environment-specific deployment manifests may change
   configuration, but not image bytes. Production promotion must update metadata or aliases
   atomically, rollback must select the previous complete digest set, and operators must be able to
   query which manifest a running environment uses.

3. **Run the complete Docker backend REST gate in CI.** Bring up the 22-container backend and run
   all 19 REST suites from `cedarnet`, keeping the Artifact service private while preserving the
   cross-store assertions used locally. Wait for 22/22 healthy services, fail on topology-related
   connection errors, and clean fixtures on success, failure, timeout, and cancellation. On
   failure, retain the resolved Compose model, container health and inspect output, and bounded
   service logs as CI artifacts.

4. **Make persistence, backup, restore, and upgrade operations explicit.** Document each named
   volume, its owner, and the backup and restore procedure for MongoDB, MySQL, Neo4j, Redis, and
   OpenSearch. Prove the procedures by restoring into a disposable stack and passing a targeted
   REST gate. Any image upgrade that changes an on-disk format needs a migration and rollback plan.
   Keep destructive volume removal clearly separate from ordinary stop and restart commands.

5. **Produce and enforce image supply-chain evidence.** Generate an SBOM and build provenance for
   every published image, scan its operating-system and application layers, and sign the published
   digest. Make those checks publication gates. Vulnerability exceptions need a named owner,
   justification, and expiry date rather than a silent waiver.

6. **Remove the remaining non-reproducible or weakly verified build inputs.** Pin external base
   images by digest, avoid blanket package upgrades in image builds, pin installed operating-system
   packages where practical, and verify every downloaded distribution. Replace the remaining
   plain-HTTP MongoDB package source even though its packages are signature-checked. Keep automated
   dependency updates as reviewed changes that rebuild and exercise the complete affected image
   set.

7. **Declare supported platforms and realistic resource requirements.** Build and test each
    supported architecture explicitly, or state that amd64 is the contract if that is what CEDAR
    supports. Record minimum Docker and Compose versions and measured CPU, memory, and disk needs
    for a cold 29-container start, the REST gate, and the authenticated browser smoke test.

8. **Turn the existing split-frontend checks into a release gate.** The repository already has
    shell, route, bundle-identity, CORS, Keycloak-origin, authenticated-navigation, deployment
    recording, rollback-rehearsal, and long-request checks. Run the relevant credential-free checks
    in CI and the authenticated path against staging before promotion. Preserve evidence mapping
    the seven frontend source commits and bundle digests to the tested image manifest, retain the
    regression proving requests longer than 60 seconds work with the documented proxy timeout, and
    make rollback restore one previously tested routing configuration and digest set.
