# CEDAR MCP Servers — Roadmap

Open work across the four MCP servers under `$CEDAR_HOME/mcp`. Building, configuring and testing
them is in [MCP-RUNBOOK.md](./MCP-RUNBOOK.md).

Everything open lives here, whether it spans the servers or sits inside one of them. Each
repository keeps a DESIGN.md for the principles that govern it and a README for the tool surface
it offers.

Item numbers are contiguous and change as work leaves the document. Refer to the concrete change
by name in commits.

## Across the Servers

- **1. Build and release the MCP servers with everything else.** Four repositories, none part of
  `cedarcli build java`, none with a GitHub Actions workflow, and until now unmentioned by
  [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) or [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md). They are
  built by hand, which means they are built when somebody remembers.

  What that costs is particular to an MCP. **A tool's description is the only documentation the
  calling model ever reads, and it ships inside the jar.** `cedar-artifact-rest-mcp` once ran a
  30 July jar whose descriptions had been rewritten on 9 August, so a client spent a fortnight
  reading a surface that no longer described the tools — and a wrong description is followed, not
  ignored. A stale MCP jar is worse than a stale service jar.

  Deliver:

  - Build the three Maven servers with the rest. When `cedar-artifact-library` advances, bump its
    two MCP consumers in the same delivery and build them after the declared library release, so a
    signature break fails before a client sees it.
  - Give each Java repository the workflow every other Java repository already has.
  - Give `bioportal-term-mcp` the Python equivalent: `uv run pytest` and `uv run pyright` on every
    push, and a nightly `uv run pytest -m live` to catch BioPortal shape drift early. Both precede
    any publication to PyPI, should that ever be wanted.
  - Decide whether they join the train-backed release or stay outside it, as CEE and the
    TypeScript model library do. Dependency resolution no longer decides that question:
    `cedar-artifact-rest-mcp` resolves from Maven Central alone, while `cedar-artifact-mcp` and
    `cedar-cee-mcp` resolve released `cedar-artifact-library` 2.9.8 from the BMIR Nexus.
  - Make a running server state which CEDAR it talks to. `ping` reports the build and deliberately
    contacts nothing, so the target is invisible — and it is fixed when the process spawns, so
    editing a client's configuration changes nothing until the server restarts. That combination let
    a server go on writing to whatever it was started against after its configuration had been
    pointed elsewhere, which is a hazard when one of the two is production.

  Two obstacles this item used to carry are gone. The artifact and CEE MCPs once pinned a local
  `cedar-artifact-library:2.8.4-SNAPSHOT` while Maven attempted an obsolete Sonatype repository;
  both now pin released 2.9.8 from the BMIR Nexus, and the REST MCP has no artifact-library
  dependency. Separately, a rebuild produced a jar that would not start at all, from a
  `json-schema-validator` conflict between the MCP SDK and `CedarValidator`; that is resolved per
  server and written up in the runbook.

  Both are the same shape, and a third arrived the same way: moving the artifact MCP off 2.9.3
  broke its build twice on `jackson-annotations`, because each library release brings a newer
  databind that reaches for the annotations release of its own line, and a hand-picked version
  satisfies that only until the next one. Neither server picks a Jackson version by hand now —
  annotations follows databind, and a library bump is one property rather than three. What none of
  these had was a build that would have caught them: each surfaced when somebody happened to
  rebuild, which is the argument for building these servers continuously.

- **2. Track the CEE bundle a client actually serves.** `cedar-cee-mcp` pins the CEE by version and
  hash and refuses a mismatch, so what a build produces is known. What a *client* is running is not:
  the jar is loaded when the process spawns, and a rebuilt jar takes effect only after a restart
  nobody is prompted to perform. `ping` reports the MCP's own version and says nothing about the
  bundle inside it.

  The CEE also publishes dev releases faster than anyone bumps a pin, and each one may narrow the
  configuration surface again — 2.0 dropped nine of the fourteen keys this server sent. A unit test
  now catches that at build time, but only for a build that happens.

