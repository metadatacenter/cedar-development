#!/usr/bin/env python3
"""
rederive_browse.py — recompute the browse (roots) allowlist from the PRUNED snapshots.

After dead-end import roots are pruned (SnapshotStore.pruneDeadEndImportRoots), an ontology is
browse-ready when its local root set misses no GENUINE BioPortal root — one in the ontology's own
namespace and labeled by BioPortal. Being cleaner than BioPortal (fewer junk/foreign roots, or extra
unlabeled entry points that lead to content) is acceptable under the chosen philosophy; dropping a
real own-content root is not. Labels must agree on the shared roots. Reads goldens + the (pruned)
snapshots on disk; no server, no re-record. Emits the new allowlist and a breakdown.
"""
import json, glob, sqlite3, os, re, collections, sys

CAT = os.environ["CEDAR_TERMINOLOGY_STORE_CATALOG"]; BASE = os.path.dirname(CAT)
G = os.path.join(os.path.dirname(BASE), "gate-all")
rep = json.load(open(f"{G}/gate_roots_all.json")); per = rep["ontologies"]; THR = rep["labelThreshold"]
import os as _os
cur_live = set(filter(None, _os.environ.get("CEDAR_TERMINOLOGY_LOCAL_ROOTS_ONTOLOGIES","").split(",")))
cc = sqlite3.connect(CAT).cursor()

def idspace(iri):
    m = re.match(r'(.*/obo/)([A-Za-z][A-Za-z0-9]*)_', iri)
    return (m.group(1)+m.group(2)+"_") if m else ((iri.rsplit('#',1)[0]+'#') if '#' in iri else iri.rsplit('/',1)[0]+'/')
def snap(a):
    r = cc.execute("SELECT s.file_path FROM version_tag t JOIN snapshot s ON s.version_id=t.version_id AND s.acronym=t.acronym WHERE t.tag='latest' AND s.acronym=?",(a,)).fetchone()
    return os.path.join(BASE, r[0]) if r else None
def norm(x): return re.sub(r'\s+',' ',(x or '').strip()).casefold()
# Common imported / upper-reference ontologies and meta vocabularies. Only consulted in the
# frequency fallback below (when the acronym matches no namespace), to avoid mistaking imported
# content for the ontology's own — an import-heavy ontology can be mostly imported classes
# (NIF-Dysfunction is 34% GO / 31% PATO / 18% UBERON; its own nifstd namespace only 4%).
IMPORT_OBO = {"BFO","RO","IAO","BSPO","GO","CHEBI","PATO","NCBITAXON","PR","UBERON","CL","SO",
              "ENVO","GAZ","OGMS","COB","OMIM","CARO","OBA","UO","NBO","MOP","CHMO"}
IMPORT_HOST = ("w3.org","xmlns.com/foaf","purl.org/dc","skos/core","/2006/time","w3.org/ns/prov",
               "schema.org","ontology/bibo")
def _is_import_space(sp):
    m = re.match(r'.*/obo/([A-Za-z][A-Za-z0-9]*)_$', sp)
    if m and m.group(1).upper() in IMPORT_OBO:
        return True
    up = sp.upper()
    return any(h.upper() in up for h in IMPORT_HOST)

def own_spaces(acr, iris):
    toks = {t.upper() for t in re.split(r'[^A-Za-z0-9]+', acr) if t}
    sp = collections.Counter(idspace(i) for i in iris); own = set()
    for s in sp:
        m = re.match(r'.*/obo/([A-Za-z][A-Za-z0-9]*)_$', s)
        if m:
            if m.group(1).upper() in toks: own.add(s)
        elif any(t in s.upper() for t in toks if len(t) >= 3): own.add(s)
    if not own and sp:
        # Acronym matched nothing: fall back to the dominant namespace AMONG NON-IMPORTS, so a
        # mostly-imported ontology's own (minority) namespace is not overridden by an import.
        non_import = [s for s in sp if not _is_import_space(s)]
        pool = non_import if non_import else list(sp)
        own.add(max(pool, key=lambda s: sp[s]))
    return own

ready, real_gap_out, label_fail, empty = [], [], [], []
for a in per:
    fs = glob.glob(f"{G}/goldens_roots/{a.replace('/','_')}/*.json"); sp = snap(a)
    if not fs or not sp or not os.path.exists(sp) or per[a]["errors"]:
        continue
    g = json.load(open(fs[0])); bp = set(g["resultIds"]); bplab = g["labels"]
    c = sqlite3.connect(sp).cursor()
    iris = [r[0] for r in c.execute("SELECT iri FROM concept")]
    own = own_spaces(a, iris)
    local = {r[0]: r[1] for r in c.execute("SELECT ci.iri, ci.pref_label FROM root r JOIN concept ci ON ci.id=r.concept_id")}
    L = set(local)
    if not L:
        empty.append(a); continue
    genuine_bp = {i for i in bp if idspace(i) in own and norm(bplab.get(i))}  # own-namespace + labeled
    # A real gap is a genuine BioPortal root ABSENT from our snapshot — content we lack. A genuine
    # BP root we hold but don't root (because we captured a subClassOf parent BioPortal missed) is
    # NOT a gap: the class is present and reachable under its parent, and our tree is more correct.
    # Triage (2026-07-29) verified this against source for JFO/BCO/ICF/COSTART/O3.
    concept_iris = set(iris)
    real_gap = {i for i in genuine_bp if i not in concept_iris}
    shared = L & bp
    agree = sum(1 for i in shared if norm(bplab.get(i)) == norm(local.get(i)))
    label_ok = (not shared) or agree/len(shared) >= THR
    # Browse-readiness is STRUCTURAL: miss no genuine own-content root, have a non-empty tree. Label
    # form/language differences (issue #7) are tracked but do NOT exclude — they don't make the tree
    # wrong or cluttered, and gating on them was an artifact of the abandoned match-BioPortal bar.
    if real_gap:
        real_gap_out.append((a, len(real_gap)))
    else:
        ready.append(a)
        if not label_ok:
            label_fail.append(a)  # informational: served, but labels diverge from BioPortal

ready = sorted(ready)
open(f"{G}/browse-allowlist-rederived.txt", "w").write(",".join(ready))
newset = set(ready)
print(f"gated with pruned snapshot : {len(ready)+len(real_gap_out)+len(empty)}")
print(f"BROWSE-READY (re-derived)  : {len(ready)}")
print(f"  vs current live allowlist: {len(cur_live)}   (added {len(newset-cur_live)}, dropped {len(cur_live-newset)})")
print(f"excluded — real own-content gap : {len(real_gap_out)}  e.g. {[a for a,_ in real_gap_out[:8]]}")
print(f"excluded — empty root set        : {len(empty)}  e.g. {empty[:8]}")
print(f"included but labels diverge (issue #7, informational): {len(label_fail)}")
print(f"dropped from current live         : {sorted(cur_live-newset)[:12]}")
print()
print("SANITY:")
for a in ["CL","UBERON","DOID","OBI","ABD","BTO-EMMO","NDDO","G-PROV"]:
    print(f"  {a:10} ready={a in newset}")
