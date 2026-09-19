#!/usr/bin/env python3
"""Convert every stored schema artifact from YAML with each model library, and validate the result.

CEDAR has two implementations of its artifact model — ``cedar-artifact-library`` in Java and
``cedar-model-typescript-library`` — and either may be asked to turn a YAML document into the JSON
Schema representation the system stores. Whether the two agree, and whether what each produces is
something ``cedar-model-validation-library`` accepts, is a question only the real corpus answers.

Every template, element and field an API key can read is fetched from a deployment as YAML, through
the Accept-header negotiation the resource server performs. Each document then goes down two lanes:
the Java artifact library reads it and renders JSON Schema, and the TypeScript library does the
same. Both renderings are validated by ``cedar-model-validation-library``, the arbiter, so the two
lanes differ only in the converter and a divergent verdict belongs to that converter alone.

Fetching is read-only: the HTTP client supports GET, and nothing is written back to the deployment.
Results stream as one JSON line per artifact, a summary is checkpointed at every progress report,
and an interrupted run continues with ``--resume``. The final report names the artifacts that
failed, and the complete list of their identifiers is written beside the records.

    export CEDAR_API_KEY=...
    python3 ops/cedar_yaml_conversion_audit.py \\
      --server https://resource.metadatacenter.org \\
      --out production-yaml-conversion.jsonl

Requires JDK 17 with ``cedar-artifact-library`` and ``cedar-model-validation-library`` built, and
Node with the TypeScript library's ``dist`` built (``npm run build``). No third-party Python
packages are required.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as audit  # noqa: E402

REFS_FORMAT_VERSION = 1
MANIFEST_RECORD = "yaml-conversion-audit-manifest"
DEFAULT_PROGRESS_EVERY = 200
DEFAULT_PROGRESS_SECONDS = 60
# The resource server refuses a page larger than its configured maxPageSize, 500 in cedar-main.yml.
DEFAULT_PAGE_SIZE = 500
DEFAULT_FETCH_WORKERS = 4
DEFAULT_BRIDGE_TIMEOUT = 120
DEFAULT_BRIDGE_MAX_RESTARTS = 5
DEFAULT_MAX_LISTED_IDS = 50
DEFAULT_MAX_ERRORS = 20

JAVA_BRIDGE_SOURCE = Path(__file__).with_name("cedar_yaml_convert_bridge.java")
TS_BRIDGE_SOURCE = Path(__file__).with_name("cedar_yaml_convert_bridge.cjs")

# An instance is not a schema artifact, and a YAML instance cannot be read without the template it
# is based on, so the audit's scope stops at the three kinds that carry a schema.
SCHEMA_TYPES = ("template", "element", "field")
YAML_MEDIA_TYPES = {"application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"}

JAVA = "java"
TYPESCRIPT = "typescript"
LANES = (JAVA, TYPESCRIPT)
LANE_LABEL = {
    JAVA: "cedar-artifact-library (Java)",
    TYPESCRIPT: "cedar-model-typescript-library",
}
# "valid" and "invalid" are the validator's verdict on a rendering that was produced at all; the
# rest say the lane never got that far, and are counted apart so a conversion defect is never read
# as a validation defect.
OUTCOMES = ("valid", "invalid", "convert-error", "bridge-error", "skipped")
FAILED_OUTCOMES = ("invalid", "convert-error", "bridge-error", "skipped")


class RepresentationError(Exception):
    """The deployment does not serve the representation the audit exists to read."""


def utc_now() -> str:
    return rest.utc_now()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------------------
# The toolchain behind the two lanes
# --------------------------------------------------------------------------------------------------


def run_maven(library: Path, java_home: Optional[str], goals: list[str], timeout: float) -> None:
    environment = dict(os.environ)
    if java_home:
        environment["JAVA_HOME"] = java_home
    completed = subprocess.run(["mvn", "-q", *goals], cwd=str(library), env=environment,
                               capture_output=True, text=True, timeout=timeout)
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout).strip().splitlines()[-8:]
        raise RuntimeError(f"mvn {' '.join(goals)} failed in {library}:\n" + "\n".join(tail))


def resolve_artifact_library_classpath(library: Path, java_home: Optional[str]) -> str:
    """The artifact library's own classes and its dependency classpath, built on first use.

    The dependency classpath carries ``cedar-model-validation-library`` too, since the artifact
    library depends on it, so one JVM can convert and validate. The validation gate's classpath is
    put ahead of it by the caller, which is what makes the verdict the locally built validator's.
    """
    classes = library / "target" / "classes"
    classpath_file = library / "target" / "artifact-library-classpath.txt"
    pom = library / "pom.xml"
    if not pom.is_file():
        raise RuntimeError(f"{library} is not a Maven project (no pom.xml)")
    if not classes.is_dir():
        print(f"Building {library.name} ...", flush=True)
        run_maven(library, java_home, ["-DskipTests", "compile"], 1800)
    if not classpath_file.is_file() or pom.stat().st_mtime > classpath_file.stat().st_mtime:
        print(f"Resolving the {library.name} dependency classpath ...", flush=True)
        run_maven(library, java_home, ["dependency:build-classpath",
                                       f"-Dmdep.outputFile={classpath_file}"], 1800)
    dependencies = classpath_file.read_text(encoding="utf-8").strip()
    if not dependencies:
        raise RuntimeError(f"{classpath_file} is empty; remove it and run the audit again")
    return f"{classes}{os.pathsep}{dependencies}"


def cedar_home() -> Path:
    home = os.environ.get("CEDAR_HOME")
    if home:
        return Path(home).expanduser()
    return Path(__file__).resolve().parent.parent.parent


def resolve_toolchain(arguments: argparse.Namespace, parser: argparse.ArgumentParser
                      ) -> tuple[str, str, Path]:
    """The java binary, the classpath both Java libraries share, and the TypeScript entry point."""
    for source in (JAVA_BRIDGE_SOURCE, TS_BRIDGE_SOURCE):
        if not source.is_file():
            parser.error(f"bridge source not found: {source}")
    try:
        java = arguments.java or audit.run_validate_sh("java", 60)
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
        parser.error(str(error))
    if not Path(java).is_file():
        parser.error(f"java binary not found: {java}")
    java_home = str(Path(java).resolve().parent.parent)

    if arguments.classpath:
        classpath = arguments.classpath
    else:
        try:
            print("Resolving the validation library classpath (builds it on first use) ...", flush=True)
            validation = audit.run_validate_sh("classpath", 1800)
            artifact_library = Path(arguments.artifact_library).expanduser() if arguments.artifact_library \
                else cedar_home() / "cedar-artifact-library"
            if not artifact_library.is_dir():
                parser.error(f"cedar-artifact-library not found at {artifact_library} "
                             "(set CEDAR_HOME or pass --artifact-library)")
            classpath = f"{resolve_artifact_library_classpath(artifact_library, java_home)}{os.pathsep}{validation}"
        except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
            parser.error(str(error))

    ts_library = Path(arguments.ts_library).expanduser() if arguments.ts_library \
        else cedar_home() / "cedar-model-typescript-library" / "dist" / "index.js"
    if not ts_library.is_file():
        parser.error(f"TypeScript library entry point not found: {ts_library} "
                     "(run 'npm run build' in cedar-model-typescript-library, or pass --ts-library)")
    return java, classpath, ts_library


class ConversionBridges:
    """The two co-processes, restarted a bounded number of times when one of them dies."""

    def __init__(self, java_bridge: audit.LineBridge, ts_bridge: audit.LineBridge, max_restarts: int):
        self.bridges = {JAVA: java_bridge, TYPESCRIPT: ts_bridge}
        self.max_restarts = max_restarts
        self.restarts: collections.Counter = collections.Counter()
        self.incidents = 0
        self.hello: dict[str, dict[str, Any]] = {}

    def start(self) -> None:
        for lane, bridge in self.bridges.items():
            self.hello[lane] = bridge.start()

    def ensure_running(self, lane: str) -> None:
        bridge = self.bridges[lane]
        if bridge.process is not None:
            return
        self.restarts[lane] += 1
        if self.restarts[lane] > self.max_restarts:
            raise audit.BridgeError(
                f"the {LANE_LABEL[lane]} bridge failed {self.restarts[lane]} times; giving up")
        print(f"! restarting the {LANE_LABEL[lane]} bridge "
              f"({self.restarts[lane]}/{self.max_restarts})", file=sys.stderr)
        bridge.start()

    def request(self, lane: str, payload: dict[str, Any]) -> dict[str, Any]:
        """One exchange with one bridge. A failure becomes an answer rather than ending the run."""
        try:
            self.ensure_running(lane)
            return self.bridges[lane].request(payload)
        except audit.BridgeTimeout as error:
            self.incidents += 1
            return {"status": "bridge-error", "message": str(error)}
        except audit.BridgeError:
            if self.restarts[lane] > self.max_restarts:
                raise
            self.incidents += 1
            return {"status": "bridge-error", "message": "the bridge stopped answering"}
        except OSError as error:
            self.incidents += 1
            return {"status": "bridge-error", "message": str(error)}

    def close(self) -> None:
        for bridge in self.bridges.values():
            bridge.close()


# --------------------------------------------------------------------------------------------------
# One artifact through both lanes
# --------------------------------------------------------------------------------------------------


def fetch_yaml(client: rest.GetOnlyClient, ref: rest.ArtifactRef, compact: bool
               ) -> tuple[Any, Optional[Exception]]:
    query = {"compact": "true"} if compact else None
    try:
        return client.get_representation(rest.typed_artifact_path(ref), "application/yaml", query), None
    except Exception as error:  # noqa: BLE001 - the consumer decides which failures stop the run
        return None, error


def verdict_record(validation: dict[str, Any], max_errors: int) -> tuple[dict[str, Any], str]:
    """What one verdict contributes to the record, and the outcome it amounts to.

    The counts are exact and the lists are bounded: a deeply invalid artifact can carry hundreds of
    errors, and a records file holding every one of them for two lanes serves nobody.
    """
    status = validation.get("status")
    if status not in {"valid", "invalid"}:
        outcome = "bridge-error" if status == "bridge-error" else "skipped"
        return {"status": status or "unknown",
                "reason": validation.get("message") or validation.get("exception") or "no answer"}, outcome
    errors = validation.get("errors") or []
    warnings = validation.get("warnings") or []
    record: dict[str, Any] = {"status": status, "errorCount": len(errors),
                              "warningCount": len(warnings), "millis": validation.get("millis")}
    if errors:
        record["errors"] = errors[:max_errors]
    if warnings:
        record["warnings"] = warnings[:max_errors]
    return record, status


def run_lane(bridges: ConversionBridges, lane: str, kind: str, document: str, compact: bool,
             max_errors: int) -> dict[str, Any]:
    """One lane's whole answer for one document: the rendering it produced, and the verdict on it.

    Only the converter differs between the lanes. The verdict is always the Java validator's, so a
    divergence belongs to the converters and never to two readings of what "valid" means.
    """
    conversion = bridges.request(lane, {"op": "convert", "kind": kind, "yaml": document,
                                        "compact": compact})
    result: dict[str, Any] = {"convert": {key: value for key, value in conversion.items()
                                          if key not in {"json", "seq", "op"}}}
    if conversion.get("status") != "ok":
        result["outcome"] = "bridge-error" if conversion.get("status") == "bridge-error" \
            else "convert-error"
        return result

    rendering = conversion.get("json")
    validation = bridges.request(JAVA, {"op": "validate", "kind": kind, "artifact": rendering})
    result["validation"], result["outcome"] = verdict_record(validation, max_errors)
    result["rendering"] = rendering
    return result


def audit_artifact(bridges: ConversionBridges, ref: rest.ArtifactRef, document: str,
                   media_type: str, compact: bool, max_errors: int
                   ) -> tuple[dict[str, Any], dict[str, Any]]:
    """The record for one artifact, and the two renderings it produced, which are not recorded."""
    kind = ref.artifact_type
    record: dict[str, Any] = {
        "artifactType": kind,
        "artifactId": ref.artifact_id,
        "artifactName": ref.name,
        "fetched": True,
        "yaml": {"mediaType": media_type, "bytes": len(document.encode("utf-8")),
                 "sha256": text_sha256(document)},
    }
    renderings: dict[str, Any] = {}
    for lane in LANES:
        result = run_lane(bridges, lane, kind, document, compact, max_errors)
        renderings[lane] = result.pop("rendering", None)
        record[lane] = result
    record["outcome"] = {lane: record[lane]["outcome"] for lane in LANES}
    if renderings[JAVA] is not None and renderings[TYPESCRIPT] is not None:
        record["renderingsIdentical"] = renderings[JAVA] == renderings[TYPESCRIPT]
    return record, renderings


def first_error(lane_record: dict[str, Any]) -> str:
    """The one line that says why a lane failed, whichever step it failed at."""
    convert = lane_record.get("convert") or {}
    if convert.get("status") != "ok":
        stage = convert.get("stage", "convert")
        return f"{stage}: {convert.get('message') or convert.get('status') or 'no message'}"
    validation = lane_record.get("validation") or {}
    errors = validation.get("errors") or []
    if errors:
        first = errors[0]
        return f"{first.get('location', '/')}: {first.get('message', '')}"
    return validation.get("reason") or validation.get("status") or "no message"


# --------------------------------------------------------------------------------------------------
# Aggregation, progress and the summary
# --------------------------------------------------------------------------------------------------


@dataclass
class Aggregate:
    """Everything the summary and the final report say, rebuilt from the records alone on resume."""
    processed_by_type: collections.Counter = field(default_factory=collections.Counter)
    fetched_by_type: collections.Counter = field(default_factory=collections.Counter)
    outcomes: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    outcomes_by_type: dict[str, dict[str, collections.Counter]] = field(
        default_factory=lambda: collections.defaultdict(lambda: collections.defaultdict(collections.Counter)))
    cross: collections.Counter = field(default_factory=collections.Counter)
    convert_stages: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    messages: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    failures: dict[str, list[dict[str, Any]]] = field(
        default_factory=lambda: collections.defaultdict(list))
    renderings_identical: collections.Counter = field(default_factory=collections.Counter)
    ts_read_reports: collections.Counter = field(default_factory=collections.Counter)
    fetch_errors: list[dict[str, str]] = field(default_factory=list)
    not_yaml: list[dict[str, str]] = field(default_factory=list)
    bridge_incidents: int = 0

    @property
    def processed(self) -> int:
        return sum(self.processed_by_type.values())

    def add(self, record: dict[str, Any]) -> None:
        kind = record["artifactType"]
        self.processed_by_type[kind] += 1
        if not record.get("fetched"):
            reason = (record.get("fetch") or {}).get("reason")
            entry = {"artifactType": kind, "artifactId": record["artifactId"],
                     "artifactName": record.get("artifactName", ""),
                     "error": (record.get("fetch") or {}).get("error", "")}
            (self.not_yaml if reason == "not-yaml" else self.fetch_errors).append(entry)
        else:
            self.fetched_by_type[kind] += 1
        outcome = record.get("outcome") or {}
        for lane in LANES:
            lane_outcome = outcome.get(lane, "skipped")
            self.outcomes[lane][lane_outcome] += 1
            self.outcomes_by_type[lane][kind][lane_outcome] += 1
            lane_record = record.get(lane) or {}
            convert = lane_record.get("convert") or {}
            if convert.get("status") not in (None, "ok"):
                self.convert_stages[lane][convert.get("stage", "unknown")] += 1
            if lane_outcome in FAILED_OUTCOMES:
                message = first_error(lane_record) if lane_record else "not attempted"
                self.messages[lane][audit.normalize_message(message)[:200]] += 1
                self.failures[lane].append({
                    "artifactType": kind,
                    "artifactId": record["artifactId"],
                    "artifactName": record.get("artifactName", ""),
                    "outcome": lane_outcome,
                    "reason": message[:400],
                })
        if record.get("fetched"):
            self.cross[(outcome.get(JAVA, "skipped"), outcome.get(TYPESCRIPT, "skipped"))] += 1
        if "renderingsIdentical" in record:
            self.renderings_identical[bool(record["renderingsIdentical"])] += 1
        ts_convert = (record.get(TYPESCRIPT) or {}).get("convert") or {}
        if ts_convert.get("readErrors"):
            self.ts_read_reports["errors"] += 1
        if ts_convert.get("readWarnings"):
            self.ts_read_reports["warnings"] += 1

    def failed_ids(self) -> list[str]:
        """Every artifact that failed in either lane, once each, in enumeration order."""
        seen: dict[str, None] = {}
        for lane in LANES:
            for entry in self.failures[lane]:
                seen.setdefault(entry["artifactId"], None)
        return list(seen)


@dataclass
class Progress:
    started_monotonic: float = field(default_factory=time.monotonic)
    processing_started: Optional[float] = None
    processed_at_start: int = 0
    last_report_monotonic: float = field(default_factory=time.monotonic)
    batch_start: int = 0
    batch_by_type: collections.Counter = field(default_factory=collections.Counter)
    batch_outcomes: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter))
    batch_identical: int = 0
    batch_fetch_errors: int = 0

    def note(self, record: dict[str, Any]) -> None:
        self.batch_by_type[record["artifactType"]] += 1
        if not record.get("fetched"):
            self.batch_fetch_errors += 1
        outcome = record.get("outcome") or {}
        for lane in LANES:
            self.batch_outcomes[lane][outcome.get(lane, "skipped")] += 1
        if record.get("renderingsIdentical"):
            self.batch_identical += 1

    def reset(self, processed: int) -> None:
        self.batch_start = processed
        self.batch_by_type.clear()
        self.batch_outcomes.clear()
        self.batch_identical = 0
        self.batch_fetch_errors = 0
        self.last_report_monotonic = time.monotonic()

    @property
    def elapsed(self) -> float:
        return max(0.0, time.monotonic() - self.started_monotonic)


def counts_text(counter: collections.Counter, keys: Optional[tuple[str, ...]] = None) -> str:
    return audit.counts_text(counter, keys)


def print_progress(aggregate: Aggregate, progress: Progress, total: int, final: bool = False) -> None:
    processed = aggregate.processed
    label = "final" if final else "checkpoint"
    percent = rest.completion_percent(processed, total)
    timing = f"elapsed={rest.format_duration(progress.elapsed)}"
    processing_elapsed = time.monotonic() - (progress.processing_started or progress.started_monotonic)
    done_this_run = processed - progress.processed_at_start
    if not final and 0 < done_this_run and processed < total and processing_elapsed > 0:
        eta = (total - processed) / (done_this_run / processing_elapsed)
        timing += f", eta={rest.format_duration(eta)}"
    lanes = "; ".join(
        f"{lane} {counts_text(progress.batch_outcomes[lane], OUTCOMES)}" for lane in LANES)
    print(
        f"[{label} {processed}/{total} {percent:.1f}%] batch {progress.batch_start + 1}-{processed} "
        f"({counts_text(progress.batch_by_type)}): {lanes}; "
        f"identical={progress.batch_identical}; "
        f"fetch-errors={progress.batch_fetch_errors} batch/"
        f"{len(aggregate.fetch_errors) + len(aggregate.not_yaml)} total; {timing}",
        flush=True,
    )


def summary_document(aggregate: Aggregate, enumeration: rest.AuditState, status: str,
                     arguments: argparse.Namespace, paths: dict[str, str],
                     bridges: ConversionBridges, started_at: str, progress: Progress,
                     total: int) -> dict[str, Any]:
    return {
        "record": "yaml-conversion-audit-summary",
        "status": status,
        "server": arguments.server,
        "artifactTypes": arguments.selected_types,
        "representation": "compact YAML" if arguments.compact else "YAML",
        "startedAt": started_at,
        "generatedAt": utc_now(),
        "elapsedSeconds": round(progress.elapsed, 1),
        "scriptSha256": file_sha256(Path(__file__)),
        "javaBridgeSha256": file_sha256(JAVA_BRIDGE_SOURCE),
        "typescriptBridgeSha256": file_sha256(TS_BRIDGE_SOURCE),
        "toolchain": bridges.hello,
        "completion": {
            "processed": aggregate.processed,
            "target": total,
            "percent": round(rest.completion_percent(aggregate.processed, total), 2),
            "processedByType": dict(aggregate.processed_by_type),
            "fetchedByType": dict(aggregate.fetched_by_type),
            "expectedByType": enumeration.expected_by_type,
            "enumeratedByType": enumeration.enumerated_by_type,
        },
        "lanes": {
            lane: {
                "label": LANE_LABEL[lane],
                "outcomes": dict(aggregate.outcomes[lane]),
                "outcomesByType": {kind: dict(counter)
                                   for kind, counter in aggregate.outcomes_by_type[lane].items()},
                "conversionFailureStages": dict(aggregate.convert_stages[lane]),
                "topMessages": aggregate.messages[lane].most_common(15),
                "failedArtifacts": len(aggregate.failures[lane]),
            }
            for lane in LANES
        },
        "crossTabulation": {f"java={java_outcome},typescript={ts_outcome}": count
                            for (java_outcome, ts_outcome), count in sorted(aggregate.cross.items())},
        "renderingsIdentical": {"identical": aggregate.renderings_identical[True],
                                "divergent": aggregate.renderings_identical[False]},
        "typescriptReaderReports": dict(aggregate.ts_read_reports),
        "failedArtifactIds": aggregate.failed_ids(),
        "fetchErrors": aggregate.fetch_errors,
        "notServedAsYaml": aggregate.not_yaml,
        "bridgeIncidents": aggregate.bridge_incidents + bridges.incidents,
        "listingErrors": enumeration.listing_errors,
        "duplicateSearchRowsSkipped": enumeration.duplicates,
        "searchTotalCountChanges": enumeration.total_count_changes,
        "paths": paths,
    }


def failures_document(aggregate: Aggregate, status: str, arguments: argparse.Namespace,
                      started_at: str, total: int) -> dict[str, Any]:
    """The complete list of failing identifiers, which the printed report only samples."""
    return {
        "record": "yaml-conversion-audit-failures",
        "status": status,
        "server": arguments.server,
        "representation": "compact YAML" if arguments.compact else "YAML",
        "startedAt": started_at,
        "generatedAt": utc_now(),
        "processed": aggregate.processed,
        "target": total,
        "failedArtifactIds": aggregate.failed_ids(),
        "byLane": {
            lane: {
                "label": LANE_LABEL[lane],
                "count": len(aggregate.failures[lane]),
                "byOutcome": {
                    outcome: [entry["artifactId"] for entry in aggregate.failures[lane]
                              if entry["outcome"] == outcome]
                    for outcome in FAILED_OUTCOMES
                    if any(entry["outcome"] == outcome for entry in aggregate.failures[lane])
                },
                "artifacts": aggregate.failures[lane],
            }
            for lane in LANES
        },
    }


# --------------------------------------------------------------------------------------------------
# Refs manifest and resume
# --------------------------------------------------------------------------------------------------


def manifest_expectations(arguments: argparse.Namespace) -> dict[str, Any]:
    return {
        "formatVersion": REFS_FORMAT_VERSION,
        "server": arguments.server,
        "artifactTypes": arguments.selected_types,
        "compact": arguments.compact,
        "limit": arguments.limit,
        "scriptSha256": file_sha256(Path(__file__)),
        "javaBridgeSha256": file_sha256(JAVA_BRIDGE_SOURCE),
        "typescriptBridgeSha256": file_sha256(TS_BRIDGE_SOURCE),
    }


def write_refs_manifest(path: Path, arguments: argparse.Namespace, enumeration: rest.AuditState,
                        refs: list[rest.ArtifactRef], started_at: str) -> None:
    header = {
        "record": MANIFEST_RECORD,
        **manifest_expectations(arguments),
        "startedAt": started_at,
        "expectedByType": enumeration.expected_by_type,
        "enumeratedByType": enumeration.enumerated_by_type,
        "paginationByType": enumeration.pagination_by_type,
        "listingErrors": enumeration.listing_errors,
        "duplicateSearchRowsSkipped": enumeration.duplicates,
        "searchTotalCountChanges": enumeration.total_count_changes,
        "artifactRefCount": len(refs),
    }
    with rest.open_private_text_file(path) as stream:
        stream.write(json.dumps(header, ensure_ascii=False) + "\n")
        for ref in refs:
            stream.write(json.dumps({
                "record": "artifact-ref",
                "artifactType": ref.artifact_type,
                "artifactId": ref.artifact_id,
                "artifactName": ref.name,
            }, ensure_ascii=False) + "\n")


def load_refs_manifest(path: Path, arguments: argparse.Namespace, parser: argparse.ArgumentParser
                       ) -> tuple[dict[str, Any], list[rest.ArtifactRef]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        parser.error(f"cannot read resume refs file {path}: {error}")
    if not lines:
        parser.error(f"resume refs file is empty: {path}")
    try:
        records = [json.loads(line) for line in lines if line.strip()]
    except json.JSONDecodeError as error:
        parser.error(f"resume refs file is not valid JSONL: {path}:{error.lineno}: {error.msg}")
    header = records[0]
    if not isinstance(header, dict) or header.get("record") != MANIFEST_RECORD:
        parser.error(f"resume refs file has no {MANIFEST_RECORD} header: {path}")
    mismatches = [name for name, value in manifest_expectations(arguments).items()
                  if header.get(name) != value]
    if mismatches:
        parser.error("resume refs file does not match this invocation: " + ", ".join(mismatches)
                     + " (a changed script or bridge needs a new run)")
    refs: list[rest.ArtifactRef] = []
    for record in records[1:]:
        if not isinstance(record, dict) or record.get("record") != "artifact-ref":
            parser.error(f"resume refs file contains an unexpected record: {path}")
        refs.append(rest.ArtifactRef(str(record.get("artifactType", "")),
                                     str(record.get("artifactId", "")),
                                     str(record.get("artifactName", ""))))
    if len(refs) != header.get("artifactRefCount"):
        parser.error(f"resume refs file is incomplete: expected {header.get('artifactRefCount')} refs, "
                     f"found {len(refs)}")
    return header, refs


def load_existing_records(path: Path, parser: argparse.ArgumentParser
                          ) -> dict[tuple[str, str], dict[str, Any]]:
    """The last record for every artifact already in the output; a retried fetch supersedes a failure."""
    records: dict[tuple[str, str], dict[str, Any]] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        parser.error(f"cannot read records file for --resume: {error}")
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            parser.error(f"invalid record in {path}:{line_number}: {error.msg}")
        if not isinstance(record, dict) or "artifactType" not in record or "artifactId" not in record:
            parser.error(f"record without an artifact key in {path}:{line_number}")
        records[(record["artifactType"], record["artifactId"])] = record
    return records


def restore_enumeration(header: dict[str, Any], limit: Optional[int]) -> rest.AuditState:
    enumeration = rest.AuditState(limit=limit, started_at=str(header.get("startedAt", utc_now())))
    enumeration.expected_by_type.update(header.get("expectedByType", {}))
    enumeration.enumerated_by_type.update(header.get("enumeratedByType", {}))
    enumeration.pagination_by_type.update(header.get("paginationByType", {}))
    enumeration.listing_errors = int(header.get("listingErrors", 0))
    enumeration.duplicates = int(header.get("duplicateSearchRowsSkipped", 0))
    enumeration.total_count_changes.extend(header.get("searchTotalCountChanges", []))
    enumeration.enumeration_complete = True
    return enumeration


# --------------------------------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------------------------------


SLUG_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def artifact_slug(ref: rest.ArtifactRef) -> str:
    tail = ref.artifact_id.rstrip("/").rsplit("/", 1)[-1] or ref.artifact_id
    return f"{ref.artifact_type}-{SLUG_UNSAFE.sub('-', tail)[:80]}"


def save_failing_artifact(directory: Path, ref: rest.ArtifactRef, document: str,
                          renderings: dict[str, Any]) -> None:
    """Keep what a failing artifact was made of, so the next look at it costs no fetch."""
    directory.mkdir(parents=True, exist_ok=True)
    slug = artifact_slug(ref)
    (directory / f"{slug}.yaml").write_text(document, encoding="utf-8")
    for lane in LANES:
        if renderings.get(lane) is not None:
            (directory / f"{slug}.{lane}.json").write_text(
                json.dumps(renderings[lane], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def preflight_representation(client: rest.GetOnlyClient, ref: rest.ArtifactRef, compact: bool) -> None:
    """Prove the deployment serves YAML before spending a whole pass discovering that it does not."""
    fetched, error = fetch_yaml(client, ref, compact)
    if error is not None:
        if isinstance(error, rest.AuthenticationError):
            raise error
        # One artifact that cannot be read says nothing about the representation, and the pass
        # records the failure for itself when it reaches this artifact again.
        print(f"! preflight read of {ref.artifact_id} failed: {error}", file=sys.stderr)
        return
    _, media_type = fetched
    if media_type not in YAML_MEDIA_TYPES:
        raise RepresentationError(
            f"the server answered an Accept of application/yaml with {media_type}. This deployment "
            "does not serve the YAML representation, so there is nothing for either library to "
            "convert; audit a deployment whose resource server negotiates YAML.")
    print(f"Preflight: the server serves {media_type}", flush=True)


def run_audit(arguments: argparse.Namespace, client: rest.GetOnlyClient, bridges: ConversionBridges,
              records_stream, summary_path: Path, refs_path: Path, failures_path: Path,
              started_at: str) -> tuple[Aggregate, str, int]:
    aggregate = Aggregate()
    progress = Progress()
    completed: set[tuple[str, str]] = set()
    if arguments.resume:
        enumeration = arguments.resume_enumeration
        refs = arguments.resume_refs
        for key, record in arguments.resume_records.items():
            aggregate.add(record)
            if record.get("fetched"):
                completed.add(key)
        print(f"Resuming from {refs_path}: {len(completed)}/{len(refs)} artifacts already complete",
              flush=True)
    else:
        enumeration = rest.AuditState(limit=arguments.limit, started_at=started_at)
        refs = []
    paths = {"records": str(arguments.out), "summary": str(summary_path), "refs": str(refs_path),
             "failures": str(failures_path), "javaLog": str(arguments.java_log),
             "typescriptLog": str(arguments.ts_log)}
    save_failing = Path(arguments.save_failing).expanduser() if arguments.save_failing else None
    status = "RUNNING"
    total = 0

    def checkpoint(final: bool = False) -> None:
        if not final or aggregate.processed > progress.batch_start or aggregate.processed == 0:
            print_progress(aggregate, progress, total, final)
        rest.atomic_write_json(summary_path, summary_document(
            aggregate, enumeration, status if final else "RUNNING", arguments, paths, bridges,
            started_at, progress, total))
        rest.atomic_write_json(failures_path, failures_document(
            aggregate, status if final else "RUNNING", arguments, started_at, total))
        progress.reset(aggregate.processed)

    def emit(record: dict[str, Any]) -> None:
        records_stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        records_stream.flush()
        aggregate.add(record)
        progress.note(record)
        if (aggregate.processed - progress.batch_start >= arguments.progress_every
                or time.monotonic() - progress.last_report_monotonic >= arguments.progress_seconds):
            checkpoint()

    try:
        if not arguments.resume:
            rest.preflight_expected_counts(client, arguments.selected_types, enumeration)
            reported = ", ".join(f"{kind}={enumeration.expected_by_type[kind]}"
                                 for kind in arguments.selected_types)
            print(f"Search reports: {enumeration.expected_total} rows ({reported}); "
                  "enumerating unique IDs", flush=True)
            for artifact_type in arguments.selected_types:
                remaining = None if arguments.limit is None else max(0, arguments.limit - len(refs))
                if remaining == 0:
                    break
                found = audit.enumerate_with_progress(client, artifact_type, arguments.page_size,
                                                      enumeration, remaining)
                enumeration.enumerated_by_type[artifact_type] = len(found)
                refs.extend(found)
            enumeration.enumeration_complete = True
            write_refs_manifest(refs_path, arguments, enumeration, refs, started_at)
        total = len(refs)
        selected = ", ".join(f"{kind}={enumeration.enumerated_by_type.get(kind, 0)}"
                             for kind in arguments.selected_types)
        limit_note = f"; sample limit={arguments.limit}" if arguments.limit is not None else ""
        print(f"Audit total: {total} unique schema artifacts ({selected}){limit_note}", flush=True)
        if not refs:
            return aggregate, "COMPLETE_FOR_KEY", 0
        if not arguments.resume:
            preflight_representation(client, refs[0], arguments.compact)
        rest.atomic_write_json(summary_path, summary_document(
            aggregate, enumeration, "RUNNING", arguments, paths, bridges, started_at, progress, total))
        progress.processing_started = time.monotonic()
        progress.processed_at_start = aggregate.processed
        progress.reset(aggregate.processed)

        pending_refs = [ref for ref in refs if audit.artifact_key(ref) not in completed]
        for ref, fetched, error in audit.fetch_in_order(
                client, pending_refs, arguments.fetch_workers,
                fetch=lambda c, r: fetch_yaml(c, r, arguments.compact)):
            if error is not None:
                if isinstance(error, rest.AuthenticationError):
                    raise error
                print(f"! could not fetch {ref.artifact_type} {ref.artifact_id}: {error}",
                      file=sys.stderr)
                emit({
                    "artifactType": ref.artifact_type,
                    "artifactId": ref.artifact_id,
                    "artifactName": ref.name,
                    "fetched": False,
                    "fetch": {"reason": "fetch-failed", "error": str(error)},
                    "outcome": {lane: "skipped" for lane in LANES},
                })
                continue

            document, media_type = fetched
            if media_type not in YAML_MEDIA_TYPES:
                emit({
                    "artifactType": ref.artifact_type,
                    "artifactId": ref.artifact_id,
                    "artifactName": ref.name,
                    "fetched": False,
                    "fetch": {"reason": "not-yaml", "error": f"the server answered {media_type}"},
                    "outcome": {lane: "skipped" for lane in LANES},
                })
                continue

            record, renderings = audit_artifact(bridges, ref, document, media_type,
                                                arguments.compact, arguments.max_errors)
            if save_failing is not None and any(
                    record["outcome"][lane] in FAILED_OUTCOMES for lane in LANES):
                try:
                    save_failing_artifact(save_failing, ref, document, renderings)
                except OSError as save_error:
                    print(f"! could not save {ref.artifact_id}: {save_error}", file=sys.stderr)
            emit(record)

        if aggregate.fetch_errors or aggregate.not_yaml or enumeration.listing_errors \
                or bridges.incidents:
            status = "PARTIAL_ERRORS"
        elif enumeration.total_count_changes or enumeration.duplicates:
            status = "PARTIAL_CONCURRENT_CHANGES"
        elif arguments.limit is not None and aggregate.processed >= arguments.limit:
            status = f"SAMPLE_LIMIT_{arguments.limit}"
        else:
            status = "COMPLETE_FOR_KEY"
    except KeyboardInterrupt:
        status = "PARTIAL_INTERRUPTED"
    except rest.AuthenticationError as error:
        status = "PARTIAL_AUTHENTICATION_ERROR"
        print(f"! {error}", file=sys.stderr)
    except RepresentationError as error:
        status = "PARTIAL_NO_YAML_REPRESENTATION"
        print(f"! {error}", file=sys.stderr)
    except audit.BridgeError as error:
        status = "PARTIAL_BRIDGE_FAILURE"
        print(f"! {error}", file=sys.stderr)
    except Exception as error:  # noqa: BLE001 - the partial report is the point
        status = f"PARTIAL_{type(error).__name__.upper()}"
        enumeration.listing_errors += 1
        print(f"! audit stopped: {type(error).__name__}: {error}", file=sys.stderr)
    finally:
        checkpoint(final=True)
    return aggregate, status, total


# --------------------------------------------------------------------------------------------------
# The final report
# --------------------------------------------------------------------------------------------------


def print_lane_table(aggregate: Aggregate) -> None:
    width = max(len(LANE_LABEL[lane]) for lane in LANES)
    columns = [outcome for outcome in OUTCOMES
               if any(aggregate.outcomes[lane][outcome] for lane in LANES)]
    header = "  ".join(f"{outcome:>13}" for outcome in columns)
    print(f"  {'converter':<{width}}  {header}")
    for lane in LANES:
        cells = "  ".join(f"{aggregate.outcomes[lane][outcome]:>13}" for outcome in columns)
        print(f"  {LANE_LABEL[lane]:<{width}}  {cells}")


def print_failures(aggregate: Aggregate, lane: str, maximum: int, failures_path: Path) -> None:
    entries = aggregate.failures[lane]
    if not entries:
        print(f"\n{LANE_LABEL[lane]}: every artifact converted and validated")
        return
    print(f"\n{LANE_LABEL[lane]}: {len(entries)} artifacts failed")
    by_outcome: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for entry in entries:
        by_outcome[entry["outcome"]].append(entry)
    for outcome in FAILED_OUTCOMES:
        group = by_outcome.get(outcome)
        if not group:
            continue
        print(f"  {outcome} ({len(group)}):")
        shown = group if maximum <= 0 else group[:maximum]
        for entry in shown:
            name = f' "{entry["artifactName"]}"' if entry["artifactName"] else ""
            print(f"    {entry['artifactId']}{name}")
            print(f"      {entry['reason'][:160]}")
        if len(group) > len(shown):
            print(f"    ... and {len(group) - len(shown)} more; all of them are in {failures_path}")


def print_final_report(aggregate: Aggregate, status: str, total: int, arguments: argparse.Namespace,
                       paths: dict[str, Path]) -> None:
    print("\n=== Final report ===")
    print(f"status: {status}")
    print(f"representation: {'compact YAML' if arguments.compact else 'YAML'} from {arguments.server}")
    print(f"schema artifacts: processed={aggregate.processed}/{total} "
          f"({counts_text(aggregate.processed_by_type)})")
    print(f"YAML fetched: {sum(aggregate.fetched_by_type.values())}; "
          f"fetch errors: {len(aggregate.fetch_errors)}; "
          f"not served as YAML: {len(aggregate.not_yaml)}")

    print("\nOutcome by converter, both validated by cedar-model-validation-library:")
    print_lane_table(aggregate)
    for lane in LANES:
        stages = aggregate.convert_stages[lane]
        if stages:
            print(f"  {LANE_LABEL[lane]} conversion failures by stage: {counts_text(stages)}")

    both = aggregate.renderings_identical
    if both:
        converted = both[True] + both[False]
        print(f"\nRenderings identical: {both[True]} of {converted} artifacts both converters rendered "
              f"({rest.completion_percent(both[True], converted):.1f}%)")
    if aggregate.ts_read_reports:
        print(f"TypeScript reader reported on the document it read: "
              f"{counts_text(aggregate.ts_read_reports)}")

    if aggregate.cross:
        print("\nAgreement between the two lanes:")
        width = max(len(f"java={java}") for java, _ in aggregate.cross)
        for (java_outcome, ts_outcome), count in sorted(aggregate.cross.items(),
                                                        key=lambda item: -item[1]):
            print(f"  {'java=' + java_outcome:<{width}}  typescript={ts_outcome:<14}  {count:>7}")

    for lane in LANES:
        messages = aggregate.messages[lane]
        if messages:
            print(f"\nMost common failure for {LANE_LABEL[lane]} (names and numbers folded out):")
            for message, count in messages.most_common(8):
                print(f"  {count:>7}  {message[:140]}")

    for lane in LANES:
        print_failures(aggregate, lane, arguments.max_listed_ids, paths["failures"])

    failed = aggregate.failed_ids()
    print(f"\nSchema artifacts that failed in at least one lane: {len(failed)}")
    print(f"records: {paths['records']}")
    print(f"summary: {paths['summary']}")
    print(f"failing identifiers: {paths['failures']}")
    print("No artifact writes were issued; the HTTP client supports GET only.")


# --------------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------------


def parse_schema_types(value: str, parser: argparse.ArgumentParser) -> list[str]:
    if value.strip().lower() == "all":
        return list(SCHEMA_TYPES)
    chosen = [part.strip().lower() for part in value.split(",") if part.strip()]
    unknown = [kind for kind in chosen if kind not in SCHEMA_TYPES]
    if unknown:
        parser.error(f"unknown schema artifact type: {', '.join(unknown)} "
                     f"(choose from {', '.join(SCHEMA_TYPES)}, or all)")
    if not chosen:
        parser.error("--types selected nothing")
    return [kind for kind in SCHEMA_TYPES if kind in chosen]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch every schema artifact as YAML, convert it to JSON Schema with the Java "
                    "artifact library and with the TypeScript model library, and validate both "
                    "renderings with cedar-model-validation-library.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="The records JSONL holds verdicts and message text, never full artifacts or the API "
               "key. A COMPLETE_FOR_KEY result is permission-scoped: it covers what the supplied "
               "key can read.",
    )
    parser.add_argument("--server", default=rest.DEFAULT_SERVER,
                        help=f"resource server origin (default: {rest.DEFAULT_SERVER})")
    parser.add_argument("--api-key-file",
                        help="read the API key from this one-line file; otherwise CEDAR_API_KEY or a prompt")
    parser.add_argument("--types", default="all",
                        help=f"comma-separated schema artifact types or all "
                             f"(choices: {', '.join(SCHEMA_TYPES)}; default: all)")
    parser.add_argument("--compact", action="store_true",
                        help="audit the compact YAML representation instead of the full one")
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE,
                        help=f"search-deep page size; the server caps it at its maxPageSize "
                             f"(default: {DEFAULT_PAGE_SIZE})")
    parser.add_argument("--limit", type=int, help="quick sample: stop after this many artifacts total")
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY,
                        help=f"report and checkpoint every N artifacts (default: {DEFAULT_PROGRESS_EVERY})")
    parser.add_argument("--progress-seconds", type=float, default=DEFAULT_PROGRESS_SECONDS,
                        help=f"also report when this many seconds have passed "
                             f"(default: {DEFAULT_PROGRESS_SECONDS})")
    parser.add_argument("--fetch-workers", type=int, default=DEFAULT_FETCH_WORKERS,
                        help=f"concurrent GETs fetching ahead of conversion (default: {DEFAULT_FETCH_WORKERS})")
    parser.add_argument("--out", default="cedar-yaml-conversion.jsonl",
                        help="one JSON record per artifact (default: cedar-yaml-conversion.jsonl)")
    parser.add_argument("--summary", help="summary JSON path (default: <out without suffix>-summary.json)")
    parser.add_argument("--failures",
                        help="failing identifiers JSON path (default: <out without suffix>-failures.json)")
    parser.add_argument("--refs", help="enumerated refs JSONL path (default: <out without suffix>-refs.jsonl)")
    parser.add_argument("--java-log", help="the JVM's stderr (default: <out without suffix>-java.log)")
    parser.add_argument("--ts-log", help="the Node bridge's stderr (default: <out without suffix>-node.log)")
    parser.add_argument("--save-failing", metavar="DIR",
                        help="write the YAML and both renderings of every failing artifact into DIR")
    parser.add_argument("--max-errors", type=int, default=DEFAULT_MAX_ERRORS,
                        help=f"validator errors and warnings kept per lane per artifact; the counts "
                             f"stay exact (default: {DEFAULT_MAX_ERRORS})")
    parser.add_argument("--max-listed-ids", type=int, default=DEFAULT_MAX_LISTED_IDS,
                        help=f"identifiers to print per failure group; 0 prints all "
                             f"(default: {DEFAULT_MAX_LISTED_IDS}). The failures file always holds them all")
    parser.add_argument("--resume", action="store_true",
                        help="continue from --refs, appending to the existing records")
    parser.add_argument("--java", help="java binary (default: what cedar_validate.sh java resolves)")
    parser.add_argument("--classpath",
                        help="the whole Java classpath, artifact library and validator both "
                             "(default: resolved from the two checkouts)")
    parser.add_argument("--artifact-library",
                        help="cedar-artifact-library checkout (default: $CEDAR_HOME/cedar-artifact-library)")
    parser.add_argument("--ts-library",
                        help="the TypeScript library's built entry point "
                             "(default: $CEDAR_HOME/cedar-model-typescript-library/dist/index.js)")
    parser.add_argument("--node", default="node", help="node binary (default: node)")
    parser.add_argument("--jvm-heap", default="2g", help="JVM maximum heap (default: 2g)")
    parser.add_argument("--bridge-timeout", type=float, default=DEFAULT_BRIDGE_TIMEOUT,
                        help=f"seconds to wait for one bridge answer (default: {DEFAULT_BRIDGE_TIMEOUT})")
    parser.add_argument("--bridge-max-restarts", type=int, default=DEFAULT_BRIDGE_MAX_RESTARTS,
                        help=f"restart a dead bridge at most this many times "
                             f"(default: {DEFAULT_BRIDGE_MAX_RESTARTS})")
    parser.add_argument("--timeout", type=float, default=90, help="HTTP timeout in seconds (default: 90)")
    parser.add_argument("--retries", type=int, default=5, help="HTTP retries per request (default: 5)")
    parser.add_argument("--delay-ms", type=int, default=0, help="pause before each request (default: 0)")
    parser.add_argument("--ca-file", help="CA bundle for a deployment with a private certificate")
    parser.add_argument("--allow-http", action="store_true",
                        help="permit an http:// server, for a local test deployment only")
    parser.add_argument("--fail-on-failure", action="store_true",
                        help="exit 1 when any artifact failed in either lane")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    for name in ("page_size", "progress_every", "retries", "fetch_workers", "bridge_max_restarts",
                 "max_errors"):
        if getattr(arguments, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    for name in ("progress_seconds", "timeout", "bridge_timeout"):
        if getattr(arguments, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if arguments.limit is not None and arguments.limit <= 0:
        parser.error("--limit must be positive")
    if arguments.max_listed_ids < 0:
        parser.error("--max-listed-ids must not be negative")
    arguments.selected_types = parse_schema_types(arguments.types, parser)
    api_key = rest.resolve_api_key(arguments, parser)

    records_path = Path(arguments.out).expanduser()
    stem = records_path.stem
    summary_path = Path(arguments.summary).expanduser() if arguments.summary \
        else records_path.with_name(stem + "-summary.json")
    failures_path = Path(arguments.failures).expanduser() if arguments.failures \
        else records_path.with_name(stem + "-failures.json")
    refs_path = Path(arguments.refs).expanduser() if arguments.refs \
        else records_path.with_name(stem + "-refs.jsonl")
    java_log_path = Path(arguments.java_log).expanduser() if arguments.java_log \
        else records_path.with_name(stem + "-java.log")
    ts_log_path = Path(arguments.ts_log).expanduser() if arguments.ts_log \
        else records_path.with_name(stem + "-node.log")
    outputs = (records_path, summary_path, failures_path, refs_path, java_log_path, ts_log_path)
    if len({path.resolve() for path in outputs}) != len(outputs):
        parser.error("--out, --summary, --failures, --refs, --java-log and --ts-log "
                     "must name different files")
    arguments.out = str(records_path)
    arguments.java_log = str(java_log_path)
    arguments.ts_log = str(ts_log_path)
    arguments.server = arguments.server.rstrip("/")
    for path in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)

    if arguments.resume:
        header, refs = load_refs_manifest(refs_path, arguments, parser)
        records = load_existing_records(records_path, parser)
        known = {audit.artifact_key(ref) for ref in refs}
        if set(records) - known:
            parser.error("records file contains artifact IDs absent from the resume refs file")
        arguments.resume_refs = refs
        arguments.resume_records = records
        arguments.resume_enumeration = restore_enumeration(header, arguments.limit)
        started_at = str(header.get("startedAt", utc_now()))
    else:
        started_at = utc_now()

    java, classpath, ts_library = resolve_toolchain(arguments, parser)
    try:
        client = rest.GetOnlyClient(
            arguments.server, api_key, timeout=arguments.timeout, retries=arguments.retries,
            delay_ms=arguments.delay_ms, ca_file=arguments.ca_file, allow_http=arguments.allow_http,
        )
    except (ValueError, OSError) as error:
        parser.error(str(error))

    bridges = ConversionBridges(
        audit.LineBridge([java, f"-Xmx{arguments.jvm_heap}", "-cp", classpath, str(JAVA_BRIDGE_SOURCE)],
                         java_log_path, arguments.bridge_timeout),
        audit.LineBridge([arguments.node, str(TS_BRIDGE_SOURCE), "--lib", str(ts_library)],
                         ts_log_path, arguments.bridge_timeout),
        arguments.bridge_max_restarts,
    )
    print(f"GET-only YAML conversion audit of {arguments.server}")
    print(f"Scope: {', '.join(arguments.selected_types)}; permission-scoped to this key")
    print(f"Representation: {'compact YAML' if arguments.compact else 'YAML'}")
    print(f"Records: {records_path}; summary: {summary_path}; failures: {failures_path}")
    print(f"Refs: {refs_path}; JVM log: {java_log_path}; Node log: {ts_log_path}")
    print("Mode: resume (append records, reuse enumerated refs)" if arguments.resume
          else "Mode: new audit")
    print(f"Progress: every {arguments.progress_every} artifacts or "
          f"{arguments.progress_seconds:.0f}s; {arguments.fetch_workers} fetch worker(s)")
    try:
        bridges.start()
    except (audit.BridgeError, TimeoutError, OSError) as error:
        bridges.close()
        parser.error(f"cannot start a conversion bridge: {error} "
                     f"(see {java_log_path} and {ts_log_path})")
    print(f"Java lane: {bridges.hello[JAVA].get('reader')} -> "
          f"{bridges.hello[JAVA].get('renderer')} on Java {bridges.hello[JAVA].get('java')}")
    print(f"TypeScript lane: {bridges.hello[TYPESCRIPT].get('libraryVersion')} on Node "
          f"{bridges.hello[TYPESCRIPT].get('node')}")
    print(f"Validator: {bridges.hello[JAVA].get('validator')}", flush=True)

    try:
        with rest.open_private_text_file(records_path, append=arguments.resume) as records_stream:
            aggregate, status, total = run_audit(arguments, client, bridges, records_stream,
                                                 summary_path, refs_path, failures_path, started_at)
    except OSError as error:
        bridges.close()
        parser.error(f"cannot open records file securely: {error}")
    finally:
        bridges.close()

    print_final_report(aggregate, status, total, arguments,
                       {"records": records_path, "summary": summary_path, "failures": failures_path})
    if status.startswith("PARTIAL"):
        return 2
    if arguments.fail_on_failure and aggregate.failed_ids():
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
