#!/usr/bin/env python3
"""
cedar_termcorpus_select.py — curate a terminology differential-testing corpus.

Reads the raw JSONL that `cedar_ontology_usage.py --emit-constraints` writes (one record per
controlled-term field: provenance + a trimmed `_valueConstraints`), and produces a small, diverse
set of ready-to-POST integrated-search cases for comparing two terminology servers.

Pipeline:
  1. Dedupe. Two fields with the identical constraint block are the same test; keep one, but remember
     how many fields shared it (`seenIn`) so frequency is not lost.
  2. Classify each unique constraint by SHAPE — which of ontologies/branches/valueSets/classes it
     uses, whether it mixes several, and the edge flags that tend to expose behavior differences
     (a branch with maxDepth, a multi-ontology constraint, a long picked-class list, an actions
     block). The shape signature is what "interesting" is measured against.
  3. Select up to N (default 100) maximizing diversity: round-robin across shape buckets, and within
     a bucket prefer the constraint that introduces an ontology / value-set collection not yet in the
     selection. Breadth of shapes and sources first, frequency only as a tie-breaker.
  4. Expand each selected constraint across a few inputText seeds (default "", "a", "e"): the browse
     path and the prefix-search path can diverge between implementations, so both are exercised.

Output (--out, JSONL) is one line per CASE — a concrete request the diff harness can POST verbatim
to /bioportal/integrated-search on each server and compare:

  {"id": "...", "shape": "...", "inputText": "a", "source": {...},
   "request": {"parameterObject": {"inputText": "a", "valueConstraints": {...}}, "page": 1, "pageSize": 50}}

Only stdlib. Example:
  python3 cedar_ontology_usage.py --emit-constraints raw.jsonl        # (against production)
  python3 cedar_termcorpus_select.py --in raw.jsonl --out corpus.jsonl --count 100
"""
import argparse
import json
import sys
from collections import defaultdict

LOOKUP_KEYS = ("ontologies", "branches", "valueSets", "classes")


def canonical(vc):
    """A stable string for a constraint block, so identical constraints dedupe regardless of key
    order or list order within a kind."""
    def norm(x):
        if isinstance(x, dict):
            return {k: norm(x[k]) for k in sorted(x)}
        if isinstance(x, list):
            # Sort by canonical form of each element so [A,B] and [B,A] are the same constraint.
            return sorted((norm(e) for e in x), key=lambda e: json.dumps(e, sort_keys=True))
        return x
    return json.dumps(norm(vc), sort_keys=True)


def shape_of(vc):
    """A signature capturing the interesting structure of a constraint, and a set of edge flags."""
    kinds = tuple(k for k in LOOKUP_KEYS if vc.get(k))
    flags = []
    if len(vc.get("ontologies") or []) > 1:
        flags.append("multi-ontology")
    if len(vc.get("branches") or []) > 1:
        flags.append("multi-branch")
    if any((b.get("maxDepth") not in (None, 0)) for b in (vc.get("branches") or [])):
        flags.append("branch-maxDepth")
    if len(vc.get("classes") or []) >= 5:
        flags.append("many-classes")
    if len(kinds) > 1:
        flags.append("mixed-kinds")
    if vc.get("actions"):
        flags.append("actions")
    sig = "+".join(kinds) if kinds else "none"
    if flags:
        sig += " [" + ",".join(sorted(flags)) + "]"
    return sig


def sources_in(vc):
    """The ontology acronyms / value-set collections a constraint touches — the breadth axis."""
    s = set()
    for o in vc.get("ontologies") or []:
        s.add(o.get("acronym") or o.get("uri"))
    for b in vc.get("branches") or []:
        s.add(b.get("acronym") or b.get("source") or b.get("uri"))
    for c in vc.get("classes") or []:
        s.add(c.get("source") or c.get("uri"))
    for v in vc.get("valueSets") or []:
        s.add(v.get("vsCollection") or v.get("uri"))
    return {x for x in s if x}


