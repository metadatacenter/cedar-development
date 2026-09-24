#!/usr/bin/env python3
"""Survey what production holds in the fields the meta-schema constrains only as strings.

The CEDAR meta-schema is largely a structural contract: it says an artifact has a `pav:version`
and that the value is a non-empty string, not that a version looks like one. Roughly half the
string-typed properties it describes carry no pattern, format or enumeration at all, and a rule
that only one component enforces produces stored data nothing rejects until something downstream
refuses to read it. That is how production came to hold artifacts with a `pav:version` of `0.1`,
which the artifact library cannot parse and the YAML endpoint therefore cannot serve.

This walks a deployment and reports, for each such property, what is actually stored: how many
artifacts carry it, how many distinct values it takes, and how many of those fail the shape the
model expects where the model expects one. It proposes nothing and writes nothing; it measures the
gap so a decision about tightening the meta-schema can be made against real data rather than a
guess at what is out there.

    export CEDAR_API_KEY=...
    python3 ops/cedar_content_constraint_survey.py --limit 2000

The expectations below are this script's own reading of what each field means, not the
meta-schema's — the meta-schema is what has nothing to say. Each is named in the output so a
disagreement about one is visible rather than buried.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as audit  # noqa: E402

SCHEMA_TYPES = ("template", "element", "field")
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]|$)")
ACRONYM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def is_absolute_iri(value: str) -> bool:
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value))


def compiles(value: str) -> bool:
    try:
        re.compile(value)
    except re.error:
        return False
    return True


# The property, what shape it should hold, and why. A property whose value is free text for a
# human to read is not here: nothing is wrong with any string it might contain.
EXPECTATIONS: dict[str, tuple[str, Callable[[str], bool]]] = {
    "pav:version": ("three-part semantic version", lambda v: bool(SEMVER.match(v))),
    # Not a version: it points at the artifact the current one succeeds.
    "pav:previousVersion": ("an absolute IRI", is_absolute_iri),
    "schema:schemaVersion": ("three-part semantic version", lambda v: bool(SEMVER.match(v))),
    "effectiveDate": ("an ISO date", lambda v: bool(ISO_DATE.match(v))),
    "declaredVersion": ("a version the ontology declares", lambda v: v.strip() != ""),
    "acronym": ("an ontology acronym, no spaces", lambda v: bool(ACRONYM.match(v))),
    "sourceSystem": ("an absolute IRI", is_absolute_iri),
    "regex": ("a regular expression that compiles", compiles),
    "unitOfMeasure": ("a unit, not empty", lambda v: v.strip() != ""),
    "schema:identifier": ("an identifier, not empty", lambda v: v.strip() != ""),
}
# Where a value belongs to a small closed set the meta-schema does not enumerate. `type` is the
# name JSON Schema uses for its own keyword as well, so the scope says which occurrences are the
# ones a value constraint names a term kind with.
ENUMERATED = {"type": {"OntologyClass", "Ontology", "ValueSet", "Branch", "Class"}}
# An action entry is deliberately absent. Its `type` is one of `Value` or `OntologyClass` and the
# meta-schema enumerates both, so it is already constrained and nothing here should second-guess it;
# checking it against the term kinds reported 585 valid occurrences as offending.
# `acronym` is scoped for a second reason: it is also a field name authors use, and a template
# describing a field called `acronym` holds its help text at `_ui/propertyDescriptions/acronym`.
# That is not a vocabulary address and reading it as one reported eight sentences as defects.
SCOPES = {"type": re.compile(r"/_valueConstraints/(classes|ontologies|branches|valueSets)/"),
          "acronym": re.compile(r"/_valueConstraints/(classes|ontologies|branches|valueSets)/")}


def strings_at(node: Any, key: str, path: str = "") -> Iterator[tuple[str, str]]:
    """Every string stored under ``key``, with where it sits."""
    if isinstance(node, dict):
        for name, value in node.items():
            here = f"{path}/{name}"
            if name == key and isinstance(value, str):
                yield here, value
            else:
                yield from strings_at(value, key, here)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            yield from strings_at(item, key, f"{path}/{index}")


class Survey:
    """What each surveyed property holds, across the artifacts walked."""

    def __init__(self) -> None:
        self.artifacts = collections.Counter()
        self.occurrences = collections.Counter()
        self.carrying = collections.defaultdict(set)
        self.values = collections.defaultdict(collections.Counter)
        self.offending = collections.defaultdict(collections.Counter)
        self.offending_artifacts = collections.defaultdict(set)
        # One entry per offending occurrence, with the artifact and the path it sits at. The counts
        # above say how much there is; a repair needs to know where, and recovering that meant
        # walking the whole deployment a second time.
        self.offences: list[dict[str, Any]] = []
        self.stream = None

    def add(self, ref: rest.ArtifactRef, artifact: Any) -> None:
        self.artifacts[ref.artifact_type] += 1
        for key in list(EXPECTATIONS) + list(ENUMERATED):
            scope = SCOPES.get(key)
            for path, value in strings_at(artifact, key):
                if scope is not None and not scope.search(path):
                    continue
                self.occurrences[key] += 1
                self.carrying[key].add(ref.artifact_id)
                self.values[key][value] += 1
                if key in ENUMERATED:
                    acceptable = value in ENUMERATED[key]
                else:
                    acceptable = EXPECTATIONS[key][1](value)
                if not acceptable:
                    self.offending[key][value] += 1
                    self.offending_artifacts[key].add(ref.artifact_id)
                    offence = {
                        "artifactType": ref.artifact_type, "artifactId": ref.artifact_id,
                        "artifactName": ref.name, "property": key, "path": path, "value": value,
                        "conditionRules": {f"{key}-unexpected": 1},
                    }
                    self.offences.append(offence)
                    if self.stream is not None:
                        self.stream.write(json.dumps(offence) + "\n")
                        self.stream.flush()

    def report(self) -> None:
        print(f"\nartifacts walked: {sum(self.artifacts.values())} "
              f"({', '.join(f'{k}={v}' for k, v in sorted(self.artifacts.items()))})\n")
        header = f"{'property':<22} {'artifacts':>9} {'values':>7} {'distinct':>9} {'offending':>10}  expected"
        print(header)
        print("-" * len(header))
        ordered = sorted(EXPECTATIONS.keys() | ENUMERATED.keys(),
                         key=lambda k: (-len(self.offending_artifacts[k]), -self.occurrences[k], k))
        for key in ordered:
            if not self.occurrences[key]:
                continue
            expectation = ("one of " + ", ".join(sorted(ENUMERATED[key]))) if key in ENUMERATED \
                else EXPECTATIONS[key][0]
            print(f"{key:<22} {len(self.carrying[key]):>9} {self.occurrences[key]:>7} "
                  f"{len(self.values[key]):>9} {len(self.offending_artifacts[key]):>10}  {expectation}")
        for key in ordered:
            if not self.offending[key]:
                continue
            expectation = EXPECTATIONS[key][0] if key in EXPECTATIONS \
                else "one of " + ", ".join(sorted(ENUMERATED[key]))
            print(f"\n{key}: {len(self.offending_artifacts[key])} artifacts hold a value that is not "
                  f"{expectation}")
            for value, count in self.offending[key].most_common(8):
                print(f"  {count:>6}  {value[:70]!r}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default=rest.DEFAULT_SERVER)
    parser.add_argument("--api-key-file")
    parser.add_argument("--types", default="all")
    parser.add_argument("--limit", type=int, default=2000,
                        help="artifacts per kind to walk (default: 2000)")
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--fetch-workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--delay-ms", type=int, default=0)
    parser.add_argument("--ca-file")
    parser.add_argument("--allow-http", action="store_true")
    parser.add_argument("--out", help="write the surveyed values as JSON here")
    parser.add_argument("--offences", help="write one JSONL record per offending occurrence here, "
                                           "as the target list a repair takes")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    kinds = list(SCHEMA_TYPES) if arguments.types == "all" else \
        [k.strip() for k in arguments.types.split(",") if k.strip()]
    api_key = rest.resolve_api_key(arguments, parser)
    client = rest.GetOnlyClient(arguments.server, api_key, timeout=arguments.timeout,
                                retries=arguments.retries, delay_ms=arguments.delay_ms,
                                ca_file=arguments.ca_file, allow_http=arguments.allow_http)
    survey = Survey()
    # Opened before the walk rather than written after it: an hour-long pass that shows nothing
    # until it ends cannot be watched, and loses everything it found if it is stopped.
    if arguments.offences:
        survey.stream = Path(arguments.offences).open("w", encoding="utf-8")
    state = rest.AuditState(limit=None, started_at=rest.utc_now())
    print(f"Surveying {arguments.server}: up to {arguments.limit} of each of {', '.join(kinds)}")
    for kind in kinds:
        refs = list(rest.iter_artifact_refs(client, kind, arguments.page_size, state, arguments.limit))
        print(f"  {kind}: {len(refs)} enumerated", flush=True)
        read = 0
        for ref, artifact, error in audit.fetch_in_order(client, refs, arguments.fetch_workers):
            if error is not None or artifact is None:
                continue
            survey.add(ref, artifact)
            read += 1
            if read % 500 == 0:
                print(f"    read {read}/{len(refs)}", flush=True)
    survey.report()
    if survey.stream is not None:
        survey.stream.close()
        print(f"\n{len(survey.offences)} offending occurrences written to {arguments.offences}")
    if arguments.out:
        Path(arguments.out).write_text(json.dumps(
            {key: dict(counter) for key, counter in survey.values.items()}, indent=2), encoding="utf-8")
        print(f"\nvalues written to {arguments.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
