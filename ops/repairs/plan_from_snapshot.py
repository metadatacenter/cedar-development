#!/usr/bin/env python3
"""Plan a chain of instance repairs against a snapshot, and say which instances it would finish.

A repair run against a deployment reads every target before it can say what it would do, and says it
one artifact at a time. This planner runs the same transforms, with the same invariants, over the
bodies and templates in a snapshot made by ``ops/cedar_snapshot.py``. Each candidate is validated
with ``cedar-model-validation-library`` against its template, and read with ``cedar-artifact-library``
and with ``cedar-model-typescript-library``, strict and FEBRUARY_2024, so an instance counts as
finished only when all of them accept it. Every candidate must also carry exactly the provenance its
stored body carries, its modification date above all.

Nothing contacts a deployment. ``finished-ids.json`` is the ``--only-ids`` list for the repair tool's
``--apply`` run, which reads each instance afresh and repeats every check before it writes;
``targets.jsonl`` is its ``--from-records`` file, selected with ``--condition snapshot-plan``.

    python3 ops/repairs/plan_from_snapshot.py --ids ids.json \\
      --repair write-date-as-iso,stamp-instance-value-type \\
      --java-classpath <cedar-artifact-library jar with dependencies> \\
      --ts-library <cedar-model-typescript-library>/dist/index.js --out plan/
"""

from __future__ import annotations

import argparse
import collections
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import cedar_artifact_repair as repair  # noqa: E402
from cedar_snapshot import Snapshot  # noqa: E402

PROVENANCE = ("@id", "schema:isBasedOn", "pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy")
CONDITION = "snapshot-plan"


class LineBridge:
    """A bridge asked one question at a time: a JSON header line, the body's bytes, one answer line."""

    def __init__(self, command: list[str]):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        self.sequence = 0

    def ask(self, header: dict[str, Any], body: bytes) -> dict[str, Any]:
        self.sequence += 1
        self.process.stdin.write(json.dumps(dict(header, seq=self.sequence, length=len(body))).encode() + b"\n" + body)
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def close(self) -> None:
        self.process.stdin.close()
        self.process.wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--snapshot", help="the archive (default: the latest production snapshot)")
    parser.add_argument("--ids", required=True, help="JSON list of the instance IRIs to plan for")
    parser.add_argument("--repair", required=True, help="the chain, comma separated, in the order it runs")
    parser.add_argument("--date-orders", help="the --date-orders table write-date-as-iso reads")
    parser.add_argument("--terms", help="the --terms table settle-instance-term-label reads")
    parser.add_argument("--java-classpath", required=True)
    parser.add_argument("--ts-library", required=True)
    parser.add_argument("--out", required=True, help="output directory")
    arguments = parser.parse_args(argv)

    for supplied, into in ((arguments.date_orders, repair.DATE_ORDERS), (arguments.terms, repair.TERMS)):
        if supplied:
            into.update(json.loads(Path(supplied).read_text()))
    chain = [repair.REPAIRS[name] for name in arguments.repair.split(",")]
    wanted = set(json.loads(Path(arguments.ids).read_text()))
    out = Path(arguments.out)
    out.mkdir(parents=True, exist_ok=True)

    snapshot = Snapshot(arguments.snapshot) if arguments.snapshot else Snapshot.latest()
    templates: dict[str, bytes] = {}
    bodies: dict[str, bytes] = {}
    for entry, body in snapshot.artifacts(types={"template", "instance"}):
        if entry["type"] == "template":
            templates[entry["id"]] = body
        elif entry["id"] in wanted:
            bodies[entry["id"]] = body

    java = LineBridge(["java", "-Xmx3g", "-cp", arguments.java_classpath,
                       str(HERE.parent / "cedar_snapshot_read_bridge.java"), "--template-cache", "4"])
    ts = LineBridge(["node", str(HERE.parent / "cedar_snapshot_read_bridge.cjs"), arguments.ts_library])
    outcomes: collections.Counter = collections.Counter()
    by_repair: collections.Counter = collections.Counter()
    remaining: collections.Counter = collections.Counter()
    finished: list[str] = []
    with (out / "plan.jsonl").open("w") as plan, (out / "targets.jsonl").open("w") as targets:
        for identifier in sorted(wanted):
            row: dict[str, Any] = {"id": identifier}
            if identifier not in bodies:
                row["outcome"] = "not-in-snapshot"
            else:
                stored = json.loads(bodies[identifier])
                template_id = stored.get("schema:isBasedOn")
                row["template"] = template_id
                try:
                    candidate, changes = repair.apply_repairs(chain, stored, json.loads(templates[template_id]))
                except (repair.TransformRefused, repair.InvariantFailed, KeyError) as refusal:
                    row.update(outcome="refused", detail=str(refusal))
                    candidate, changes = None, []
                if candidate is not None and not changes:
                    row["outcome"] = "no-change"
                elif candidate is not None:
                    row["changes"] = len(changes)
                    by_change = collections.Counter(change["repair"] for change in changes)
                    row["byRepair"] = dict(by_change)
                    moved = [key for key in PROVENANCE if candidate.get(key) != stored.get(key)]
                    text = json.dumps(candidate, ensure_ascii=False).encode()
                    java.ask({"op": "template", "id": template_id}, templates[template_id])
                    verdict = java.ask({"op": "read", "kind": "instance", "templateId": template_id}, text)
                    reading = ts.ask({"op": "read", "kind": "instance"}, text)["reader"]
                    lenient = reading.get("lenient", reading)
                    row["validation"] = verdict["validation"]["status"]
                    row["readers"] = {"java": verdict["reader"]["status"], "ts": reading["status"],
                                      "tsLenient": lenient["status"]}
                    if moved:
                        row.update(outcome="provenance-moved", moved=moved)
                    elif row["validation"] != "valid":
                        row["outcome"] = "still-invalid"
                        for error in verdict["validation"].get("errors", [])[:1]:
                            remaining[str(error.get("message"))[:60]] += 1
                    elif set(row["readers"].values()) != {"read"}:
                        row["outcome"] = "unreadable"
                    else:
                        row["outcome"] = "would-finish"
                        finished.append(identifier)
                        by_repair.update(by_change.keys())
                        targets.write(json.dumps({"artifactType": "instance", "artifactId": identifier,
                                                  "conditionRules": {CONDITION: 1}}) + "\n")
            outcomes[row["outcome"]] += 1
            plan.write(json.dumps(row) + "\n")
    java.close()
    ts.close()
    (out / "finished-ids.json").write_text(json.dumps(finished, indent=1) + "\n")
    summary = {"snapshot": str(snapshot.path), "repair": arguments.repair, "targets": len(wanted),
               "outcomes": dict(outcomes), "finishedUsing": dict(by_repair),
               "stillInvalidFirstError": dict(remaining.most_common(20))}
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