def main():
    ap = argparse.ArgumentParser(description="Curate a diverse terminology differential-testing corpus.")
    ap.add_argument("--in", dest="infile", required=True, help="Raw JSONL from --emit-constraints.")
    ap.add_argument("--out", required=True, help="Output corpus JSONL (one line per case).")
    ap.add_argument("--count", type=int, default=100, help="Max distinct constraints to select (default 100).")
    ap.add_argument("--seeds", default=",a,e",
                    help="Comma list of inputText seeds; empty item = browse mode (default: ',a,e' = "
                         "'', 'a', 'e').")
    ap.add_argument("--page-size", type=int, default=50, help="pageSize for each request (default 50).")
    args = ap.parse_args()

    seeds = args.seeds.split(",")  # deliberately keep an empty leading item as the "" browse seed

    # 1. Load + dedupe.
    uniq = {}  # canonical -> {"vc":..., "shape":..., "sources":set, "seenIn":n, "source":firstProvenance}
    total = 0
    with open(args.infile) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            total += 1
            rec = json.loads(line)
            vc = rec.get("valueConstraints") or {}
            if not any(vc.get(k) for k in LOOKUP_KEYS):
                continue
            key = canonical(vc)
            if key in uniq:
                uniq[key]["seenIn"] += 1
            else:
                uniq[key] = {"vc": vc, "shape": shape_of(vc), "sources": sources_in(vc),
                             "seenIn": 1, "source": rec.get("source")}

    if not uniq:
        sys.exit(f"No controlled-term constraints found in {args.infile} ({total} records read).")

    # 2. Bucket by shape.
    buckets = defaultdict(list)
    for entry in uniq.values():
        buckets[entry["shape"]].append(entry)
    # Within each bucket, most-frequent first (frequency as the tie-breaker, not the driver).
    for b in buckets.values():
        b.sort(key=lambda e: e["seenIn"], reverse=True)

    # 3. Round-robin across buckets, preferring a constraint that adds a new source.
    selected = []
    seen_sources = set()
    bucket_names = sorted(buckets)
    exhausted = False
    while len(selected) < args.count and not exhausted:
        exhausted = True
        for name in bucket_names:
            pool = buckets[name]
            if not pool:
                continue
            exhausted = False
            # Prefer an entry introducing a source not yet represented; else take the next.
            pick_i = next((i for i, e in enumerate(pool) if e["sources"] - seen_sources), 0)
            entry = pool.pop(pick_i)
            seen_sources |= entry["sources"]
            selected.append(entry)
            if len(selected) >= args.count:
                break

    # 4. Expand across seeds and write cases.
    n_cases = 0
    shape_counts = defaultdict(int)
    with open(args.out, "w") as out:
        for idx, entry in enumerate(selected):
            shape_counts[entry["shape"]] += 1
            for si, seed in enumerate(seeds):
                case = {
                    "id": f"case{idx:03d}-s{si}",
                    "shape": entry["shape"],
                    "seenIn": entry["seenIn"],
                    "inputText": seed,
                    "source": entry["source"],
                    "request": {
                        "parameterObject": {"inputText": seed, "valueConstraints": entry["vc"]},
                        "page": 1,
                        "pageSize": args.page_size,
                    },
                }
                out.write(json.dumps(case) + "\n")
                n_cases += 1

    # Report.
    print(f"read {total} records -> {len(uniq)} distinct constraints in {len(buckets)} shapes", file=sys.stderr)
    print(f"selected {len(selected)} constraints across {len(shape_counts)} shapes, "
          f"{len(seen_sources)} distinct sources", file=sys.stderr)
    print(f"expanded over {len(seeds)} seed(s) -> {n_cases} cases in {args.out}", file=sys.stderr)
    print("\nshape distribution of the selection:", file=sys.stderr)
    for name in sorted(shape_counts, key=lambda n: shape_counts[n], reverse=True):
        print(f"  {shape_counts[name]:3d}  {name}", file=sys.stderr)


if __name__ == "__main__":
    main()
