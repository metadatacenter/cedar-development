#!/usr/bin/env python3
"""
gate_refine.py — re-evaluate the roots gate under a namespace-aware rule.

The raw roots gate (cedar_termdiff.py --roots) compares the full local root set to BioPortal's.
That flags two artifact-driven divergences that are not extraction defects:
  * SUPERSET  — we root imported upper-ontology stubs (bare subClassOf owl:Thing) that BioPortal
                resolves away; our extra roots are in FOREIGN namespaces.
  * FOREIGN-on-BP — BioPortal roots external/meta vocabulary (RDF/FOAF/DC/SKOS/imported IDspaces)
                that we correctly exclude; its extra roots are in FOREIGN namespaces.

This post-processor recomputes readiness comparing only each ontology's OWN-namespace roots on both
sides. "Own namespace" is the set of IRI ID-spaces that dominate the ontology's concepts (frequency
weighted), so a lone imported root (e.g. PO's obo/NCBITaxon_1, NIFSTD's obo/OMIM_000000) is treated
as foreign, while a genuinely-missing own class (BTO-EMMO's EMMO_*, NDDO's NDDO_*) still counts and
still fails the gate. Reads the goldens + local snapshots already on disk; no server, no re-record.
"""
import json, os, glob, sqlite3, re, collections, sys

CAT = os.environ["CEDAR_TERMINOLOGY_STORE_CATALOG"]; BASE = os.path.dirname(CAT)
G = "/Users/martin/tmp/cedar-term/gate-all"
REPORT = json.load(open(f"{G}/gate_roots_all.json"))
OLD_READY = set(REPORT["ready"]); GATED = list(REPORT["ontologies"])
LABEL_THRESHOLD = 0.98
cc = sqlite3.connect(CAT).cursor()

def idspace(iri):
    """The ID-space prefix of an IRI. OBO IDs collapse to .../obo/<PREFIX>_ (so PO_ and NCBITaxon_
    are distinct even though both sit under .../obo/); otherwise the namespace up to # or last /."""
    m = re.match(r'(.*/obo/)([A-Za-z][A-Za-z0-9]*)_', iri)
    if m: return m.group(1) + m.group(2) + "_"
    if '#' in iri: return iri.rsplit('#', 1)[0] + '#'
    return iri.rsplit('/', 1)[0] + '/'

def snap_path(a):
    r = cc.execute("SELECT s.file_path FROM version_tag t JOIN snapshot s ON s.version_id=t.version_id "
                   "AND s.acronym=t.acronym WHERE t.tag='latest' AND s.acronym=?", (a,)).fetchone()
    return os.path.join(BASE, r[0]) if r else None

def own_spaces(acr, concept_iris):
    """The ontology's OWN ID-spaces, keyed to its acronym — NOT to frequency, because an
    import-heavy ontology's concepts are mostly imported (CL is 40% GO_, 26% UBERON_, only 19%
    its own CL_). For OBO the own space is .../obo/<ACRONYM>_ (CL->CL_, UBERON->UBERON_); for
    others it's an ID-space whose host/path carries an acronym token. Falls back to the single
    dominant space only when the acronym matches nothing (keeps odd non-OBO ontologies gate-able)."""
    toks = {t.upper() for t in re.split(r'[^A-Za-z0-9]+', acr) if t}
    spaces = collections.Counter(idspace(i) for i in concept_iris)
    own = set()
    for sp in spaces:
        m = re.match(r'.*/obo/([A-Za-z][A-Za-z0-9]*)_$', sp)
        if m:
            if m.group(1).upper() in toks: own.add(sp)          # exact OBO ID-prefix == acronym token
        elif any(t in sp.upper() for t in toks if len(t) >= 3):  # non-OBO: token in the namespace
            own.add(sp)
    if not own and spaces:
        own.add(spaces.most_common(1)[0][0])
    return own

results = {}
for a in GATED:
    fs = glob.glob(f"{G}/goldens_roots/{a.replace('/', '_')}/*.json")
    sp = snap_path(a)
    if not fs or not sp or not os.path.exists(sp):
        continue
    gold = json.load(open(fs[0])); bp_roots = set(gold["resultIds"])
    con = sqlite3.connect(sp); c = con.cursor()
    concepts = [r[0] for r in c.execute("SELECT iri FROM concept")]
    local_roots = set(r[0] for r in c.execute(
        "SELECT ci.iri FROM root r JOIN concept ci ON ci.id=r.concept_id"))
    con.close()
    own = own_spaces(a, concepts)
    bp_own = {i for i in bp_roots if idspace(i) in own}
    lo_own = {i for i in local_roots if idspace(i) in own}
    set_equal = (bp_own == lo_own)
    # Labels: carry forward the RAW gate's served-label verdict (its labels come from the same HTTP
    # path on both sides). Recomputing from the snapshot's pref_label is unfaithful — the server
    # applies English-label preference, so it wrongly fails exact matches. The refinement only
    # changes which roots are compared (set membership), not how labels are judged.
    raw = REPORT["ontologies"][a]
    label_ok_raw = (not raw["errors"]) and (raw["labelAgreement"] >= LABEL_THRESHOLD)
    ready = set_equal and label_ok_raw and not raw["errors"]
    results[a] = dict(ready=ready, set_equal=set_equal, label_ok_raw=label_ok_raw,
                      bp_own=len(bp_own), lo_own=len(lo_own),
                      bp_only=sorted(bp_own - lo_own)[:5], lo_only=sorted(lo_own - bp_own)[:5])

new_ready = {a for a, d in results.items() if d["ready"]}
print(f"gated (with snapshot+golden): {len(results)}")
print(f"OLD ready (raw rule)        : {len(OLD_READY)}")
print(f"NEW ready (own-namespace)   : {len(new_ready)}")
print(f"  newly graduated           : {len(new_ready - OLD_READY)}")
print(f"  dropped (was ready, now not): {sorted(OLD_READY - new_ready)}")
print()
print("SANITY on known cases:")
for a in ["BTO-EMMO", "NDDO", "PO", "NIFSTD", "CL", "UBERON", "DOID", "OBI"]:
    if a in results:
        d = results[a]
        print(f"  {a:10} ready={d['ready']!s:5} own(bp/local)={d['bp_own']}/{d['lo_own']} "
              f"bp_only={d['bp_only']} local_only={d['lo_only']}")
json.dump({"newReady": sorted(new_ready), "oldReady": sorted(OLD_READY), "perOntology": results},
          open(f"{G}/gate_roots_refined.json", "w"), indent=1)
print(f"\nwrote {G}/gate_roots_refined.json")