- **3. Give the servers a shared release note surface.** Each repository has a README, a DESIGN
  and a CLAUDE.md, and the four sets restate the same conventions — how a jar is built and
  named, that descriptions are documentation, that secrets come from the environment. The
  duplication is mild and mostly harmless, but a convention that changes has four homes to visit.
  Consider whether the shared half belongs here, in the runbook, with each repository keeping only
  what is true of itself.

- **4. Extract the plumbing the three Java servers copy.** Version-resource loading, the `ping`
  tool and its handler, `RegisteredTool`, and the success and error result helpers are copied
  verbatim across the three Java servers. A small `cedar-mcp-common` module in the shared reactor
  would hold them. Do the extraction inside the shared-build change of item 1, so the module is
  built and versioned atomically with its consumers; a separately released dependency is not worth
  creating while these servers still build independently.

## cedar-artifact-mcp

<a id="property-iri-authoring"></a>

- **5. Assign child property IRIs before MCP exchange, then enforce them in both libraries.**
  `add_field` accepts an omitted `property_iri` and returns YAML before the repository assigns one.
  Requiring that IRI on the next read would break a sequence of authoring tool calls. Make MCP
  authoring produce complete mappings before enabling stricter Java and TypeScript readers.

  - Cover ordinary child fields and elements in `add_field`, `add_element`, imports, composition
    and edits. Preserve supplied vocabulary IRIs; assign missing ones once as
    `https://schema.metadatacenter.org/properties/<UUID>`. Retain them through subsequent tool
    calls, renames, edits, copies and serialization; do not mint identities during reads or renders.
  - Carry the template's property IRIs into matching instance `@context` mappings. Preserve entered
    values and stop on conflicting identities. Static fields and attribute-value groups need no
    fixed property mapping; preserve explicit group mappings, and retain the actual dynamic
    attributes' mappings in instance contexts.
  - Audit the CEE MCP's artifact inputs and outputs and the REST MCP handoff as well as the artifact
    MCP. Update tool schemas and descriptions to explain automatic assignment. Advance library
    dependencies, rebuild and restart affected MCP consumers together.
  - Once authoring is ready, require valid property IRIs on ordinary child fields and elements in
    both libraries' JSON and YAML readers, including compact and expanded exchange forms. Recheck
    production coverage before rollout; reconcile remaining missing or conflicting mappings first.
  - Prove a multi-call create → add child → serialize → read → edit → populate instance → REST save
    workflow, including nested and repeated elements, supplied and generated IRIs, and rejection of
    absent or malformed required mappings. Require byte-identical YAML and matching generated JSON
    content and key order across Java and TypeScript.

- **6. Expose the per-field question metadata the library carries.** `skos:prefLabel` holds the
  preferred question text, an alternative phrasing of the field's name that a form shows, distinct
  from the value-level labels. `skos:altLabel` holds further phrasings, and `language` and
  `valueRecommendationEnabled` sit beside them. All four survive a round trip and none can be set
  through a tool.

- **7. Expose a template's header and footer.** `TemplateUi` carries display header and footer
  text through `withHeader` and `withFooter`. Both survive a round trip; neither is settable.

- **8. Expose the per-term actions a controlled-term constraint carries.** A constraint may carry
  `ControlledTermValueConstraintsAction` entries, the keep, delete and move tweaks the CEDAR editor
  applies on top of a class, ontology, branch or value-set binding — pulling one class out of an
  otherwise-included branch, for instance. The library models and round-trips them.
  `set_*_constraint` and `remove_constraint` work at the whole-constraint level and leave actions
  alone, which is deliberate: this is a finer-grained surface, and it belongs beside those tools
  rather than inside them.

- **9. Decide whether one render-if-present YAML form replaces compact and expanded.** Mutating
  tools return the expanded exchange form, and `compact` survives only on the render tools. Whether
  the distinction can disappear altogether is open. A render-if-present form would emit provenance
  — status, version, modelVersion, created and modified — only where it is set, an absent key
  meaning omitted and a present one meaning shown and round-tripped, which leaves the default view
  lean with no lossy compaction.

  The prerequisite carries the cost. That lean default arrives only if `version`, `status` and
  `modelVersion` stop being injected as defaults, both here and in `cedar-artifact-library`'s
  builder and readers, which default them deliberately today. The change reaches CEDAR server
  tooling and the CLI, so it takes coordinating rather than an edit in one server. The asymmetry
  between what the reader defaults and what the builder defaults is written down in neither
  repository and needs describing before any of this can be picked up. One tradeoff to weigh: a
  single form can no longer hide provenance that does exist, such as a server-loaded artifact's
  timestamps, which `compact: true` can.

