"""Round-trip every stored schema artifact through YAML and back, in all four library pairings.

The conversion audit starts from the YAML a deployment serves and ends at JSON Schema. That leaves
both libraries' YAML *writers* untested: the source document is the deployment's own rendering, so
a writer defect the readers both accept is invisible, and the TypeScript writer is never exercised
at all. Every YAML defect found in the instance work — an element that rendered no children read
back as a field, a field that gained a null value, a list that lost its blank occurrences — sits in
exactly that blind spot.

Starting from the document the deployment *stores* closes it, and gives an absolute reference
rather than only agreement between lanes:

    stored JSON ─┬─ Java YAML ─┬─ Java JSON
                 │             └─ TS JSON
                 └─ TS YAML   ─┬─ Java JSON
                               └─ TS JSON

Four JSON results, each compared against the stored document, so a defect is attributed to the
writer, the reader, or the pairing. The two YAML renderings are compared to each other as well,
which is the narrower question of whether the writers agree.

Fetching is read-only: the HTTP client supports GET and nothing is written back.

    python3 ops/cedar_stored_json_matrix_audit.py \\
      --classpath "$(cat classpath.txt)" \\
      --library "$CEDAR_HOME/cedar-model-typescript-library/dist/index.js" \\
      --records stored-json-matrix.jsonl

Requires JDK 17 with cedar-artifact-library built, and Node with the TypeScript library's dist
built (``npm run build``).
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import pathlib
import subprocess
import sys
import time
from typing import Any, Iterator, Optional

OPS = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("cedar_artifact_rest_audit",
                                               OPS / "cedar_artifact_rest_audit.py")
rest = importlib.util.module_from_spec(_spec)
sys.modules["cedar_artifact_rest_audit"] = rest
_spec.loader.exec_module(rest)

JAVA, TYPESCRIPT = "java", "typescript"
LANES = (JAVA, TYPESCRIPT)
SCHEMA_TYPES = ("template", "element", "field")
DEFAULT_PAGE_SIZE = 500
DEFAULT_FETCH_WORKERS = 12

# Arrays whose order a JSON Schema does not fix. `required` is a set by definition, and so is the
# `required` a CEDAR @context carries. Reordering one changes no meaning, and both libraries build
# them from unordered maps, so treating them as ordered would bury every real difference under
# hundreds of positional ones. Every other array is compared in order, `_ui.order` above all,
# since that one *is* the meaning.
UNORDERED_ARRAYS = ("required",)


class Bridge:
    """One library, kept warm."""

    def __init__(self, name: str, command: list[str]) -> None:
        self.name = name
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                                        bufsize=1)
        hello = self.ask({"op": "hello"})
        if hello.get("status") != "ok":
            raise SystemExit(f"the {name} bridge did not start: {hello}")

    def ask(self, request: dict[str, Any]) -> dict[str, Any]:
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise SystemExit(f"the {self.name} bridge stopped answering")
        return json.loads(line)

    def close(self) -> None:
        try:
            self.ask({"op": "shutdown"})
        except Exception:
            pass
        self.process.terminate()


def unordered(path: str) -> bool:
    return path.rsplit("/", 1)[-1] in UNORDERED_ARRAYS


def differences(before: Any, after: Any, path: str = "") -> Iterator[str]:
    """Where two documents differ, with the arrays above compared as sets."""
    if isinstance(before, dict) and isinstance(after, dict):
        for key in before:
            here = f"{path}/{key}"
            if key not in after:
                yield f"dropped {here}"
            else:
                yield from differences(before[key], after[key], here)
        for key in after:
            if key not in before:
                yield f"added {path}/{key}"
    elif isinstance(before, list) and isinstance(after, list):
        if unordered(path):
            missing = [item for item in before if item not in after]
            extra = [item for item in after if item not in before]
            for item in missing[:8]:
                yield f"dropped {path}/{item}"
            for item in extra[:8]:
                yield f"added {path}/{item}"
        elif len(before) != len(after):
            yield f"length {path} {len(before)}->{len(after)}"
        else:
            for index, (was, now) in enumerate(zip(before, after)):
                yield from differences(was, now, f"{path}[{index}]")
    elif before != after:
        yield f"value {path}"


def one_artifact(bridges: dict[str, Bridge], kind: str, stored: Any,
                 compact: bool, max_differences: int) -> dict[str, Any]:
    """The whole matrix for one artifact."""
    record: dict[str, Any] = {"artifactType": kind}
    rendered: dict[str, Optional[str]] = {}
    for lane in LANES:
        answer = bridges[lane].ask({"op": "render", "kind": kind, "json": stored,
                                    "compact": compact})
        if answer.get("status") != "ok":
            record[f"render:{lane}"] = {"stage": answer.get("stage"),
                                        "message": str(answer.get("message", ""))[:300]}
            rendered[lane] = None
        else:
            rendered[lane] = answer["yaml"]
    if rendered[JAVA] is not None and rendered[TYPESCRIPT] is not None:
        record["yamlIdentical"] = rendered[JAVA] == rendered[TYPESCRIPT]

    pairings: dict[str, Any] = {}
    for writer in LANES:
        document = rendered[writer]
        if document is None:
            continue
        for reader in LANES:
            name = f"{writer}->{reader}"
            answer = bridges[reader].ask({"op": "convert", "kind": kind, "yaml": document,
                                          "compact": compact})
            if answer.get("status") != "ok":
                pairings[name] = {"outcome": f"convert-{answer.get('stage', 'error')}",
                                  "message": str(answer.get("message", ""))[:300]}
                continue
            found = list(differences(stored, answer["json"]))
            pairings[name] = {"outcome": "identical" if not found else "differs",
                              "differenceCount": len(found),
                              "differences": found[:max_differences]}
    record["pairings"] = pairings
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default="https://resource.metadatacenter.org")
    parser.add_argument("--key-file", default=str(pathlib.Path.home() / ".cedar-admin-key"))
    parser.add_argument("--classpath", required=True, help="the Java artifact library and its dependencies")
    parser.add_argument("--library", required=True, help="the TypeScript library's built dist entry point")
    parser.add_argument("--records", required=True, type=pathlib.Path)
    parser.add_argument("--java", default="java")
    parser.add_argument("--node", default="node")
    parser.add_argument("--types", default=",".join(SCHEMA_TYPES))
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    parser.add_argument("--fetch-workers", type=int, default=DEFAULT_FETCH_WORKERS)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--compact", action="store_true", help="render the compact YAML form")
    parser.add_argument("--max-differences", type=int, default=25,
                        help="differences recorded per pairing (default: 25)")
    parser.add_argument("--progress-every", type=int, default=500)
    parser.add_argument("--resume", action="store_true")
    arguments = parser.parse_args()

    kinds = [k.strip() for k in arguments.types.split(",") if k.strip()]
    unknown = [k for k in kinds if k not in SCHEMA_TYPES]
    if unknown:
        parser.error(f"unknown artifact types {unknown}; choose from {list(SCHEMA_TYPES)}")

    client = rest.GetOnlyClient(arguments.server,
                                pathlib.Path(arguments.key_file).read_text().strip(),
                                timeout=arguments.timeout, retries=3)

    refs: list[Any] = []
    for kind in kinds:
        page, offset, seen = None, 0, set()
        while arguments.limit is None or len(refs) < arguments.limit:
            data = rest.search_deep_page(client, kind, arguments.page_size,
                                         None if page else offset, page)
            rows = data["resources"]
            if not rows:
                break
            for row in rows:
                identifier = row.get("@id")
                if identifier and identifier not in seen:
                    seen.add(identifier)
                    refs.append(rest.ArtifactRef(kind, identifier, row.get("schema:name", "")))
            page, offset = data.get("continuation"), offset + len(rows)
            if not page and offset >= data["totalCount"]:
                break
    if arguments.limit is not None:
        refs = refs[:arguments.limit]
    print(f"enumerated {len(refs)} schema artifacts ({', '.join(kinds)})", flush=True)

    done: set[str] = set()
    if arguments.resume and arguments.records.exists():
        with arguments.records.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    done.add(json.loads(line)["artifactId"])
                except Exception:
                    continue
        print(f"{len(done)} already recorded", flush=True)
    pending = [ref for ref in refs if ref.artifact_id not in done]

    bridges = {
        JAVA: Bridge(JAVA, [arguments.java, "-cp", arguments.classpath,
                            str(OPS / "cedar_yaml_convert_bridge.java")]),
        TYPESCRIPT: Bridge(TYPESCRIPT, [arguments.node,
                                        str(OPS / "cedar_yaml_convert_bridge.cjs"),
                                        "--lib", arguments.library]),
    }
    tally = collections.Counter()
    reasons: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    started = time.time()

    def fetch(cl, ref):
        try:
            return cl.get_json(rest.typed_artifact_path(ref)), None
        except Exception as error:
            return None, error

    try:
        with arguments.records.open("a" if arguments.resume else "w", encoding="utf-8") as out:
            for index, (ref, stored, error) in enumerate(
                    rest.fetch_in_order(client, pending, arguments.fetch_workers, fetch=fetch), 1):
                if error or stored is None:
                    out.write(json.dumps({"artifactId": ref.artifact_id,
                                          "artifactType": ref.artifact_type,
                                          "unread": str(error)[:300]}) + "\n")
                    tally["unread"] += 1
                    continue
                record = one_artifact(bridges, ref.artifact_type, stored,
                                      arguments.compact, arguments.max_differences)
                record["artifactId"] = ref.artifact_id
                record["artifactName"] = ref.name
                for name, result in record["pairings"].items():
                    tally[f"{name}: {result['outcome']}"] += 1
                    for difference in result.get("differences", []):
                        reasons[name][difference.split("[")[0][:80]] += 1
                if "yamlIdentical" in record:
                    tally[f"yaml writers agree: {record['yamlIdentical']}"] += 1
                for lane in LANES:
                    if f"render:{lane}" in record:
                        tally[f"render failed: {lane}"] += 1
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                out.flush()
                if index % arguments.progress_every == 0:
                    rate = index / max(1e-9, time.time() - started)
                    print(f"  {index}/{len(pending)}  {rate:.0f}/s  "
                          f"~{(len(pending) - index) / max(1e-9, rate) / 60:.0f} min left",
                          flush=True)
    finally:
        for bridge in bridges.values():
            bridge.close()

    elapsed = time.time() - started
    summary = {"record": "stored-json-matrix-summary", "server": arguments.server,
               "artifacts": len(refs), "processed": len(pending),
               "elapsedSeconds": round(elapsed, 1), "compact": arguments.compact,
               "unorderedArrays": list(UNORDERED_ARRAYS),
               "tally": dict(tally),
               "differencesByPairing": {name: dict(counter.most_common(20))
                                        for name, counter in reasons.items()}}
    summary_path = arguments.records.with_name(arguments.records.stem + "-summary.json")
    rest.atomic_write_json(summary_path, summary)

    print(f"\nprocessed {len(pending)} artifacts in {elapsed / 60:.1f} min")
    for name, count in tally.most_common():
        print(f"   {count:7d}  {name}")
    for name, counter in reasons.items():
        if not counter:
            continue
        print(f"\n{name} differs at:")
        for difference, count in counter.most_common(10):
            print(f"   {count:7d}  {difference}")
    print(f"\nrecords : {arguments.records}")
    print(f"summary : {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
