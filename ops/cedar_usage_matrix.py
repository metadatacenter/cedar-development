#!/usr/bin/env python3
"""
cedar_usage_matrix.py — build the actual terminology-usage matrix from the raw corpus.

Reads the JSONL that `cedar_ontology_usage.py --emit-constraints` writes (one record per
controlled-term field: provenance + a trimmed `_valueConstraints`) and reduces it to the
*atomic-target matrix*: one row per distinct terminology lookup production actually performs.

An atom is a (kind, acronym, target) triple:
  - ontology  -> a whole ontology                 target = "" (the acronym is the identity)
  - branch    -> a class + its descendants         target = the class URI
  - class     -> an individually picked class       target = the class URI
  - valueSet  -> a value set                        target = the value-set URI

Unlike a top-N diversity sample, this keeps EVERY distinct target, so a differential test
built from it covers the full breadth of real usage. Each row carries how widely it is used
(`seenIn` fields, `nArtifacts` templates/elements), representative metadata (name, maxDepth),
one example provenance, and a minimal, ready-to-POST single-target `valueConstraints` block —
so a row doubles as a runnable integrated-search case.

Outputs:
  --out PATH    JSONL, one atom per line (the matrix; machine-readable, harness-ready).
  --tsv PATH    the same matrix as a tab-separated table (human-readable).
  stdout        an ontology x kind coverage summary.

All 325 referenced ontologies are kept, including licensed (e.g. SNOMEDCT) and non-BioPortal
(e.g. HRAVS) ones — some will not be answerable by the local store; that is real usage.

Only stdlib. Example:
  python3 cedar_ontology_usage.py --emit-constraints raw.jsonl
  python3 cedar_usage_matrix.py --in raw.jsonl --out matrix.jsonl --tsv matrix.tsv
"""
import argparse
import json
import re
import sys
from collections import defaultdict

# A source/acronym given as a display name ending in a parenthesised acronym, e.g.
# "BioAssay Ontology (BAO)" or "Units of Measurement Ontology (UO)". CEDAR fields sometimes
# carry the full name where an acronym belongs; without this the same ontology splits into two
# rows ("BAO" and "BioAssay Ontology (BAO)"). A name with no such suffix (e.g. "Unknown Ontology")
# has no acronym to recover and is left as-is.
_TRAILING_ACRONYM = re.compile(r"\(([^()]+)\)\s*$")


def acronym_of(value):
    """Reduce an ontology reference to an acronym: the parenthesised acronym of a display name,
    else the last path segment of a URL, else the value itself."""
    if not value:
        return None
    value = str(value).strip().rstrip("/")
    m = _TRAILING_ACRONYM.search(value)
    if m:
        return m.group(1).strip()
    return value.rsplit("/", 1)[-1] if "/" in value else value


class Atom:
    """One distinct terminology target, aggregated across every field that references it."""
    __slots__ = ("kind", "acronym", "target", "names", "max_depths", "sources",
                 "seen_in", "artifacts", "entry", "example")

    def __init__(self, kind, acronym, target):
        self.kind = kind
        self.acronym = acronym
        self.target = target
        self.names = set()
        self.max_depths = set()
        self.sources = set()
        self.seen_in = 0            # number of fields referencing this atom
        self.artifacts = set()      # distinct template/element ids
        self.entry = None           # a representative raw constraint entry (for the POST block)
        self.example = None         # one provenance {id, name, field}

    def key(self):
        return (self.kind, self.acronym, self.target)

    def value_constraints(self):
        """A minimal single-target valueConstraints block, shaped as integrated-search requires."""
        block = {"ontologies": [], "branches": [], "valueSets": [], "classes": []}
        e = self.entry or {}
        if self.kind == "ontology":
            block["ontologies"] = [{k: e[k] for k in ("acronym", "uri", "name") if k in e}]
        elif self.kind == "branch":
            block["branches"] = [{k: e[k] for k in ("source", "acronym", "uri", "name", "maxDepth") if k in e}]
        elif self.kind == "class":
            block["classes"] = [{k: e[k] for k in ("uri", "prefLabel", "label", "type", "source") if k in e}]
        elif self.kind == "valueSet":
            block["valueSets"] = [{k: e[k] for k in ("name", "vsCollection", "uri", "numTerms") if k in e}]
        return block

    def row(self):
        return {
            "kind": self.kind,
            "acronym": self.acronym,
            "target": self.target,
            "name": next(iter(sorted(n for n in self.names if n)), None),
            "maxDepths": sorted(self.max_depths) if self.max_depths else None,
            "seenIn": self.seen_in,
            "nArtifacts": len(self.artifacts),
            "example": self.example,
            "valueConstraints": self.value_constraints(),
        }


