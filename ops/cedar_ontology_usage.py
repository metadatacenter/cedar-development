#!/usr/bin/env python3
"""
cedar_ontology_usage.py — inventory the ontologies referenced by CEDAR artifacts.

Enumerates every template and element the API key can access via the resource server's
/search endpoint, fetches each artifact, and recursively walks its _valueConstraints to
list which ontologies are referenced and how widely. (Fields are not scanned separately:
templates and elements embed their fields inline, so field-level constraints inside them
are already captured; only standalone library fields would be missed.)

An ontology can be referenced four ways inside a controlled-term field's _valueConstraints:
  - ontologies[]  -> the whole ontology            (acronym / uri)
  - branches[]    -> a class + its descendants      (acronym / source / uri)
  - classes[]     -> individually picked classes    (source ontology of each class)
  - valueSets[]   -> a value set                    (vsCollection)

Partial results on failure:
  - The per-artifact CSV (--out) is written and flushed one row at a time, so a crash,
    a network drop, or Ctrl-C still leaves a usable file with everything fetched so far.
  - The ranked aggregate is printed from a try/finally, so it is ALWAYS emitted — on
    normal completion, on Ctrl-C, or on an unexpected error — clearly marked COMPLETE
    or PARTIAL. One bad artifact is skipped, not fatal; a 401 aborts cleanly with partial.

Auth: pass the key with --api-key, or (preferred) set CEDAR_API_KEY so it stays out of
your shell history and the process list. The key is sent as "Authorization: apiKey <KEY>".

Only stdlib — no pip install needed.

Examples:
  export CEDAR_API_KEY=xxxxxxxx
  python3 cedar_ontology_usage.py                       # templates + elements, ranked usage
  python3 cedar_ontology_usage.py --out usage.csv       # same, plus per-artifact CSV
  python3 cedar_ontology_usage.py --types template      # templates only
  python3 cedar_ontology_usage.py --limit 50            # quick sample (first 50 artifacts)
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

DEFAULT_SERVER = "https://resource.metadatacenter.org"

# resource_types value used by /search  ->  REST path used to GET the full artifact.
# Fields are intentionally excluded: templates and elements embed their fields inline.
TYPE_PATH = {"template": "templates", "element": "template-elements"}


class AuthError(Exception):
    """Raised on 401 so the run aborts cleanly and still emits partial results."""


class _LimitReached(Exception):
    """Internal: --limit hit; breaks out of the nested loop into the finally block."""


def api_get(url, api_key, retries=5):
    """GET JSON with the CEDAR apiKey header, retrying transient/rate-limit errors."""
    req = urllib.request.Request(
        url, headers={"Authorization": f"apiKey {api_key}", "Accept": "application/json"}
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise AuthError("401 Unauthorized — check the API key (sent as "
                                "'Authorization: apiKey <KEY>').")
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(min(30, 2 ** attempt))
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
    return None


def iter_resource_ids(server, api_key, rtype, page_size, hard_limit=None):
    """Page through /search for one resource type; yield (@id, name)."""
    offset, seen = 0, 0
    while True:
        query = urllib.parse.urlencode({
            "resource_types": rtype,
            "limit": page_size,
            "offset": offset,
            "version": "all",
            "publication_status": "all",
        })
        data = api_get(f"{server}/search?{query}", api_key)
        resources = (data or {}).get("resources", []) or []
        if not resources:
            break
        total = (data or {}).get("totalCount")
        for res in resources:
            yield res.get("@id"), res.get("schema:name") or res.get("schema:title") or ""
            seen += 1
            if hard_limit and seen >= hard_limit:
                return
        offset += page_size
        if total is not None and offset >= total:
            break


def acronym_of(value):
    """Reduce an ontology reference to an acronym: last path segment of a URL, else the value."""
    if not value:
        return None
    value = str(value).rstrip("/")
    return value.rsplit("/", 1)[-1] if "/" in value else value


def collect_refs(node, out):
    """Recursively find every _valueConstraints and record its ontology references in `out`,
    where out maps kind ('ontology'|'branch'|'class'|'valueSet') -> set of acronyms."""
    if isinstance(node, dict):
        vc = node.get("_valueConstraints")
        if isinstance(vc, dict):
            for o in vc.get("ontologies") or []:
                a = o.get("acronym") or acronym_of(o.get("uri"))
                if a:
                    out["ontology"].add(a)
            for b in vc.get("branches") or []:
                a = b.get("acronym") or b.get("source") or acronym_of(b.get("uri"))
                if a:
                    out["branch"].add(acronym_of(a))
            for c in vc.get("classes") or []:
                a = c.get("source") or acronym_of(c.get("uri"))
                if a:
                    out["class"].add(acronym_of(a))
            for vs in vc.get("valueSets") or []:
                a = vs.get("vsCollection") or acronym_of(vs.get("uri"))
                if a:
                    out["valueSet"].add(acronym_of(a))
        for v in node.values():
            collect_refs(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_refs(v, out)


# The keys of _valueConstraints that the terminology server's /bioportal/integrated-search consumes.
# Its ValueConstraints model ignores unknown keys, but the enclosing request body binds strictly, so
# the emitted block is trimmed to exactly these — a guaranteed-valid `valueConstraints`.
TERM_KEYS = ("ontologies", "branches", "valueSets", "classes", "actions")
# The four that actually point at a terminology lookup; a constraint with none of them is a plain
# value field (a literal list, or nothing) and is not a terminology case.
LOOKUP_KEYS = ("ontologies", "branches", "valueSets", "classes")


def trim_constraints(vc):
    """The terminology-relevant subset of a field's _valueConstraints, shaped as integrated-search
    requires: all four lookup lists present (empty when absent) — the endpoint's validator rejects a
    null branches/classes/valueSets/ontologies — plus `actions` only when the field carries it."""
    out = {k: (vc.get(k) or []) for k in LOOKUP_KEYS}
    if vc.get("actions"):
        out["actions"] = vc["actions"]
    return out


def collect_constraints(node, records, source, path="$"):
    """Walk an artifact and append one record per controlled-term field: its provenance plus the
    trimmed _valueConstraints, ready to drop into an integrated-search parameterObject."""
    if isinstance(node, dict):
        vc = node.get("_valueConstraints")
        if isinstance(vc, dict) and any(vc.get(k) for k in LOOKUP_KEYS):
            records.append({
                "source": {**source, "field": node.get("schema:name"), "fieldPath": path},
                "valueConstraints": trim_constraints(vc),
            })
        for k, v in node.items():
            collect_constraints(v, records, source, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            collect_constraints(v, records, source, f"{path}[{i}]")


def print_report(scanned, per_type_counts, any_ref, usage, status):
    """Emit the ranked aggregate. Always called (even on partial runs) via finally."""
    header = ", ".join(f"{c} {t}" for t, c in per_type_counts.items()) or "none"
    print(f"\n=== Ontology usage across {scanned} artifacts ({header}) — {status} ===\n")
    if not scanned:
        print("(no artifacts scanned)")
        sys.stdout.flush()
        return
    print("By # artifacts referencing the ontology (any way — whole ontology, branch, or class):")
    for acr, n in any_ref.most_common():
        kinds = [k for k in ("ontology", "branch", "class") if usage[k][acr]]
        print(f"  {acr:20} {n:5}   ({', '.join(kinds)})")
    for kind, label in (("ontology", "as WHOLE ontology"),
                        ("branch", "as a BRANCH"),
                        ("class", "as the SOURCE of picked classes"),
                        ("valueSet", "value-set collections")):
        if usage[kind]:
            print(f"\n{label}:")
            for acr, n in usage[kind].most_common():
                print(f"  {acr:20} {n:5}")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser(description="Inventory ontologies referenced by CEDAR artifacts.")
    ap.add_argument("--api-key", default=os.environ.get("CEDAR_API_KEY"),
                    help="CEDAR API key (or set CEDAR_API_KEY, preferred).")
    ap.add_argument("--server", default=DEFAULT_SERVER, help=f"Resource server base URL (default {DEFAULT_SERVER}).")
    ap.add_argument("--types", default="template,element",
                    help="Comma list of resource types to scan: template,element (default: both).")
    ap.add_argument("--page-size", type=int, default=100, help="Search page size (default 100).")
    ap.add_argument("--limit", type=int, help="Stop after this many artifacts (quick sample).")
    ap.add_argument("--out", help="Write per-artifact detail as CSV (streamed+flushed, so a partial run "
                                  "still leaves a usable file).")
    ap.add_argument("--emit-constraints", metavar="PATH",
                    help="Also write every controlled-term field's _valueConstraints to PATH as JSONL, "
                         "one record per field (provenance + a trimmed, integrated-search-ready block). "
                         "This is the raw corpus for terminology differential testing; reduce it to the "
                         "atomic-target usage matrix with cedar_usage_matrix.py.")
    args = ap.parse_args()

    if not args.api_key:
        sys.exit("Provide the key via CEDAR_API_KEY (preferred) or --api-key.")
    types = [t.strip() for t in args.types.split(",") if t.strip()]
    for rtype in types:
        if rtype not in TYPE_PATH:
            sys.exit(f"Unknown type '{rtype}'. Use: {', '.join(TYPE_PATH)}.")

    usage = {k: Counter() for k in ("ontology", "branch", "class", "valueSet")}
    any_ref = Counter()
    per_type_counts = Counter()
    scanned = 0

    fieldnames = ["type", "id", "name", "ontologies", "branches", "class_sources", "value_set_collections"]
    csv_file = csv_writer = None
    if args.out:
        csv_file = open(args.out, "w", newline="")
        csv_writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        csv_writer.writeheader()
        csv_file.flush()

    vc_file = None
    vc_count = 0
    if args.emit_constraints:
        vc_file = open(args.emit_constraints, "w")

    status = "COMPLETE"
    try:
        for rtype in types:
            path = TYPE_PATH[rtype]
            for aid, name in iter_resource_ids(args.server, args.api_key, rtype, args.page_size,
                                               hard_limit=args.limit):
                if not aid:
                    continue
                try:
                    artifact = api_get(f"{args.server}/{path}/{urllib.parse.quote(aid, safe='')}", args.api_key)
                except AuthError:
                    raise  # token bad/expired — abort, but keep everything gathered so far
                except Exception as e:  # one bad artifact must not abort the whole run
                    print(f"  ! skip {rtype} {aid}: {e}", file=sys.stderr)
                    continue
                if vc_file is not None:
                    recs = []
                    collect_constraints(artifact, recs,
                                        {"type": rtype, "id": aid, "name": name})
                    for rec in recs:
                        vc_file.write(json.dumps(rec) + "\n")
                        vc_count += 1
                    vc_file.flush()  # stream+flush, so a partial run still leaves a usable corpus

                refs = {k: set() for k in usage}
                collect_refs(artifact, refs)
                for kind, acronyms in refs.items():
                    for a in acronyms:
                        usage[kind][a] += 1
                for a in set().union(*refs.values()):
                    any_ref[a] += 1
                per_type_counts[rtype] += 1
                scanned += 1
                if csv_writer:
                    csv_writer.writerow({
                        "type": rtype, "id": aid, "name": name,
                        "ontologies": ";".join(sorted(refs["ontology"])),
                        "branches": ";".join(sorted(refs["branch"])),
                        "class_sources": ";".join(sorted(refs["class"])),
                        "value_set_collections": ";".join(sorted(refs["valueSet"])),
                    })
                    csv_file.flush()  # so a hard kill still leaves a complete-up-to-here file
                if scanned % 25 == 0:
                    print(f"  ... scanned {scanned} artifacts", file=sys.stderr)
                if args.limit and scanned >= args.limit:
                    raise _LimitReached
    except _LimitReached:
        status = f"COMPLETE (stopped at --limit {args.limit})"
    except KeyboardInterrupt:
        status = "PARTIAL — interrupted (Ctrl-C)"
    except AuthError as e:
        status = f"PARTIAL — {e}"
    except Exception as e:
        status = f"PARTIAL — stopped early on error: {type(e).__name__}: {e}"
    finally:
        if csv_file:
            csv_file.close()
        if vc_file:
            vc_file.close()
        print_report(scanned, per_type_counts, any_ref, usage, status)
        if args.out and scanned:
            print(f"\nPer-artifact detail (streamed) in {args.out}", file=sys.stderr)
        if args.emit_constraints:
            print(f"Controlled-term constraints (streamed): {vc_count} records in {args.emit_constraints}",
                  file=sys.stderr)


if __name__ == "__main__":
    main()
