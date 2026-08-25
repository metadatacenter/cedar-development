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
the deployment without deleting data. Java development artifacts can now be published as one
immutable build train, and Docker build/start resolve the most recently completed train or an exact
older train. Full 29-container deployments and both REST and browser smoke suites have passed
locally. The numbered items below are the remaining delivery and operational work.

1. **Complete the Docker release, promotion, and rollback pipeline.** Run the 22-container backend
   and all 19 REST suites on an 8-vCPU Linux runner with 32 GB of RAM and 300 GB of SSD storage, or
   equivalent self-hosted capacity; the current backend requires about 7.4 GB of compressed
   transfer, 19.1 GB unpacked, and 11.3 GiB of RAM while idle. Run the credential-free frontend
   checks in CI and the authenticated navigation and long-request checks against staging. Promote
   the same completed digest manifest through development, staging, and production without
   rebuilding it, update each environment atomically, and make rollback select a previously tested
   manifest and routing configuration. Retain test results, Compose and container diagnostics, and
   evidence mapping source commits to the promoted digests. Declare the supported architectures,
   minimum Docker and Compose versions, and measured deployment resource requirements.

2. **Make every published image reproducible and verifiable.** Pin external base images by digest,
   avoid blanket package upgrades, pin operating-system packages where practical, and verify every
   downloaded distribution. Replace the remaining plain-HTTP MongoDB package source even though
   its packages are signature-checked. Generate an SBOM and build provenance for every image, scan
   its operating-system and application layers, sign the published digest, and make these checks
   publication gates. Vulnerability exceptions need a named owner, justification, and expiry date.
   Keep automated dependency updates as reviewed changes that rebuild and exercise the complete
   affected image set.

3. **Prove persistence, backup, restore, and upgrade operations.** Document each named volume, its
   owner, and the backup and restore procedure for MongoDB, MySQL, Neo4j, Redis, and OpenSearch.
   Restore into a disposable stack and pass a targeted REST gate. Any image upgrade that changes an
   on-disk format needs a migration and rollback plan. Keep destructive volume removal clearly
   separate from ordinary stop and restart commands.
