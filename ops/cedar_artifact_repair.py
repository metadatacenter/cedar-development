#!/usr/bin/env python3
"""Repair a defect across a population of stored CEDAR artifacts, one verbatim write at a time.

A repair here is a transform narrow enough to state as an invariant: it changes exactly the thing it
names and provably nothing else. Each artifact is fetched, transformed, checked against that
invariant, validated by ``cedar-model-validation-library``, and only then written back with
``PUT ?verbatim=true``, which stores the body as supplied. The artifact therefore keeps its
identifier, provenance timestamps, version, publication status and every child identifier, and the
unrelated normalization an ordinary update performs never runs.

The one repair implemented is ``empty-derived-from``: delete every ``pav:derivedFrom`` whose value is
the empty string, at the artifact root and at every depth. The key is optional, so absence is how an
artifact that was derived from nothing says so; the empty string is the same claim in a form the
model cannot read, and the validator rejects it. Nothing outside the artifact references provenance,
so no instance can be affected.

Targets come from an earlier ``cedar_artifact_validation_audit.py`` run rather than a fresh walk:
the audit already knows which artifacts carry the condition.

    export CEDAR_API_KEY=...
    python3 ops/cedar_artifact_repair.py --from-records production-validation.jsonl   # dry run
    python3 ops/cedar_artifact_repair.py --from-records production-validation.jsonl --limit 5 --apply
    python3 ops/cedar_artifact_repair.py --from-records production-validation.jsonl --apply

Dry run is the default and issues no writes. ``--apply`` needs the WRITE_ARTIFACT_VERBATIM
permission, which the ``artifactPrivilegedAdministrator`` role carries. Every artifact's stored body
is saved before it is written, so any write can be undone from the pre-image.

Requires JDK 17 and a built cedar-model-validation-library; ops/cedar_validate.sh resolves both.
"""

from __future__ import annotations

import argparse
import collections
import copy
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as audit  # noqa: E402

DERIVED_FROM = "pav:derivedFrom"
OUTCOMES = ("repaired", "would-repair", "already-clean", "still-invalid", "invariant-failed",
            "fetch-failed", "write-failed")
DEFAULT_PROGRESS_EVERY = 100
DEFAULT_PROGRESS_SECONDS = 30


# --------------------------------------------------------------------------------------------------
# The repairs
# --------------------------------------------------------------------------------------------------


def strip_empty_derived_from(artifact: Any) -> tuple[Any, list[str]]:
    """Delete every empty-string ``pav:derivedFrom``, and say where each one was.

    A value that is present and non-empty is left exactly as stored, even when it is unusable: this
    repair speaks only for the empty case, and a second run over a repaired artifact finds nothing.
    """
    removed: list[str] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {}
            for name, value in node.items():
                if name == DERIVED_FROM and value == "":
                    removed.append(f"{path}/{rest.json_pointer_component(name)}")
                    continue
                result[name] = walk(value, f"{path}/{rest.json_pointer_component(name)}")
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    return walk(copy.deepcopy(artifact), ""), removed


def only_removed_empty_derived_from(before: Any, after: Any, path: str = "") -> Optional[str]:
    """The invariant. Returns the path of the first unintended difference, or None when there is none.

    Key order is deliberately not compared: JSON objects are unordered, and the transform rebuilds
    them. Everything else must be identical, including every value the repair did not name.
    """
    if isinstance(before, dict):
        if not isinstance(after, dict):
            return path or "/"
        for name, value in before.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name not in after:
                if not (name == DERIVED_FROM and value == ""):
                    return here
                continue
            difference = only_removed_empty_derived_from(value, after[name], here)
            if difference is not None:
                return difference
        for name in after:
            if name not in before:
                return f"{path}/{rest.json_pointer_component(name)}"
        return None
    if isinstance(before, list):
        if not isinstance(after, list) or len(before) != len(after):
            return path or "/"
        for index, value in enumerate(before):
            difference = only_removed_empty_derived_from(value, after[index], f"{path}/{index}")
            if difference is not None:
                return difference
        return None
    # Types are compared as well as values: Python equates False with 0 and True with 1, while JSON
    # keeps them apart, so equality alone would let one become the other unnoticed.
    return None if type(before) is type(after) and before == after else (path or "/")


@dataclass(frozen=True)
class Repair:
    name: str
    condition: str
    summary: str
    transform: Callable[[Any], tuple[Any, list[str]]]
    invariant: Callable[[Any, Any], Optional[str]]


