# CEDAR Docker Roadmap

Open work for making the complete CEDAR container estate a repeatable, registry-backed deployment.
The runtime is seven infrastructure, fifteen Java microservice, and seven frontend containers (29
total). The build also produces two Java base images, for 31 core images; four optional
administration images bring `cedarcli docker build all` to 35. Current deployment and operating
procedures are in [DOCKER-RUNBOOK.md](./DOCKER-RUNBOOK.md).

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
   affected image set. The public nginx edge and Temurin 17 runtime were brought to current stable
   patch lines on 2026-08-26; continue that cadence rather than treating reproducible pins as frozen
   dependencies. The repository exposes a Renovate Dependency Dashboard when the hosted bot runs,
   but installation and authorization of that external GitHub App remains an organization task.

3. **Prove persistence, backup, restore, and upgrade operations.** Document each named volume, its
   owner, and the backup and restore procedure for MongoDB, MySQL, Neo4j, Redis, and OpenSearch.
   Restore into a disposable stack and pass a targeted REST gate. Any image upgrade that changes an
   on-disk format needs a migration and rollback plan. Keep destructive volume removal clearly
   separate from ordinary stop and restart commands.

4. **Publish images for both architectures.** Every image the train publishes carries a single
   `linux/amd64` manifest, so the whole estate runs emulated on Apple Silicon. Measured 2026-08-25
   against a 32 GB virtual machine, a native `arm64` terminology server answered corpus-wide
   searches 1.4 to 1.6 times faster across five queries, and the gain was uniform rather than
   concentrated in one query shape. Every layer already supports the change: the Temurin base
   publishes `arm64`, the two CEDAR base images only install packages and copy scripts, the
   application arrives as a jar, and the one native dependency, the SQLite JDBC driver, already
   ships an `aarch64` library. Building the chain locally on an Apple Silicon host therefore
   produces working `arm64` images today, but they carry a train's tag while holding something the
   train never published, which is a trap rather than a route. Build with `buildx` for both
   architectures and publish one manifest list a tag, so a host pulls its own architecture and the
   train stays a single set of digests.

5. **Run the TLS edge as a non-root nginx.** `infra-nginx` is the last container whose nginx master
   runs as root, kept that way because its vhosts listen on 80 and 443. Converting it means moving
   every vhost — a dozen include files plus the split-routing rehearsal configs — to 8080/8443,
   remapping the published ports in the infrastructure Compose file, keeping the certificate
   volumes readable by the unprivileged user, and proving the change with the route-table smoke and
   the routing-switch rehearsal before it reaches a shared environment. The seven frontend nginx
   containers already run unprivileged; this item finishes the estate.

6. **Publish stable CEDAR releases to Docker Hub.** Extend the train-backed release route so the
   tested runtime image manifests and layer bytes are copied to the public `metadatacenter`
   namespace without rebuilding them. Give every image an immutable CEDAR-version tag, verify the
   complete public inventory by digest, and move `latest` only after every versioned tag and its
   release evidence are present. Preserve the architecture manifests, signatures, SBOMs, provenance,
   and source-to-image mapping produced by the release pipeline rather than creating a second,
   weaker publication path.

   Define which internal base and optional administration images are public, the retention policy,
   and the repository descriptions and pull examples a user needs to select a coherent release.
   Exercise an anonymous pull into a clean environment and run the full-stack smoke against the
   Docker Hub prefix. A CEDAR release is not Docker-complete until its advertised image set can be
   pulled without CEDAR registry credentials, resolves to the recorded release digests, and starts
   with the matching Compose and configuration version.
