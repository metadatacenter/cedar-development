#!/usr/bin/env python3
"""Read every artifact in a snapshot with the Java and TypeScript libraries, and validate each one.

A deployment's data outlives the code that wrote it, so a reader change can leave stored artifacts
that nothing opens any more. This audit asks both libraries to read every template, element, field
and instance in a snapshot made by ``ops/cedar_snapshot.py``, and asks the validation library to
judge each one, instances against the template they are based on. A refusal of an artifact the
validator also rejects is the data's defect, already counted by the validation audits. A refusal of
an artifact the validator accepts is a reader defect, and is what this audit exists to find.

Nothing contacts a deployment. The snapshot is streamed through long-lived bridges, several of each
kind, so a whole production snapshot takes minutes:

    python3 ops/cedar_snapshot_read_audit.py \\
      --java-classpath <cedar-artifact-library>/target/cedar-artifact-library-<v>-jar-with-dependencies.jar \\
      --ts-library <cedar-model-typescript-library>/dist/index.js \\
      --out "$CEDAR_HOME/.cedar/audits/<date>-snapshot-read"

The two libraries must also agree on every instance's verdict. The Java validator decides what the
server stores; the TypeScript library's InstanceValidator and ValidationPolicy decide whether the
embeddable editor lets an owner save. The summary's ``validationParity`` counts the instances on
which they disagree, in both directions, with their causes, and ``--fail-on-disagreement`` makes any
disagreement fail the run, which is the gate over production data.

The output directory receives ``records.jsonl``, one verdict per artifact, and ``summary.json``,
which counts outcomes by artifact type and groups refusals by cause. Refusal messages can quote
stored values, so both files are written with owner-only permissions, and the summary's causes have
quoted text and numbers masked. ``--known`` names earlier lists of invalid artifacts, as JSONL with
``artifactType`` and ``artifactId``, and the summary says how many refusals each list already held.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

OPS = Path(__file__).resolve().parent
sys.path.insert(0, str(OPS))
from cedar_snapshot import Snapshot  # noqa: E402

JAVA_BRIDGE = OPS / "cedar_snapshot_read_bridge.java"
TS_BRIDGE = OPS / "cedar_snapshot_read_bridge.cjs"
DEFAULT_JAVA_BRIDGES = 4
DEFAULT_TS_BRIDGES = 4
# Each bridge keeps twice as many templates as this side assumes it keeps; the TypeScript bridge's
# TEMPLATE_CACHE is the same number. Least-recently-used caches fed the same references nest, so
# every template this side believes is cached really is.
TEMPLATE_MIRROR = 128
JAVA_TEMPLATE_CACHE = 2 * TEMPLATE_MIRROR
WINDOW = 64
PROGRESS_EVERY = 25000


class Bridge:
    """One bridge process, with a bounded number of requests in flight."""

    def __init__(self, name: str, command: list[str], log: Path, answers: queue.Queue):
        self.name = name
        self.log = log.open("ab")
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log)
        self.window = threading.Semaphore(WINDOW)
        self.pending: dict[int, Any] = {}
        self.sequence = 0
        self.answers = answers
        self.templates: collections.OrderedDict[str, None] = collections.OrderedDict()
        self.thread = threading.Thread(target=self._collect, name=f"{name}-answers", daemon=True)
        self.thread.start()

    def _collect(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            answer = json.loads(line)
            context = self.pending.pop(answer["seq"])
            self.window.release()
            self.answers.put((self.name, context, answer))
        self.answers.put((self.name, None, {"bridgeEnded": self.process.wait(), "unanswered": len(self.pending)}))

    def send(self, header: dict[str, Any], body: bytes, context: Any) -> None:
        self.window.acquire()
        self.sequence += 1
        header = dict(header, seq=self.sequence, length=len(body))
        self.pending[self.sequence] = context
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(header).encode() + b"\n" + body)
        self.process.stdin.flush()

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        self.thread.join()
        self.log.close()


QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"|“[^”]*”|https?://\S+|\b[0-9a-f]{8}-[0-9a-f-]{27}\b|\d+(\.\d+)?")


def cause(message: Optional[str]) -> str:
    """A refusal message with what it quotes from the artifact masked, so causes can be counted."""
    return QUOTED.sub("…", message or "")[:200]


def reader_cause(verdict: dict[str, Any]) -> str:
    if verdict.get("status") == "refused" and verdict.get("errors"):
        first = verdict["errors"][0]
        return f"{first.get('type')} at {cause(first.get('location'))}"
    exception = (verdict.get("exception") or "").rsplit(".", 1)[-1]
    return f"{exception}: {cause(verdict.get('message'))}".strip(": ")


def load_known(paths: list[str]) -> dict[str, set[tuple[str, str]]]:
    known = {}
    for path in paths:
        members = set()
        for line in Path(path).read_text().splitlines():
            if line.strip():
                record = json.loads(line)
                members.add((record["artifactType"], record["artifactId"]))
        known[Path(path).name] = members
    return known


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--snapshot", help="the archive (default: the latest production snapshot)")
    parser.add_argument("--java-classpath", required=True, help="classpath holding cedar-artifact-library")
    parser.add_argument("--ts-library", required=True, help="cedar-model-typescript-library dist/index.js")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--java-identity", default="", help="what the Java classpath was built from")
    parser.add_argument("--ts-identity", default="", help="what the TypeScript library was built from")
    parser.add_argument("--java-bridges", type=int, default=DEFAULT_JAVA_BRIDGES)
    parser.add_argument("--ts-bridges", type=int, default=DEFAULT_TS_BRIDGES)
    parser.add_argument("--jvm-heap", default="3g")
    parser.add_argument("--known", action="append", default=[], help="JSONL of artifacts known to be invalid")
    parser.add_argument("--limit", type=int, help="stop after this many artifacts, for a trial")
    parser.add_argument("--fail-on-disagreement", action="store_true",
                        help="exit non-zero when the libraries disagree on any instance's verdict")
    arguments = parser.parse_args(argv)

    os.umask(0o077)
    out = Path(arguments.out)
    out.mkdir(parents=True, exist_ok=True)
    snapshot = Snapshot(arguments.snapshot) if arguments.snapshot else Snapshot.latest()
    manifest, _index = snapshot.header()
    known = load_known(arguments.known)

    answers: queue.Queue = queue.Queue()
    java = [Bridge(f"java{n}", ["java", f"-Xmx{arguments.jvm_heap}", "-cp", arguments.java_classpath,
                                str(JAVA_BRIDGE), "--template-cache", str(JAVA_TEMPLATE_CACHE)],
                   out / f"java{n}.log", answers) for n in range(arguments.java_bridges)]
    ts = [Bridge(f"ts{n}", ["node", "--max-old-space-size=6144", str(TS_BRIDGE), arguments.ts_library],
                 out / f"ts{n}.log", answers) for n in range(arguments.ts_bridges)]

    records_path = out / "records.jsonl"
    partial: dict[tuple[str, str], dict[str, Any]] = {}
    counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    causes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    refused_known: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    invalid_known: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    invalid_causes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    parity: collections.Counter = collections.Counter()
    parity_causes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    disagreements: list[dict[str, Any]] = []
    unexpected: list[dict[str, Any]] = []
    problems: list[str] = []
    ended = 0
    submitted = 0
    finished = 0
    started = time.monotonic()

    def complete(record: dict[str, Any]) -> None:
        nonlocal finished
        finished += 1
        kind = record["type"]
        validation = record["validation"]["status"]
        java_status = record["java"]["status"]
        ts_status = record["ts"]["status"]
        tally = counts[kind]
        tally["artifacts"] += 1
        if record.get("notUtf8"):
            tally["notUtf8"] += 1
        tally[f"validation:{validation}"] += 1
        tally[f"java:{java_status}"] += 1
        tally[f"ts:{ts_status}"] += 1
        if validation == "invalid":
            for error in record["validation"].get("errors", [])[:1]:
                invalid_causes[kind][cause(error.get("message"))] += 1
            for name, members in known.items():
                if (kind, record["id"]) in members:
                    invalid_known[name][kind] += 1
        if kind == "instance":
            judged = record["ts"].get("validation", {})
            if "canSave" not in judged or validation not in ("valid", "invalid"):
                parity["unjudged"] += 1
            elif (validation == "valid") == judged["canSave"]:
                parity["agree"] += 1
            else:
                direction = "javaValid-tsBlocks" if validation == "valid" else "javaInvalid-tsSaves"
                parity[direction] += 1
                if direction == "javaValid-tsBlocks":
                    first = (judged.get("blocking") or [{}])[0]
                    reason = f"{first.get('code', judged.get('status'))}: {cause(first.get('message'))}"
                else:
                    reason = cause(((record["validation"].get("errors") or [{}])[0]).get("message"))
                parity_causes[direction][reason] += 1
                if len(disagreements) < 500:
                    disagreements.append({"id": record["id"], "template": record.get("template"),
                                          "direction": direction, "cause": reason})
        both_read = java_status == "read" and ts_status == "read"
        tally["bothRead" if both_read else "notBothRead"] += 1
        if ts_status == "read" and record["ts"].get("warningCount"):
            tally["ts:readWithWarnings"] += 1
        if "lenient" in record["ts"]:
            tally[f"ts-lenient:{record['ts']['lenient']['status']}"] += 1
        if not both_read:
            accepted = validation == "valid"
            tally[f"notBothRead:{'validatorAccepts' if accepted else 'validator-' + validation}"] += 1
            verdicts = {"java": record["java"], "ts": record["ts"]}
            if "lenient" in record["ts"]:
                verdicts["ts-lenient"] = record["ts"]["lenient"]
            for lane, verdict in verdicts.items():
                if verdict["status"] != "read":
                    causes[f"{kind} {lane} {'accepted' if accepted else 'rejected'}"][reader_cause(verdict)] += 1
            for name, members in known.items():
                if (kind, record["id"]) in members:
                    refused_known[name][kind] += 1
            if accepted:
                unexpected.append({"type": kind, "id": record["id"], "java": record["java"]["status"],
                                   "ts": record["ts"]["status"],
                                   "tsLenient": record["ts"].get("lenient", {}).get("status")})
        records.write(json.dumps(record, separators=(",", ":")) + "\n")
        if finished % PROGRESS_EVERY == 0:
            elapsed = time.monotonic() - started
            print(f"[read] {finished} artifacts, {finished / elapsed:.0f}/s; "
                  f"not read by both: {sum(c['notBothRead'] for c in counts.values())}, of which the "
                  f"validator accepts {len(unexpected)}", flush=True)

    def consume(block: bool) -> None:
        nonlocal ended
        while True:
            try:
                name, context, answer = answers.get(block=block, timeout=600 if block else None)
            except queue.Empty:
                if block:
                    raise TimeoutError("no bridge answered for 600 s")
                return
            if context is None:
                ended += 1
                if answer.get("unanswered"):
                    problems.append(f"{name} ended with {answer['unanswered']} request(s) unanswered")
                if block:
                    return
                continue
            if context[0] == "cache":
                if answer.get("status") != "kept":
                    problems.append(f"template {context[1]} could not be kept: {answer.get('status')}")
                continue
            key = context
            record = partial[key]
            if name.startswith("java"):
                record["java"] = answer.get("reader", {"status": "no-answer"})
                record["validation"] = answer.get("validation", {"status": "no-answer"})
            else:
                record["ts"] = answer.get("reader", {"status": "no-answer"})
            if "java" in record and "ts" in record:
                complete(partial.pop(key))
            if block:
                return

    templates: dict[str, bytes] = {}
    with records_path.open("w") as records:
        for position, (entry, body) in enumerate(snapshot.artifacts()):
            if arguments.limit is not None and position >= arguments.limit:
                break
            kind = entry["type"]
            key = (kind, entry["id"])
            if kind == "template":
                templates[entry["id"]] = body
            record: dict[str, Any] = {"type": kind, "id": entry["id"]}
            try:
                body.decode("utf-8")
            except UnicodeDecodeError:
                record["notUtf8"] = True
            partial[key] = record
            bridge = java[position % len(java)]
            header: dict[str, Any] = {"op": "read", "kind": kind}
            if kind == "instance":
                template_id = entry.get("template")
                record["template"] = template_id
                if template_id:
                    header["templateId"] = template_id
                    if template_id in bridge.templates:
                        bridge.templates.move_to_end(template_id)
                    elif template_id in templates:
                        bridge.send({"op": "template", "id": template_id}, templates[template_id],
                                    ("cache", template_id))
                        bridge.templates[template_id] = None
                        if len(bridge.templates) > TEMPLATE_MIRROR:
                            bridge.templates.popitem(last=False)
            bridge.send(header, body, key)
            ts_bridge = ts[position % len(ts)]
            ts_header: dict[str, Any] = {"op": "read", "kind": kind}
            template_id = entry.get("template") if kind == "instance" else None
            if template_id and template_id in templates:
                ts_header["templateId"] = template_id
                if template_id in ts_bridge.templates:
                    ts_bridge.templates.move_to_end(template_id)
                else:
                    ts_bridge.send({"op": "template", "id": template_id}, templates[template_id],
                                   ("cache", template_id))
                    ts_bridge.templates[template_id] = None
                    if len(ts_bridge.templates) > TEMPLATE_MIRROR:
                        ts_bridge.templates.popitem(last=False)
            ts_bridge.send(ts_header, body, key)
            submitted += 1
            consume(block=False)
        for bridge in java + ts:
            bridge.process.stdin.close()
        while partial or ended < len(java) + len(ts):
            consume(block=True)
    for bridge in java + ts:
        bridge.close()

    elapsed = time.monotonic() - started
    summary = {
        "snapshot": {"path": str(snapshot.path), "deployment": manifest.get("deployment"),
                     "fetchedAt": manifest.get("fetchedAt"), "counts": manifest.get("counts")},
        "readers": {
            "java": {"classpath": arguments.java_classpath, "identity": arguments.java_identity,
                     "sha256": file_sha256(Path(arguments.java_classpath))
                     if Path(arguments.java_classpath).is_file() else None},
            "typescript": {"library": arguments.ts_library, "identity": arguments.ts_identity,
                           "sha256": file_sha256(Path(arguments.ts_library)), "behavior": "strict"},
        },
        "artifacts": finished,
        "seconds": round(elapsed),
        "byType": {kind: dict(sorted(tally.items())) for kind, tally in counts.items()},
        "causes": {group: dict(counter.most_common(40)) for group, counter in sorted(causes.items())},
        "refusedAlreadyKnown": {name: dict(counter) for name, counter in refused_known.items()},
        "invalidAlreadyKnown": {name: dict(counter) for name, counter in invalid_known.items()},
        "invalidCauses": {kind: dict(counter.most_common(40)) for kind, counter in sorted(invalid_causes.items())},
        "knownLists": {name: len(members) for name, members in known.items()},
        "validatorAcceptsButNotBothRead": unexpected[:500],
        "validationParity": {"counts": dict(parity),
                             "causes": {d: dict(c.most_common(40)) for d, c in sorted(parity_causes.items())},
                             "disagreements": disagreements},
        "problems": problems,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({key: summary[key] for key in ("artifacts", "seconds", "byType", "problems")}, indent=2))
    print(f"[read] {len(unexpected)} artifact(s) the validator accepts were not read by both libraries; "
          f"see {out / 'summary.json'}")
    disagreeing = parity["javaValid-tsBlocks"] + parity["javaInvalid-tsSaves"]
    print(f"[parity] instance verdicts: {dict(parity)}")
    if problems:
        return 1
    return 1 if arguments.fail_on_disagreement and disagreeing else 0


if __name__ == "__main__":
    sys.exit(main())