REPAIRS = {
    "empty-derived-from": Repair(
        name="empty-derived-from",
        condition="derived-from-empty",
        summary="delete every pav:derivedFrom whose value is the empty string",
        transform=strip_empty_derived_from,
        invariant=only_removed_empty_derived_from,
    ),
}


# --------------------------------------------------------------------------------------------------
# A client that may also write, under the audit's transport discipline
# --------------------------------------------------------------------------------------------------


class RepairClient(rest.GetOnlyClient):
    """The audit's client, plus the one write this tool performs.

    Inherits its TLS handling, its refusal to follow a redirect with the API key attached, and its
    origin check, so a repair cannot send credentials anywhere the audit would not.
    """

    def put_verbatim(self, path: str, body: Any, etag: Optional[str]) -> tuple[int, Optional[str]]:
        if not path.startswith("/"):
            raise ValueError("request path must start with /")
        url = self.server + path + "?verbatim=true"
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme, parsed.netloc) != self.origin:
            raise ValueError("refusing to send the API key outside the configured origin")
        headers = {
            "Authorization": f"apiKey {self.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if etag:
            headers["If-Match"] = etag
        request = urllib.request.Request(
            url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers, method="PUT",
        )
        if self.delay:
            time.sleep(self.delay)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return response.status, response.headers.get("ETag")
        except urllib.error.HTTPError as error:
            detail = error.read(600).decode("utf-8", errors="replace")
            raise rest.ResponseError(f"PUT {path} returned {error.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as error:
            raise rest.ResponseError(f"PUT {path} failed: {type(error).__name__}: {error}") from None

    def get_with_etag(self, path: str) -> tuple[Any, Optional[str]]:
        """The audit's GET returns only the body; a conditional write needs the revision with it."""
        url = self.server + path
        request = urllib.request.Request(
            url, headers={"Authorization": f"apiKey {self.api_key}", "Accept": "application/json"},
            method="GET",
        )
        if self.delay:
            time.sleep(self.delay)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.load(response), response.headers.get("ETag")
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise rest.AuthenticationError("401 Unauthorized; check CEDAR_API_KEY") from None
            detail = error.read(300).decode("utf-8", errors="replace")
            raise rest.ResponseError(f"GET {path} returned {error.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise rest.ResponseError(f"GET {path} failed: {type(error).__name__}: {error}") from None


# --------------------------------------------------------------------------------------------------
# Targets, pre-images and progress
# --------------------------------------------------------------------------------------------------


def targets_from_records(path: Path, condition: str, parser: argparse.ArgumentParser
                         ) -> list[rest.ArtifactRef]:
    refs: list[rest.ArtifactRef] = []
    seen: set[tuple[str, str]] = set()
    try:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if condition not in line:
                    continue
                record = json.loads(line)
                if condition not in (record.get("conditionRules") or {}):
                    continue
                key = (record["artifactType"], record["artifactId"])
                if key in seen:
                    continue
                seen.add(key)
                refs.append(rest.ArtifactRef(record["artifactType"], record["artifactId"],
                                             record.get("artifactName", "")))
    except (OSError, ValueError) as error:
        parser.error(f"cannot read --from-records {path}: {error}")
    if not refs:
        parser.error(f"no artifact in {path} carries the condition {condition!r}")
    return refs


def preimage_path(folder: Path, ref: rest.ArtifactRef) -> Path:
    """One file per artifact, named by type and the last path segment of its IRI."""
    tail = ref.artifact_id.rstrip("/").rsplit("/", 1)[-1]
    safe = "".join(character if character.isalnum() or character in "-_." else "_" for character in tail)
    return folder / ref.artifact_type / f"{safe or 'artifact'}.json"


def save_preimage(folder: Path, ref: rest.ArtifactRef, artifact: Any, etag: Optional[str]) -> Path:
    path = preimage_path(folder, ref)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"artifactType": ref.artifact_type, "artifactId": ref.artifact_id,
                "etag": etag, "capturedAt": audit.utc_now(), "artifact": artifact}
    rest.atomic_write_json(path, document)
    return path


@dataclass
class Progress:
    total: int
    started: float = field(default_factory=time.monotonic)
    last_report: float = field(default_factory=time.monotonic)
    done: int = 0
    outcomes: collections.Counter = field(default_factory=collections.Counter)
    paths_removed: int = 0

    def note(self, outcome: str, removed: int = 0) -> None:
        self.done += 1
        self.outcomes[outcome] += 1
        if outcome in {"repaired", "would-repair"}:
            self.paths_removed += removed

    def due(self, every: int, seconds: float) -> bool:
        return self.done % every == 0 or time.monotonic() - self.last_report >= seconds

    def report(self, final: bool = False, applied: bool = True) -> None:
        self.last_report = time.monotonic()
        elapsed = time.monotonic() - self.started
        timing = f"elapsed={rest.format_duration(elapsed)}"
        if not final and self.done and self.done < self.total:
            timing += f", eta={rest.format_duration((self.total - self.done) * elapsed / self.done)}"
        counts = " ".join(f"{name}={self.outcomes[name]}" for name in OUTCOMES if self.outcomes[name])
        print(f"[{'final' if final else 'progress'} {self.done}/{self.total} "
              f"{rest.completion_percent(self.done, self.total):.1f}%] {counts or 'none'}; "
              f"paths {'cleared' if applied else 'to clear'}={self.paths_removed}; {timing}", flush=True)


# --------------------------------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------------------------------


def validate(bridge: audit.ValidationBridge, resolver: audit.TemplateResolver,
             ref: rest.ArtifactRef, artifact: Any) -> tuple[bool, str]:
    """The library's verdict on the repaired body, as (valid, explanation)."""
    template_id = None
    if ref.artifact_type == "instance":
        template_id = artifact.get("schema:isBasedOn") if isinstance(artifact, dict) else None
        if not rest.is_absolute_iri(template_id):
            return False, "instance names no absolute template IRI"
    answer = bridge.validate(ref.artifact_type, artifact, template_id)
    if answer.get("status") == "template-missing":
        if not resolver.ensure_cached_in_bridge(template_id):
            return False, f"template {template_id} could not be read"
        answer = bridge.validate(ref.artifact_type, artifact, template_id)
    status = answer.get("status")
    if status == "valid":
        return True, ""
    if status == "invalid":
        messages = "; ".join(error.get("message", "") for error in (answer.get("errors") or [])[:3])
        return False, f"{len(answer.get('errors') or [])} error(s): {messages}"
    return False, f"{answer.get('exception') or 'bridge'}: {answer.get('message') or status}"


def repair_one(arguments: argparse.Namespace, repair: Repair, client: RepairClient,
               bridge: audit.ValidationBridge, resolver: audit.TemplateResolver,
               ref: rest.ArtifactRef) -> dict[str, Any]:
    record: dict[str, Any] = {"artifactType": ref.artifact_type, "artifactId": ref.artifact_id,
                              "artifactName": ref.name, "repair": repair.name, "at": audit.utc_now()}
    path = rest.typed_artifact_path(ref)
    try:
        stored, etag = client.get_with_etag(path)
    except rest.AuthenticationError:
        raise
    except Exception as error:  # noqa: BLE001 - one unreadable artifact must not end the run
        record.update(outcome="fetch-failed", detail=str(error))
        return record
    record["etag"] = etag

    repaired, removed = repair.transform(stored)
    record["pathsRemoved"] = removed
    if not removed:
        record.update(outcome="already-clean")
        return record

    difference = repair.invariant(stored, repaired)
    if difference is not None:
        record.update(outcome="invariant-failed", detail=f"unexpected difference at {difference}")
        return record

    valid, explanation = validate(bridge, resolver, ref, repaired)
    if not valid:
        record.update(outcome="still-invalid", detail=explanation)
        return record

    if not arguments.apply:
        record.update(outcome="would-repair")
        return record

    record["preimage"] = str(save_preimage(Path(arguments.preimages), ref, stored, etag))
    try:
        status, new_etag = client.put_verbatim(path, repaired, etag)
    except Exception as error:  # noqa: BLE001 - a refused write is reported, not fatal
        record.update(outcome="write-failed", detail=str(error))
        return record
    record.update(outcome="repaired", status=status, newEtag=new_etag)

    if arguments.verify:
        try:
            back, _ = client.get_with_etag(path)
            still = repair.transform(back)[1]
            record["verified"] = not still
            if still:
                record["detail"] = f"{len(still)} path(s) still present after the write"
        except Exception as error:  # noqa: BLE001
            record["verified"] = False
            record["detail"] = f"read-back failed: {error}"
    return record


def already_done(path: Path, parser: argparse.ArgumentParser) -> set[tuple[str, str]]:
    done: set[tuple[str, str]] = set()
    if not path.exists():
        return done
    try:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                record = json.loads(line)
                if record.get("outcome") in {"repaired", "already-clean"}:
                    done.add((record["artifactType"], record["artifactId"]))
    except (OSError, ValueError) as error:
        parser.error(f"cannot read --out for --resume: {error}")
    return done


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Repair one narrowly defined defect across stored CEDAR artifacts, verbatim.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Dry run by default. --apply writes, saving every artifact's stored body first.",
    )
    parser.add_argument("--repair", default="empty-derived-from", choices=sorted(REPAIRS),
                        help="the repair to perform (default: empty-derived-from)")
    parser.add_argument("--from-records", required=True,
                        help="records JSONL from cedar_artifact_validation_audit.py, the target list")
    parser.add_argument("--server", default=rest.DEFAULT_SERVER,
                        help=f"resource server origin (default: {rest.DEFAULT_SERVER})")
    parser.add_argument("--api-key-file", help="read the API key from this one-line file")
    parser.add_argument("--apply", action="store_true", help="write; otherwise report what would change")
    parser.add_argument("--limit", type=int, help="stop after this many artifacts")
    parser.add_argument("--types", help="restrict to these artifact types, comma separated")
    parser.add_argument("--out", default="cedar-artifact-repair.jsonl",
                        help="one record per artifact (default: cedar-artifact-repair.jsonl)")
    parser.add_argument("--summary", help="summary JSON path (default: <out without suffix>-summary.json)")
    parser.add_argument("--preimages", help="directory for stored bodies (default: <out without suffix>-preimages)")
    parser.add_argument("--java-log", help="the JVM's stderr (default: <out without suffix>-java.log)")
    parser.add_argument("--resume", action="store_true", help="skip artifacts already repaired or clean in --out")
    parser.add_argument("--no-verify", dest="verify", action="store_false",
                        help="do not read each artifact back after writing it")
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY,
                        help=f"report every N artifacts (default: {DEFAULT_PROGRESS_EVERY})")
    parser.add_argument("--progress-seconds", type=float, default=DEFAULT_PROGRESS_SECONDS,
                        help=f"also report every N seconds (default: {DEFAULT_PROGRESS_SECONDS})")
    parser.add_argument("--delay-ms", type=int, default=0, help="polite delay before every request")
    parser.add_argument("--timeout", type=float, default=90, help="per-request timeout (default: 90)")
    parser.add_argument("--retries", type=int, default=5, help="attempts for transient GET failures")
    parser.add_argument("--java", help="java binary (default: what cedar_validate.sh java resolves)")
    parser.add_argument("--classpath", help="validation classpath (default: cedar_validate.sh classpath)")
    parser.add_argument("--jvm-heap", default="2g", help="JVM maximum heap (default: 2g)")
    parser.add_argument("--ca-file", help="additional CA bundle")
    parser.add_argument("--allow-http", action="store_true", help="allow plain HTTP, for a local test server")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    repair = REPAIRS[arguments.repair]
    if arguments.limit is not None and arguments.limit <= 0:
        parser.error("--limit must be positive")
    api_key = rest.resolve_api_key(arguments, parser)

    records_path = Path(arguments.out).expanduser()
    stem = records_path.stem
    summary_path = Path(arguments.summary).expanduser() if arguments.summary \
        else records_path.with_name(stem + "-summary.json")
    preimages = Path(arguments.preimages).expanduser() if arguments.preimages \
        else records_path.with_name(stem + "-preimages")
    java_log = Path(arguments.java_log).expanduser() if arguments.java_log \
        else records_path.with_name(stem + "-java.log")
    arguments.preimages = str(preimages)
    arguments.server = arguments.server.rstrip("/")
    records_path.parent.mkdir(parents=True, exist_ok=True)

    refs = targets_from_records(Path(arguments.from_records).expanduser(), repair.condition, parser)
    if arguments.types:
        wanted = {kind.strip() for kind in arguments.types.split(",") if kind.strip()}
        unknown = wanted - set(rest.ARTIFACT_PATHS)
        if unknown:
            parser.error(f"unknown artifact types {sorted(unknown)}")
        refs = [ref for ref in refs if ref.artifact_type in wanted]
    done = already_done(records_path, parser) if arguments.resume else set()
    pending = [ref for ref in refs if (ref.artifact_type, ref.artifact_id) not in done]
    if arguments.limit is not None:
        pending = pending[:arguments.limit]
    by_type = collections.Counter(ref.artifact_type for ref in pending)

    print(f"Repair: {repair.name} ({repair.summary})")
    print(f"Server: {arguments.server}")
    print(f"Targets: {len(pending)} artifacts ({audit.counts_text(by_type)}) "
          f"from {arguments.from_records}" + (f", {len(done)} already done" if done else ""))
    print(f"Mode: {'APPLY, writing with PUT ?verbatim=true' if arguments.apply else 'dry run, no writes'}")
    print(f"Records: {records_path}; summary: {summary_path}")
    if arguments.apply:
        print(f"Pre-images: {preimages}")
    if not pending:
        print("nothing to do")
        return 0

    java, classpath = audit.resolve_toolchain(arguments, parser)
    try:
        client = RepairClient(arguments.server, api_key, timeout=arguments.timeout, retries=arguments.retries,
                              delay_ms=arguments.delay_ms, ca_file=arguments.ca_file,
                              allow_http=arguments.allow_http)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    bridge = audit.ValidationBridge(java, classpath, audit.BRIDGE_SOURCE, 200, arguments.jvm_heap,
                                    java_log, 120)
    try:
        hello = bridge.start()
    except (audit.BridgeError, TimeoutError, OSError) as error:
        parser.error(f"cannot start the validation bridge: {error} (see {java_log})")
    print(f"Validator: {hello.get('validator')} on Java {hello.get('java')}", flush=True)

    resolver = audit.TemplateResolver(client, bridge, 200)
    progress = Progress(total=len(pending))
    status = "COMPLETE"
    details: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    try:
        with rest.open_private_text_file(records_path, append=arguments.resume) as stream:
            for ref in pending:
                record = repair_one(arguments, repair, client, bridge, resolver, ref)
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                stream.flush()
                progress.note(record["outcome"], len(record.get("pathsRemoved") or []))
                if record["outcome"] == "repaired" and record.get("verified") is False:
                    details["unverified"].append({"artifactId": ref.artifact_id,
                                                  "artifactType": ref.artifact_type,
                                                  "detail": record.get("detail", "")})
                if record["outcome"] in {"still-invalid", "invariant-failed", "fetch-failed", "write-failed"}:
                    details[record["outcome"]].append(
                        {"artifactId": ref.artifact_id, "artifactType": ref.artifact_type,
                         "detail": record.get("detail", "")})
                    print(f"! {record['outcome']} {ref.artifact_type} {ref.artifact_id}: "
                          f"{record.get('detail', '')[:200]}", file=sys.stderr)
                if progress.due(arguments.progress_every, arguments.progress_seconds):
                    progress.report(applied=arguments.apply)
    except KeyboardInterrupt:
        status = "INTERRUPTED"
    except rest.AuthenticationError as error:
        status = "AUTHENTICATION_ERROR"
        print(f"! {error}", file=sys.stderr)
    except audit.BridgeError as error:
        status = "BRIDGE_FAILURE"
        print(f"! {error}", file=sys.stderr)
    finally:
        bridge.close()
        progress.report(final=True, applied=arguments.apply)

    summary = {
        "tool": {"script": Path(__file__).name, "scriptSha256": audit.file_sha256(Path(__file__)),
                 "repair": repair.name, "condition": repair.condition, "summary": repair.summary},
        "status": status,
        "mode": "apply" if arguments.apply else "dry-run",
        "server": arguments.server,
        "finishedAt": audit.utc_now(),
        "elapsedSeconds": round(time.monotonic() - progress.started, 3),
        "targets": len(pending),
        "targetsByType": dict(sorted(by_type.items())),
        "outcomes": {name: progress.outcomes[name] for name in OUTCOMES if progress.outcomes[name]},
        "pathsCleared": progress.paths_removed,
        "repairedButUnverified": len(details.get("unverified", [])),
        "problems": {name: values[:200] for name, values in details.items()},
        "files": {"records": str(records_path), "preimages": str(preimages) if arguments.apply else None},
    }
    rest.atomic_write_json(summary_path, summary)

    print("\n=== Summary ===")
    print(f"status: {status}; mode: {'apply' if arguments.apply else 'dry run'}")
    for name in OUTCOMES:
        if progress.outcomes[name]:
            print(f"  {name:<16} {progress.outcomes[name]}")
    print(f"paths {'cleared' if arguments.apply else 'to clear'}: {progress.paths_removed}")
    print(f"records: {records_path}")
    print(f"summary: {summary_path}")
    if arguments.apply:
        print(f"pre-images: {preimages}")
    else:
        print("no writes were issued; re-run with --apply to repair")
    if details.get("unverified"):
        print(f"  repaired but read-back could not confirm: {len(details['unverified'])}")
    failed = sum(progress.outcomes[name] for name in ("write-failed", "invariant-failed", "fetch-failed")) \
        + len(details.get("unverified", []))
    if status != "COMPLETE":
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
