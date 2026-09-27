#!/usr/bin/env python3
"""Find the instances carrying a key that belongs to the artifact declaring a shape.

``pav:version`` and ``bibo:status`` describe an artifact that is drafted, published and versioned.
An instance simply is: where it carries either, the value was copied from the template that made it
and says nothing true about the instance. Nothing rejects one on write, because an instance is
validated against its own template rather than against an instance meta-schema, and a template is
only accidentally strict here - one spelling ``additionalProperties`` as a schema refuses the key as
a type mismatch, while a permissive one carries it silently for as long as it exists.

So the population has to be read rather than inferred from validation, which is what this does.
GET-only: it never writes an artifact, and it never stores or prints the API key. Its records are
the target list ``repairs/cedar_artifact_repair.py --repair drop-schema-keys-from-instance`` takes.

    python3 cedar_instance_schema_key_scan.py --api-key-file ~/.key --out carrying.jsonl
    python3 repairs/cedar_artifact_repair.py --repair drop-schema-keys-from-instance \\
        --condition schema-only-key-on-instance --from-records carrying.jsonl --workers 1 --apply
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as audit  # noqa: E402

# Confined to the two the model names. `schema:schemaVersion` and `_ui` are equally schema-only and
# would join this list only on the same decision being taken about them.
SCHEMA_ONLY_KEYS = ("pav:version", "bibo:status")
CONDITION = "schema-only-key-on-instance"


def carried_keys(artifact: Any) -> list[str]:
    """Which schema-only keys this instance holds at its root.

    Only the root: a nested element instance carrying one is a different shape and a different
    decision, and the repair that clears these does not reach inside either.
    """
    if not isinstance(artifact, dict):
        return []
    return [key for key in SCHEMA_ONLY_KEYS if key in artifact]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default=rest.DEFAULT_SERVER)
    parser.add_argument("--api-key-file")
    parser.add_argument("--limit", type=int, default=None,
                        help="instances to walk (default: every one)")
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--fetch-workers", type=int, default=16)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--delay-ms", type=int, default=0)
    parser.add_argument("--ca-file")
    parser.add_argument("--allow-http", action="store_true")
    parser.add_argument("--out", default="instance-schema-keys.jsonl",
                        help="one record per instance carrying a key")
    parser.add_argument("--resume", action="store_true",
                        help="skip the instances a previous run already read")
    parser.add_argument("--progress-every", type=int, default=2000)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    api_key = rest.resolve_api_key(arguments, parser)
    client = rest.GetOnlyClient(arguments.server, api_key, timeout=arguments.timeout,
                                retries=arguments.retries, delay_ms=arguments.delay_ms,
                                ca_file=arguments.ca_file, allow_http=arguments.allow_http)

    out_path = Path(arguments.out).expanduser()
    read_path = out_path.with_name(out_path.stem + "-read.txt")
    already: set[str] = set()
    if arguments.resume and read_path.is_file():
        already = {line.strip() for line in read_path.read_text(encoding="utf-8").splitlines()
                   if line.strip()}
        print(f"resuming: {len(already)} instances already read")

    state = rest.AuditState(limit=None, started_at=rest.utc_now())
    print(f"Scanning {arguments.server} for {' and '.join(SCHEMA_ONLY_KEYS)} on instances")
    refs = [ref for ref in rest.iter_artifact_refs(client, "instance", arguments.page_size,
                                                   state, arguments.limit)
            if ref.artifact_id not in already]
    print(f"  {len(refs)} instances to read", flush=True)

    started = time.monotonic()
    read = carrying = unread = 0
    counts = {key: 0 for key in SCHEMA_ONLY_KEYS}
    with out_path.open("a" if arguments.resume else "w", encoding="utf-8") as records, \
            read_path.open("a" if arguments.resume else "w", encoding="utf-8") as scanned:
        for ref, artifact, error in audit.fetch_in_order(client, refs, arguments.fetch_workers):
            if error is not None or artifact is None:
                unread += 1
                continue
            read += 1
            scanned.write(ref.artifact_id + "\n")
            keys = carried_keys(artifact)
            if keys:
                carrying += 1
                for key in keys:
                    counts[key] += 1
                records.write(json.dumps({
                    "artifactType": "instance",
                    "artifactId": ref.artifact_id,
                    "artifactName": ref.name,
                    "keys": keys,
                    "conditionRules": {CONDITION: len(keys)},
                }) + "\n")
                records.flush()
            if read % arguments.progress_every == 0:
                rate = read / max(time.monotonic() - started, 1e-9)
                left = (len(refs) - read) / rate / 60
                print(f"    read {read}/{len(refs)}  carrying {carrying}  "
                      f"{rate:.0f}/s  ~{left:.0f} min left", flush=True)

    print(f"\nread {read} instances in {(time.monotonic() - started) / 60:.1f} min"
          f"{f'; {unread} could not be read' if unread else ''}")
    print(f"carrying a schema-only key: {carrying}")
    for key, count in counts.items():
        print(f"  {count:6d}  {key}")
    print(f"\nrecords: {out_path}")
    if carrying:
        print("repair them with repairs/cedar_artifact_repair.py "
              f"--repair drop-schema-keys-from-instance --condition {CONDITION} "
              f"--from-records {out_path} --workers 1 --apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
