# Microservice Test Coverage Matrix

Which integration baseline each CEDAR microservice meets. The baseline is one suite per application
module that boots the real service wiring, exercises a request over HTTP, and pins both a success and
a meaningful failure path, without any external service.

All fifteen microservices meet it. The point of recording that is so a newly added service cannot
quietly omit it: a row with gaps is visible here, where otherwise it takes a hand audit of fifteen
repositories to notice.

A suite must run without shared developer infrastructure or a live external API. Use
`cedar-test-support-library` for in-process stores and authentication, bind isolated `19xxx` ports
distinct from every other booting test class, and tag the few tests that genuinely need an external
sandbox. Suites must be runnable per repository and together through `cedarcli build`, with failures
attributed to the responsible service rather than disappearing inside the aggregate reactor output.

## The Matrix

Every service boots its real application through `DropwizardTestSupport` or `DropwizardAppExtension`,
so the "boots" column is uniformly yes and is left out. What varies is how each pins its failure path
and what it needs to run.

| Service | Failure path pinned by | Mechanism | Backend |
|---|---|---|---|
| artifact | `CreateResourceTest`, `FindResourceTest` and peers | explicit per-resource | embedded Mongo |
| bridge | `BridgeRoutesRespondTest` | `RouteSurface` 401 | none |
| group | `GroupsAuthorizationMatrixTest`, `GroupMembershipAuthorizationMatrixTest` | `PermissionMatrix` | embedded Neo4j |
| impex | `ImpexRoutesRespondTest` | `RouteSurface` 401 | none |
| messaging | `MessagingRoutesRespondTest` | `RouteSurface` 401 | embedded MariaDB |
| monitor | `MonitorRoutesAndPermissionsTest` | `RouteSurface` 401 + 403 | none |
| openview | `OpenViewUnknownArtifactTest` | anonymous, 404 for an absent artifact | embedded Neo4j |
| repo | `RepoRoutesRespondTest` | `RouteSurface` 401 | none |
| resource | `FoldersAuthorizationMatrixTest` and four peers | `PermissionMatrix` | embedded Neo4j |
| schema | `SchemaServerApplicationSmokeTest` | anonymous, 404 for an unrouted path | none |
| submission | `SubmissionRoutesRespondTest` | `RouteSurface` 401 | none |
| terminology | `TerminologyServerApplicationSmokeTest` | explicit | none |
| user | `UserServerApplicationSmokeTest` | explicit | embedded Neo4j |
| valuerecommender | `ValueRecommenderRoutesRespondTest` | `RouteSurface` 401 | none |
| worker | `WorkerRoutesRespondTest`, `AdminCommandAuthorizationMatrixTest` | `RouteSurface` 401 + `PermissionMatrix` | embedded Neo4j, MariaDB |

Every backend listed is in-process, from `cedar-test-support-library`. No row needs a running CEDAR
stack or a live external API.

## Reading the Mechanism Column

`RouteSurface` enumerates a resource class's endpoints by reflection and requires each to answer an
expected status. Its value is that it covers routes nobody wrote a test for, and it fails rather than
passes when the resource list is wrong — an empty surface is an explicit error, not a silent success.
Adding an endpoint to a covered resource extends the assertion automatically.

`PermissionMatrix` is the heavier form, used where authorization is a grid rather than a gate: it
asserts what each role may do to each artifact at each permission level.

"Explicit" means the failure path is asserted directly in per-resource tests rather than derived from
the route surface. It is not weaker — the artifact server's coverage is the deepest in the system —
but it is per-endpoint, so a newly added endpoint is not covered until someone writes for it.

## Two Services Have No 401 to Assert

`openview` and `schema` are anonymous by design, so "rejects an unauthenticated request" is not a
contract they have. Their rows pin what refusal means for them instead.

The open-view server builds an *anonymous* request context and serves artifacts that have been made
open. Its failure path is that an artifact it should not serve is refused rather than leaked. The
reachable half is an artifact absent from the graph, which answers 404; the other half, an artifact
present but not open, needs a seeded graph and belongs with the sharing tests. The 404 assertion also
checks the response body names the artifact, since a bare 404 would not distinguish an absent artifact
from an absent route.

The schema server's whole surface is its index. An unrouted path answering 404 is the only meaningful
way it can say no.

## Known Gaps

Three, none of them a missing row.

The matrix is derived from the test sources by hand, so nothing fails when a new service lands without
one. Wiring the derivation into the test-enabled `cedarcli build` mode would make a missing baseline
break the build rather than go unnoticed.

The "explicit" services — artifact, terminology, user — assert failure paths per endpoint rather than
over the route surface, so a newly added endpoint is uncovered until someone writes for it.

Open-view pins only the absent-artifact half of its contract. An artifact that exists but is not open
needs a seeded graph and belongs with the sharing tests.

## Regenerating This

The rows come from the test sources, not from a report, so they can be re-derived:

```bash
cd $CEDAR_HOME && for d in cedar-*-server; do
  T=$(find $d -path "*/src/test/java/*" -name "*.java" | grep -v /target/)
  echo "$d: $(echo "$T" | xargs grep -l "RouteSurface\|PermissionMatrix" 2>/dev/null | sed 's|.*/||')"
done
```

Tests that need something external are tagged and excluded by default: `datacite` in the bridge
server, `bioportal` in the terminology server. Both services keep untagged coverage of their
authenticated surface, so excluding the tagged tests does not silently drop a row to nothing.
