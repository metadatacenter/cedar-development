#!/usr/bin/env python3
"""
cedar_termdiff.py — differential test harness for the terminology server's integrated-search.

Replays the atomic-target usage matrix (cedar_usage_matrix.py) against the terminology server's
`POST /bioportal/integrated-search` endpoint and compares a local, SQLite-backed answer to a
BioPortal answer. Both answers are obtained through the SAME endpoint on two differently-configured
server instances, so the response shape is identical and the comparison is apples-to-apples.

BioPortal is slow and drifts, so this is record-then-replay:

  record  Hit a BioPortal-backed instance once and snapshot each atom's result set as a golden.
          Resumable and partial-safe: one file per atom under <goldens>/<ACRONYM>/, already-recorded
          atoms are skipped, a failed/timed-out atom is logged and left unrecorded (retry later).

  verify  Hit a local-store instance (allowlisted ontologies, terminologyStore.localOnly=true) and
          compare each atom to its golden, then emit a per-ontology readiness report — the signal for
          when an ontology is safe to add to the allowlist.

Equivalence bar (first increment, inputText=""): SET-EQUALITY on result IRIs (@id), plus prefLabel
agreement on the shared IRIs. Ordering and BioPortal's extra metadata (synonyms, definitions,
provenance) are ignored — the SQLite snapshot holds hierarchy + preferred labels, so those are the
comparable dimensions. Ranked prefix-search recall is a later bar; this increment enumerates the
constrained value set (empty inputText) where set-equality is the right, unambiguous invariant.

Only stdlib. Examples:
  # 1) record goldens from a BioPortal-backed instance (the slow, standalone run)
  python3 cedar_termdiff.py record --matrix matrix.jsonl --goldens goldens \
      --server https://terminology.metadatacenter.org --ontology DOID GO HP

  # 2) verify a local-store instance against those goldens
  python3 cedar_termdiff.py verify --matrix matrix.jsonl --goldens goldens \
      --server http://localhost:9004 --ontology DOID GO HP --report readiness.json
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

SEARCH_PATH = "/bioportal/integrated-search"


def atom_id(atom, input_text):
    """Stable short id for an atom + input text (the golden's filename stem)."""
    key = json.dumps([atom["kind"], atom["acronym"], atom["target"], input_text], sort_keys=True)
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def post_search(server, value_constraints, input_text, page, page_size, api_key, timeout):
    """POST one page of integrated-search; return the parsed PagedResults dict."""
    body = json.dumps({
        "parameterObject": {"valueConstraints": value_constraints, "inputText": input_text},
        "page": page, "pageSize": page_size,
    }).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"apikey {api_key}"
    req = urllib.request.Request(server.rstrip("/") + SEARCH_PATH, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def fetch_all(server, value_constraints, input_text, probe_size, max_results, api_key, timeout, retries):
    """Fetch the complete result set in a single sized request; return (ids, {id: prefLabel},
    total, truncated).

    The endpoint's pagination is unusable for browse: `page`/`nextPage` are inert (every page
    returns the first `pageSize` rows), but a request with `pageSize >= totalCount` returns the whole
    set at once. So probe once to learn `totalCount`, then, if needed, refetch sized to it (capped at
    `max_results`; a larger set is marked truncated and must not be used for set-equality)."""
    def req(page_size):
        for attempt in range(retries):
            try:
                return post_search(server, value_constraints, input_text, 1, page_size, api_key, timeout)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
                if attempt == retries - 1:
                    raise
                time.sleep(min(20, 2 ** attempt))

    data = req(probe_size)
    total = data.get("totalCount")
    coll = data.get("collection") or []
    truncated = total is not None and total > max_results
    if total is not None and len(coll) < total:
        want = min(total, max_results)
        if want > len(coll):
            try:
                coll = req(want).get("collection") or coll
            except urllib.error.HTTPError:
                # The endpoint caps pageSize (here ~5000); a larger request 400s. Keep the probe
                # results and mark the set incomplete rather than failing the atom outright.
                truncated = True

    ids, labels, seen = [], {}, set()
    for r in coll[:max_results]:
        rid = r.get("@id") or r.get("id")
        if rid and rid not in seen:
            seen.add(rid)
            ids.append(rid)
            if r.get("prefLabel") is not None:
                labels[rid] = r["prefLabel"]
    return ids, labels, total, truncated


def fetch_roots(server, acronym, api_key, timeout, retries):
    """GET an ontology's root classes — the tree entry point the template-editor picker opens after
    an ontology is selected. Returns the same (ids, {id: prefLabel}, total, truncated) shape as
    {@link fetch_all} so the same set-equality/label bar applies. Unlike integrated-search, this
    endpoint requires CEDAR auth, so api_key must be a CEDAR key (e.g. CEDAR_ADMIN_USER_API_KEY),
    not a bare BioPortal key."""
    url = server.rstrip("/") + "/bioportal/ontologies/" + urllib.parse.quote(acronym, safe="") + "/classes/roots"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"apiKey {api_key}"
    data = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
                data = json.load(resp)
            break
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
            if attempt == retries - 1:
                raise
            time.sleep(min(20, 2 ** attempt))
    coll = data.get("collection") if isinstance(data, dict) else data
    coll = coll or []
    ids, labels, seen = [], {}, set()
    for r in coll:
        rid = r.get("@id") or r.get("id")
        if rid and rid not in seen:
            seen.add(rid)
            ids.append(rid)
            if r.get("prefLabel") is not None:
                labels[rid] = r["prefLabel"]
    return ids, labels, len(ids), False


def fetch_for(server, atom, args):
    """Dispatch an atom to its endpoint: a synthetic roots atom to GET .../classes/roots, every other
    atom to the integrated-search enumerate path."""
    if atom.get("kind") == "roots":
        return fetch_roots(server, atom["acronym"], args.api_key, args.timeout, args.retries)
    return fetch_all(server, atom["valueConstraints"], args.input_text,
                     args.probe_size, args.max_results, args.api_key, args.timeout, args.retries)


def synth_roots_atoms(matrix_path, ontologies):
    """One synthetic {@code roots} atom per distinct ontology in the matrix (honoring --ontology). The
    picker's roots endpoint is per-ontology and is not itself a value-constraint target, so it is not
    in the matrix; this manufactures the atoms to gate it with the same record/verify machinery."""
    onto = set(ontologies) if ontologies else None
    seen, acrs = set(), []
    with open(matrix_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            acr = json.loads(line)["acronym"]
            if onto and acr not in onto:
                continue
            if acr not in seen:
                seen.add(acr)
                acrs.append(acr)
    return [{"kind": "roots", "acronym": a, "target": None, "name": None, "valueConstraints": None}
            for a in sorted(acrs)]


def load_atoms(matrix_path, ontologies, kinds, limit):
    onto = set(ontologies) if ontologies else None
    kset = set(kinds) if kinds else None
    out = []
    with open(matrix_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            a = json.loads(line)
            if onto and a["acronym"] not in onto:
                continue
            if kset and a["kind"] not in kset:
                continue
            out.append(a)
            if limit and len(out) >= limit:
                break
    return out


def golden_path(goldens, atom, aid):
    return os.path.join(goldens, atom["acronym"].replace("/", "_"), aid + ".json")


def cmd_record(args):
    atoms = synth_roots_atoms(args.matrix, args.ontology) if args.roots \
        else load_atoms(args.matrix, args.ontology, args.kinds, args.limit)
    print(f"record: {len(atoms)} atoms from {args.matrix} -> {args.goldens} (server {args.server})")
    recorded = skipped = failed = 0
    for i, atom in enumerate(atoms, 1):
        aid = atom_id(atom, args.input_text)
        gp = golden_path(args.goldens, atom, aid)
        if os.path.exists(gp) and not args.force:
            skipped += 1
            continue
        try:
            ids, labels, total, trunc = fetch_for(args.server, atom, args)
        except Exception as e:
            failed += 1
            print(f"  ! [{i}/{len(atoms)}] {atom['acronym']:14} {atom['kind']:8} FAILED: {type(e).__name__}: {e}",
                  file=sys.stderr)
            continue
        os.makedirs(os.path.dirname(gp), exist_ok=True)
        with open(gp, "w") as f:
            json.dump({
                "atom": {k: atom[k] for k in ("kind", "acronym", "target", "name")},
                "inputText": args.input_text,
                "valueConstraints": atom["valueConstraints"],
                "resultIds": ids, "labels": labels,
                "totalCount": total, "truncated": trunc,
                "server": args.server, "capturedAt": datetime.now(timezone.utc).isoformat(),
            }, f)
        recorded += 1
        if recorded % 20 == 0 or trunc:
            print(f"  [{i}/{len(atoms)}] {atom['acronym']:14} {atom['kind']:8} "
                  f"{len(ids)} results{' (TRUNCATED)' if trunc else ''}", file=sys.stderr)
    print(f"record done: {recorded} recorded, {skipped} skipped (already present), {failed} failed")


_WS = re.compile(r"\s+")


def norm_label(s):
    """Normalize a label for agreement testing: trim, collapse internal whitespace, casefold. This
    makes cosmetic differences (case, spacing) agree, so a residual mismatch is substantive — most
    often a different language (BioPortal serves the English prefLabel; a snapshot that captured the
    ontology's Japanese or French prefLabel will diverge here)."""
    if s is None:
        return None
    return _WS.sub(" ", s.strip()).casefold()


def compare(golden_ids, golden_labels, local_ids, local_labels):
    """The equivalence bar: set-equality on IRIs, plus prefLabel agreement on the shared IRIs. Label
    agreement is judged after {@link norm_label} normalization, and reported as a ratio the caller
    gates on; the returned {@code labelMismatch} list holds the substantive (post-normalization)
    disagreements only."""
    g, l = set(golden_ids), set(local_ids)
    missing = sorted(g - l)      # in BioPortal golden, absent locally
    extra = sorted(l - g)        # present locally, not in golden
    shared = g & l
    label_shared = 0
    label_mismatch = []
    for rid in sorted(shared):
        gl, ll = golden_labels.get(rid), local_labels.get(rid)
        if gl is None or ll is None:
            continue
        label_shared += 1
        if norm_label(gl) != norm_label(ll):
            label_mismatch.append({"id": rid, "golden": gl, "local": ll})
    return {
        "goldenCount": len(g), "localCount": len(l),
        "missing": missing, "extra": extra,
        "labelShared": label_shared,
        "labelMismatch": label_mismatch,
        "setEqual": not missing and not extra,
    }


def cmd_verify(args):
    source = synth_roots_atoms(args.matrix, args.ontology) if args.roots \
        else load_atoms(args.matrix, args.ontology, args.kinds, None)
    atoms = {atom_id(a, args.input_text): a for a in source}
    per_onto = defaultdict(lambda: {"total": 0, "setEqual": 0, "labelClean": 0,
                                    "labelShared": 0, "labelAgree": 0,
                                    "truncated": 0, "mismatch": [], "errors": []})
    checked = 0
    for aid, atom in atoms.items():
        gp = golden_path(args.goldens, atom, aid)
        if not os.path.exists(gp):
            continue
        with open(gp) as f:
            golden = json.load(f)
        acr = atom["acronym"]
        stats = per_onto[acr]
        stats["total"] += 1
        if golden.get("truncated"):
            # The golden itself is incomplete (result set exceeded the cap); set-equality is
            # meaningless. Count it out of the gate rather than scoring a spurious mismatch.
            stats["truncated"] += 1
            continue
        try:
            ids, labels, _total, _trunc = fetch_for(args.server, atom, args)
        except Exception as e:
            stats["errors"].append({"atom": atom["target"] or "(whole)", "error": f"{type(e).__name__}: {e}"})
            continue
        c = compare(golden["resultIds"], golden.get("labels", {}), ids, labels)
        checked += 1
        stats["labelShared"] += c["labelShared"]
        stats["labelAgree"] += c["labelShared"] - len(c["labelMismatch"])
        if c["setEqual"]:
            stats["setEqual"] += 1
            if not c["labelMismatch"]:
                stats["labelClean"] += 1
        if not c["setEqual"] or c["labelMismatch"]:
            stats["mismatch"].append({
                "kind": atom["kind"], "target": atom["target"] or "(whole)",
                "goldenCount": c["goldenCount"], "localCount": c["localCount"],
                "missing": len(c["missing"]), "extra": len(c["extra"]),
                "labelMismatch": len(c["labelMismatch"]),
                "sampleMissing": c["missing"][:5], "sampleExtra": c["extra"][:5],
            })

    print(f"\n=== readiness report ({checked} atoms verified against goldens; server {args.server}; "
          f"label bar {args.label_threshold:.0%}) ===\n")
    print(f"  {'ontology':20} {'atoms':>6} {'gated':>6} {'setEqual':>9} {'label%':>7} "
          f"{'trunc':>6} {'errors':>7}   {'ready?':>6}")
    ready = []
    label_fails = []
    for acr in sorted(per_onto, key=lambda a: -per_onto[a]["total"]):
        s = per_onto[acr]
        gated = s["total"] - s["truncated"]        # atoms the set-equality bar actually judges
        s["labelAgreement"] = (s["labelAgree"] / s["labelShared"]) if s["labelShared"] else 1.0
        set_ok = gated > 0 and s["setEqual"] == gated and not s["errors"]
        label_ok = s["labelAgreement"] >= args.label_threshold
        ok = set_ok and label_ok
        if ok:
            ready.append(acr)
        elif set_ok and not label_ok:
            # Set-equal, so the hierarchy is right; only the labels diverge (usually a language
            # mismatch). Called out separately: it is a snapshot-fidelity fix, not a coverage gap.
            label_fails.append((acr, s["labelAgreement"]))
        print(f"  {acr:20} {s['total']:>6} {gated:>6} {s['setEqual']:>9} {s['labelAgreement']:>6.0%} "
              f"{s['truncated']:>6} {len(s['errors']):>7}   {'YES' if ok else 'no':>6}")
    print(f"\nready to allowlist (set-equal, labels agree >= {args.label_threshold:.0%}, no errors): "
          f"{', '.join(ready) if ready else '(none)'}")
    if label_fails:
        print(f"\nset-equal but below the label bar (hierarchy correct, labels diverge — likely a "
              f"language/prefLabel fidelity fix, not a coverage gap):")
        for acr, la in sorted(label_fails, key=lambda x: x[1]):
            print(f"  {acr:20} labels agree {la:.0%}")

    if args.report:
        with open(args.report, "w") as f:
            json.dump({"server": args.server, "inputText": args.input_text,
                       "labelThreshold": args.label_threshold,
                       "ontologies": per_onto, "ready": ready,
                       "labelBarFailures": [a for a, _ in label_fails]}, f, indent=1)
        print(f"\nfull report: {args.report}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="Differential test harness for integrated-search (local vs BioPortal).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("record", "verify"):
        p = sub.add_parser(name)
        p.add_argument("--matrix", default="matrix.jsonl", help="Atomic-target matrix JSONL (cedar_usage_matrix.py).")
        p.add_argument("--goldens", default="goldens", help="Goldens directory.")
        p.add_argument("--server", required=True, help="Terminology server base URL.")
        p.add_argument("--ontology", nargs="*", help="Restrict to these acronyms.")
        p.add_argument("--kinds", nargs="*", help="Restrict to these kinds (ontology/branch/class/valueSet).")
        p.add_argument("--input-text", default="", help='inputText to send (default "" = enumerate).')
        p.add_argument("--probe-size", type=int, default=1000,
                       help="pageSize of the initial probe; covers most branches in one request.")
        p.add_argument("--max-results", type=int, default=5000,
                       help="Cap on the fetched result set AND the largest pageSize requested (the "
                            "endpoint 400s above ~5000). A larger result set is marked truncated and "
                            "excluded from the set-equality gate (browse enumeration is not the right "
                            "bar for whole ontologies / very large branches).")
        p.add_argument("--timeout", type=float, default=120, help="Per-request timeout seconds (BioPortal is slow).")
        p.add_argument("--retries", type=int, default=3)
        p.add_argument("--api-key", default=os.environ.get("CEDAR_API_KEY"), help="Optional apikey header.")
        p.add_argument("--roots", action="store_true",
                       help="Gate the per-ontology roots endpoint (GET .../classes/roots) instead of the "
                            "matrix's integrated-search atoms — one synthetic roots atom per ontology. "
                            "Requires --api-key to be a CEDAR key (roots needs CEDAR auth).")
        if name == "record":
            p.add_argument("--limit", type=int)
            p.add_argument("--force", action="store_true", help="Re-record atoms that already have a golden.")
        if name == "verify":
            p.add_argument("--report", help="Write the full per-ontology report as JSON.")
            p.add_argument("--label-threshold", type=float, default=0.98,
                           help="Fraction of shared-IRI labels that must agree (after whitespace/case "
                                "normalization) for an ontology to pass. Below this it is reported as a "
                                "label-bar failure, not allowlist-ready. Default 0.98.")
    args = ap.parse_args()
    (cmd_record if args.cmd == "record" else cmd_verify)(args)


if __name__ == "__main__":
    main()
