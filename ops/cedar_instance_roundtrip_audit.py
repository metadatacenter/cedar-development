"""GET-only walk over every template instance, asking whether it survives its YAML representation.

Three questions per instance. Can this library read the YAML the deployment emits, and does it
write that document back unchanged? Does the instance survive a trip through YAML — JSON to the
model, out as YAML, back to the model, out as JSON again — with nothing lost? And would a YAML
write of it be stored?

The third is the one that matters operationally, and it is not the second. A template-free trip
loses everything the template restores, so it reports as damaged an instance the server would
write back perfectly. The write path runs what the server runs: render the YAML a client would
send, read it back, complete it against its template, mint the element-instance identifiers the
repository mints, and validate. Leaving any step out invents refusals — omitting the minting step
alone made every element the YAML elided look like a null identifier.

The second question is the one that says whether the library is correct today, because the first
answers for whatever jar production happens to be running. They disagree whenever a deployment
lags the library, and the run reports them apart for that reason.

YAML is lossy by design: it carries no JSON-LD context and no field that holds nothing, and the
server completes both against the template when a YAML instance is written. Those differences are
counted and set aside. What remains is content the round trip lost.

One JVM, ops/cedar_instance_roundtrip_bridge.java, stays up for the whole pass. The run streams one
record per instance, checkpoints, and resumes from its own records. It never writes an artifact and
never stores or prints the API key.
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
import urllib.parse
from typing import Any, Iterator, Optional

OPS = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("cedar_artifact_rest_audit",
                                               OPS / "cedar_artifact_rest_audit.py")
rest = importlib.util.module_from_spec(_spec)
sys.modules["cedar_artifact_rest_audit"] = rest
_spec.loader.exec_module(rest)

DEFAULT_PAGE_SIZE = 500
DEFAULT_FETCH_WORKERS = 12
BRIDGE = OPS / "cedar_instance_roundtrip_bridge.java"


class Bridge:
    """The library, kept warm. One JVM start for the whole pass rather than one per instance."""

    def __init__(self, classpath: str) -> None:
        self.process = subprocess.Popen(
            ["java", "-Xmx2g", "-cp", classpath, str(BRIDGE)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1)
        hello = self.ask({"op": "hello"})
        if hello.get("status") != "ok":
            raise SystemExit(f"the bridge did not start: {hello}")
        self.reader = hello.get("reader", "")

    def ask(self, request: dict[str, Any]) -> dict[str, Any]:
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise SystemExit("the bridge stopped answering")
        return json.loads(line)

    def close(self) -> None:
        try:
            self.ask({"op": "shutdown"})
        except Exception:
            pass
        self.process.terminate()


def enumerate_instances(client, page_size: int, limit: Optional[int]) -> tuple[list[Any], dict]:
    """Every instance /search-deep will name, each one once.

    The walk is not stably ordered: two walks of the same deployment return overlapping but
    unequal prefixes, so a page can repeat an instance an earlier page already gave. Duplicates
    are dropped here and counted, and the total the search reports is carried out so a short
    enumeration is visible rather than silently becoming a smaller sweep.
    """
    refs: list[Any] = []
    seen_ids: set[str] = set()
    page, offset, started, duplicates, reported = None, 0, time.time(), 0, 0
    while limit is None or len(refs) < limit:
        data = rest.search_deep_page(client, "instance", page_size, None if page else offset, page)
        rows = data["resources"]
        reported = data["totalCount"]
        if not rows:
            break
        for row in rows:
            identifier = row.get("@id")
            if not identifier:
                continue
            if identifier in seen_ids:
                duplicates += 1
                continue
            seen_ids.add(identifier)
            refs.append(rest.ArtifactRef("instance", identifier, row.get("schema:name", "")))
        page, offset = data.get("continuation"), offset + len(rows)
        if len(refs) % 10000 < page_size:
            print(f"  enumerated {len(refs)}/{reported} "
                  f"({len(refs) / max(1e-9, time.time() - started):.0f}/s)", flush=True)
        if not page and offset >= reported:
            break
    if limit is not None:
        refs = refs[:limit]
    return refs, {"reported": reported, "duplicateRowsSkipped": duplicates,
                  "enumerated": len(refs)}


def template_for(client, template_id: str, cache: dict[str, Any]) -> Optional[Any]:
    """The template an instance names, read once and kept.

    A deployment has orders of magnitude fewer templates than instances, so the cache turns one
    read per instance into one read per template. A template that cannot be read is remembered as
    unavailable rather than retried for every instance that names it.
    """
    if template_id in cache:
        return cache[template_id]
    try:
        cache[template_id] = client.get_json(
            f"/templates/{urllib.parse.quote(template_id, safe='')}")
    except Exception:
        cache[template_id] = None
    return cache[template_id]


def both_representations(client, ref) -> tuple[Optional[str], Optional[str], list[str]]:
    """The two documents the server serves for one instance, and what refusing them looked like."""
    quoted = urllib.parse.quote(ref.artifact_id, safe="")
    yaml_text = json_text = None
    problems: list[str] = []
    try:
        body, media = client.get_representation(f"/template-instances/{quoted}", "application/yaml")
        if media != "application/yaml":
            problems.append(f"yaml: served as {media}")
        else:
            yaml_text = body
    except Exception as error:
        problems.append(f"yaml: {error}")
    try:
        json_text = json.dumps(client.get_json(f"/template-instances/{quoted}"), ensure_ascii=False)
    except Exception as error:
        problems.append(f"json: {error}")
    return yaml_text, json_text, problems


def read_records(path: pathlib.Path) -> Iterator[dict[str, Any]]:
    """Every record the run wrote, skipping any truncated final line."""
    if not path.exists():
        return
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                yield json.loads(line)
            except Exception:
                continue


def build_parser() -> argparse.ArgumentParser:
    """The command line, built apart from main so it can be inspected and tested."""
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default="https://resource.metadatacenter.org")
    parser.add_argument("--key-file", default=str(pathlib.Path.home() / ".cedar-admin-key"))
    parser.add_argument("--classpath", required=True,
                        help="the artifact library's classes and dependencies")
    parser.add_argument("--records", required=True, type=pathlib.Path)
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    parser.add_argument("--fetch-workers", type=int, default=DEFAULT_FETCH_WORKERS)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--progress-every", type=int, default=2000)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--timeout", type=float, default=60,
                        help="seconds to wait for one read (default: 60)")
    parser.add_argument("--no-write-path", action="store_true",
                        help="skip the question of whether a YAML write would be stored; that "
                             "question needs each instance's template, which costs one read per "
                             "distinct template")
    parser.add_argument("--no-verify", action="store_true",
                        help="skip the pass that re-reads everything that failed; a failure is "
                             "then whatever the first ask returned, which overstates breakage")
    return parser


def main() -> int:
    arguments = build_parser().parse_args()

    # Three attempts, not one. A read that fails once is usually a socket timeout or a name
    # lookup that did not answer, and asking again settles it; a run that tried once reported 208
    # such reads as failures out of 301,158, every one of which served on the next ask.
    client = rest.GetOnlyClient(arguments.server,
                                pathlib.Path(arguments.key_file).read_text().strip(),
                                timeout=arguments.timeout, retries=3)
    refs_path = arguments.records.with_name(arguments.records.stem + "-refs.json")
    summary_path = arguments.records.with_name(arguments.records.stem + "-summary.json")

    if arguments.resume and refs_path.exists():
        stored = json.loads(refs_path.read_text())
        refs = [rest.ArtifactRef("instance", i, "") for i in stored["ids"]]
        enumeration = stored["enumeration"]
        print(f"resuming over {len(refs)} enumerated instances", flush=True)
    else:
        print("enumerating instances", flush=True)
        refs, enumeration = enumerate_instances(client, arguments.page_size, arguments.limit)
        refs_path.write_text(json.dumps({"enumeration": enumeration,
                                         "ids": [r.artifact_id for r in refs]}))
        print(f"enumerated {len(refs)} instances; search reports {enumeration['reported']}; "
              f"{enumeration['duplicateRowsSkipped']} duplicate rows skipped", flush=True)
        if arguments.limit is None and len(refs) < enumeration["reported"]:
            print(f"  NOTE: {enumeration['reported'] - len(refs)} fewer than the search reports; "
                  "the walk is not stably ordered and may not have named every instance",
                  flush=True)

    done: set[str] = set()
    if arguments.resume:
        done = {record["id"] for record in read_records(arguments.records) if "id" in record}
        print(f"{len(done)} already recorded; {len(refs) - len(done)} to go", flush=True)

    pending = [r for r in refs if r.artifact_id not in done]
    bridge = Bridge(arguments.classpath)
    tally = collections.Counter()
    loss_kinds = collections.Counter()
    write_path_errors = collections.Counter()
    template_cache: dict[str, Any] = {}
    sent_templates: set[str] = set()
    losing: list[dict[str, Any]] = []
    started = time.time()

    def fetch(cl, ref):
        return both_representations(cl, ref), None

    try:
        with arguments.records.open("a" if arguments.resume else "w", encoding="utf-8") as out:
            for index, (ref, got, error) in enumerate(
                    rest.fetch_in_order(client, pending, arguments.fetch_workers, fetch=fetch), 1):
                record: dict[str, Any] = {"id": ref.artifact_id}
                yaml_text, json_text, problems = got if got else (None, None, [str(error)])
                # The template every record names is what turns a per-instance finding into a
                # per-template one. A defect in a stored template shape is repaired by fixing that
                # template and the instances on it together, which needs their count, not a sample.
                if json_text is not None:
                    try:
                        based_on = json.loads(json_text).get("schema:isBasedOn")
                        if based_on:
                            record["isBasedOn"] = based_on
                    except Exception:
                        pass
                if problems:
                    record["unserved"] = problems
                    tally["unserved"] += 1

                if yaml_text is not None:
                    served = bridge.ask({"op": "serves", "yaml": yaml_text})
                    if served.get("status") != "ok":
                        record["serves"] = {"stage": served.get("stage"),
                                            "message": served.get("message")}
                        tally[f"served-yaml-unreadable ({served.get('stage')})"] += 1
                    elif not served.get("reproduced"):
                        record["serves"] = {"differences": served.get("differences", [])}
                        tally["served-yaml-not-reproduced"] += 1
                    else:
                        tally["served-yaml-reproduced"] += 1

                if json_text is not None and not arguments.no_write_path:
                    template_id = record.get("isBasedOn")
                    if not template_id:
                        record["writePath"] = {"stage": "template", "message": "names no template"}
                        tally["write-path-no-template"] += 1
                    else:
                        template = template_for(client, template_id, template_cache)
                        if template is None:
                            record["writePath"] = {"stage": "template",
                                                   "message": "its template could not be read"}
                            tally["write-path-template-unreadable"] += 1
                        else:
                            if template_id not in sent_templates:
                                bridge.ask({"op": "cache-template", "id": template_id,
                                            "template": template})
                                sent_templates.add(template_id)
                            verdict = bridge.ask({"op": "writepath", "templateId": template_id,
                                                  "json": json_text})
                            if verdict.get("status") != "ok":
                                record["writePath"] = {"stage": verdict.get("stage"),
                                                       "message": verdict.get("message"),
                                                       "storedValid": verdict.get("storedValid")}
                                held = "stored-valid" if verdict.get("storedValid") else "stored-invalid"
                                tally[f"write-path-failed at {verdict.get('stage')}, {held}"] += 1
                                if verdict.get("storedValid"):
                                    write_path_errors[
                                        f"[{verdict.get('stage')}] "
                                        + str(verdict.get("message", ""))[:70]] += 1
                            elif verdict.get("accepted"):
                                tally["write-path-accepted"] += 1
                                if not verdict.get("storedValid"):
                                    tally["write-path-accepted-though-stored-invalid"] += 1
                            else:
                                record["writePath"] = {"errors": verdict.get("errors", []),
                                                       "errorCount": verdict.get("errorCount"),
                                                       "storedValid": verdict.get("storedValid")}
                                if verdict.get("storedValid"):
                                    # The deployment holds this as valid and the write path would
                                    # refuse it. That is this path's defect, not the data's.
                                    tally["write-path-refused-though-stored-valid"] += 1
                                    for error in verdict.get("errors", []):
                                        write_path_errors[error.get("message", "")[:90]] += 1
                                else:
                                    tally["write-path-refused-and-stored-invalid"] += 1

                if json_text is not None:
                    trip = bridge.ask({"op": "roundtrip", "json": json_text})
                    if trip.get("status") != "ok":
                        record["roundtrip"] = {"stage": trip.get("stage"),
                                               "message": trip.get("message")}
                        tally[f"json-unreadable ({trip.get('stage')})"] += 1
                    elif trip.get("survives"):
                        tally["survives"] += 1
                    else:
                        record["roundtrip"] = {"losses": trip.get("losses", [])}
                        tally["loses-content"] += 1
                        for loss in trip.get("losses", []):
                            loss_kinds[loss["kind"]] += 1
                        losing.append({"id": ref.artifact_id, "losses": trip.get("losses", [])})

                # Every instance gets a record, including one with nothing to say. Resume reads
                # these back to know what is done, so recording only the interesting ones would
                # make a resumed run redo every clean instance.
                if len(record) == 1:
                    record["clean"] = True
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                out.flush()

                if index % arguments.progress_every == 0:
                    rate = index / max(1e-9, time.time() - started)
                    left = (len(pending) - index) / max(1e-9, rate)
                    print(f"  {index}/{len(pending)}  {rate:.0f}/s  ~{left / 60:.0f} min left  "
                          f"writable {tally['write-path-accepted']}  "
                          f"refused-but-valid {tally['write-path-refused-though-stored-valid']}  "
                          f"survives {tally['survives']}  unserved {tally['unserved']}", flush=True)
    finally:
        bridge.close()

    elapsed = time.time() - started

    # A single failed read is not a finding. Re-read everything that failed, one at a time, and
    # record which failures survive; the transient ones are dropped from the tally rather than
    # reported. Nothing else in the run distinguishes a stalled socket from a stored defect.
    verified: dict[str, Any] = {}
    if not arguments.no_verify:
        failed = [record for record in read_records(arguments.records)
                  if record.get("unserved")]
        if failed:
            print(f"\nverifying {len(failed)} failed reads one at a time", flush=True)
            transient, persistent = 0, []
            for index, record in enumerate(failed, 1):
                problems = both_representations(client, rest.ArtifactRef("instance", record["id"], ""))[2]
                if problems:
                    persistent.append({"id": record["id"], "first": record["unserved"],
                                       "again": problems})
                else:
                    transient += 1
                if index % 100 == 0:
                    print(f"  {index}/{len(failed)}", flush=True)
            verified = {"failedOnFirstRead": len(failed), "transient": transient,
                        "persistent": len(persistent)}
            tally["unserved-transient"] = transient
            tally["unserved"] = len(persistent)
            rest.atomic_write_json(
                arguments.records.with_name(arguments.records.stem + "-persistent.json"),
                persistent)
            print(f"  {transient} of {len(failed)} served on a second ask and are not counted",
                  flush=True)

    summary = {"record": "instance-roundtrip-summary", "server": arguments.server,
               "verification": verified,
               "enumeration": enumeration,
               "instances": len(refs), "processed": len(pending), "elapsedSeconds": round(elapsed, 1),
               "tally": dict(tally), "lossKinds": dict(loss_kinds),
               "writePathErrors": dict(write_path_errors),
               "templatesRead": len([t for t in template_cache.values() if t]),
               "templatesSeen": len(template_cache),
               "reader": bridge.reader}
    summary_path.write_text(json.dumps(summary, indent=2))

    print(f"\nprocessed {len(pending)} instances in {elapsed / 60:.1f} min")
    for name, count in tally.most_common():
        print(f"   {count:7d}  {name}")
    if write_path_errors:
        print("why a YAML write would be refused for an instance the deployment holds as valid:")
        for name, count in write_path_errors.most_common(15):
            print(f"   {count:7d}  {name}")
    if loss_kinds:
        print("what a template-free round trip loses (the template restores most of it):")
        for name, count in loss_kinds.most_common():
            print(f"   {count:7d}  {name}")
    print(f"\nrecords : {arguments.records}")
    print(f"summary : {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