- **10. Distinguish an empty controlled-term field from a text field.** The CEDAR model makes the
  two indistinguishable in JSON, because a TEXTFIELD becomes a ControlledTermField only once it
  carries a constraint. The constraint tools and the controlled-term branch of
  `set_iri_field_value` work around it. The fix is a model change and waits on the next model
  version.

## cedar-artifact-rest-mcp

- **11. Place a created artifact in a chosen folder.** `create_*` puts an artifact in the caller's
  home folder. Pass the optional `folder_id` query parameter — `POST /templates?folder_id=<IRI>`
  and its counterparts — so the caller chooses instead.

- **12. Read an artifact's details, report and version history.** `GET /{type}/{id}/details`,
  `/report` and `/versions` are read-only metadata the server already serves and no tool reaches.

- **13. Support the draft-to-publish lifecycle.** `/command/create-draft-artifact`,
  `/command/publish-artifact`, `make-artifact-open` and `make-artifact-not-open` carry that
  workflow. They mutate, and publishing is partly irreversible, so take them deliberately rather
  than as part of a CRUD sweep.

## cedar-cee-mcp

- **14. Load the Material Symbols font in the host page.** The CEE's icon ligatures render as their
  own text — `more_vert`, `unfold_more` — because the host page does not load the font. Add the
  font link, or establish which face the pinned CEE version expects.

- **15. Serve successive calls from one persistent browser tab.** A single tab receiving show and
  fill calls over SSE or polling, in place of a tab per session, would suit repeated
  demonstrations. Tab-per-call is adequate meanwhile, so this waits on the ergonomics mattering.

- **16. Render the editor inside the chat client.** The MCP extension for `ui://` tool-result
  resources would put the editor in the conversation. Revisit when client support is broad and the
  sandbox and CSP story accommodates a 2 MB component bundle that needs network access to the
  terminology service. The localhost-tab approach works in every client today, terminal ones
  included.

## bioportal-term-mcp

- **17. Polish the BioPortal client.** Four independent changes, none urgent:

  - Cache results. Every tool calls BioPortal on every invocation, so one ontology looked up five
    times in a session costs five HTTP calls. A TTL cache in `_bioportal_get` fixes that
    invisibly.
  - Validate IRI inputs. `get_class` and `get_value_set` check only that the IRI is non-blank; a
    real parse would catch a typo client-side, through a `_require_iri(value, field_name)` helper.
  - Page the find tools. Each `find_*` returns one ranked page; expose `page` or `offset` when a
    caller needs the second.
  - Go async, but only once latency becomes a real concern. It has not.

- **18. Put a recommender in front of the ranked candidates.** `find_class` ranks by BioPortal's
  string relevance and `find_ontology` by acronym and name overlap. Both surface candidates and
  neither judges which term fits a field, so several related terms searched one at a time can each
  land in whichever ontology matched lexically rather than in one coherent set. Choosing well —
  the right ontology, the right granularity, the intended sense — takes a recommender in the loop,
  either BioPortal's Recommender service or an LLM-scored shortlist over these candidates, scoring
  ontologies and terms for a whole field at once. It belongs in a separate component, not in
  ranking heuristics bolted onto identifier resolution.

## Out of Scope

- **Documenting the tool surface.** What each server offers, and how each tool is worded, belong
  to its README; the principles that govern them belong to its DESIGN.md.
- **The CEE itself.** Building, testing and releasing the web component is
  [FRONTEND-RUNBOOK.md](./FRONTEND-RUNBOOK.md#cee) and [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md#cee); this pair covers only
  how `cedar-cee-mcp` consumes a published bundle.
- **The CEDAR server surface the REST MCP calls.** Endpoint behaviour, validation and content
  negotiation are backend work, in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).