def atoms_of_record(rec):
    """Yield (kind, acronym, target, entry) for each terminology target in one field record."""
    vc = rec["valueConstraints"]
    for o in vc.get("ontologies") or []:
        a = acronym_of(o.get("acronym") or o.get("uri"))
        if a:
            yield "ontology", a, "", o
    for b in vc.get("branches") or []:
        a = b.get("acronym") or acronym_of(b.get("source")) or acronym_of(b.get("uri"))
        if a:
            yield "branch", acronym_of(a), b.get("uri") or "", b
    for c in vc.get("classes") or []:
        a = c.get("source") or acronym_of(c.get("uri"))
        if a:
            yield "class", acronym_of(a), c.get("uri") or "", c
    for vs in vc.get("valueSets") or []:
        a = vs.get("vsCollection") or acronym_of(vs.get("uri"))
        if a:
            yield "valueSet", acronym_of(a), vs.get("uri") or "", vs


def main():
    ap = argparse.ArgumentParser(description="Build the atomic-target terminology-usage matrix.")
    ap.add_argument("--in", dest="inp", default="raw.jsonl",
                    help="Raw JSONL from cedar_ontology_usage.py --emit-constraints (default raw.jsonl).")
    ap.add_argument("--out", help="Write the matrix as JSONL (one atom per line).")
    ap.add_argument("--tsv", help="Also write the matrix as a tab-separated table.")
    args = ap.parse_args()

    atoms = {}
    records = 0
    with open(args.inp) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            records += 1
            src = rec.get("source") or {}
            for kind, acr, target, entry in atoms_of_record(rec):
                a = atoms.get((kind, acr, target))
                if a is None:
                    a = Atom(kind, acr, target)
                    atoms[(kind, acr, target)] = a
                a.seen_in += 1
                if src.get("id"):
                    a.artifacts.add(src["id"])
                if entry.get("name"):
                    a.names.add(entry["name"])
                if kind == "branch" and entry.get("maxDepth") is not None:
                    a.max_depths.add(entry["maxDepth"])
                if entry.get("source"):
                    a.sources.add(entry["source"])
                if a.entry is None:
                    a.entry = entry
                    a.example = {"id": src.get("id"), "name": src.get("name"), "field": src.get("field")}

    rows = [atoms[k].row() for k in sorted(atoms)]

    if args.out:
        with open(args.out, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
    if args.tsv:
        with open(args.tsv, "w") as f:
            f.write("kind\tacronym\ttarget\tname\tmaxDepths\tseenIn\tnArtifacts\n")
            for r in rows:
                f.write("\t".join(str(x) for x in [
                    r["kind"], r["acronym"], r["target"] or "(whole)",
                    (r["name"] or "").replace("\t", " "),
                    ",".join(str(d) for d in (r["maxDepths"] or [])),
                    r["seenIn"], r["nArtifacts"]]) + "\n")

    # Coverage summary: ontology x kind (distinct target counts).
    grid = defaultdict(lambda: defaultdict(int))
    for r in rows:
        grid[r["acronym"]][r["kind"]] += 1
    kinds = ("ontology", "branch", "class", "valueSet")
    print(f"=== usage matrix from {records} field records ===")
    print(f"distinct atoms: {len(rows)}   ontologies: {len(grid)}")
    by_kind = defaultdict(int)
    for r in rows:
        by_kind[r["kind"]] += 1
    print("by kind: " + ", ".join(f"{k}={by_kind[k]}" for k in kinds))
    print(f"\ntop 25 ontologies by distinct targets:")
    print(f"  {'acronym':22} {'onto':>4} {'branch':>6} {'class':>6} {'vset':>5} {'total':>6}")
    ranked = sorted(grid.items(), key=lambda kv: -sum(kv[1].values()))
    for acr, g in ranked[:25]:
        tot = sum(g.values())
        print(f"  {acr:22} {g['ontology']:>4} {g['branch']:>6} {g['class']:>6} {g['valueSet']:>5} {tot:>6}")
    if args.out:
        print(f"\nmatrix (JSONL): {args.out}", file=sys.stderr)
    if args.tsv:
        print(f"matrix (TSV):   {args.tsv}", file=sys.stderr)


if __name__ == "__main__":
    main()
