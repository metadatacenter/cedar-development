#!/usr/bin/env python3
"""Latency and concurrency benchmark for the terminology server's lookup paths.

Query strings are drawn from the served index itself, so every lookup matches
something and the timings are of real work rather than of empty result sets. Run
it against a warm server, and not while anything else is using the stack: a
benchmark and the e2e smoke competing for one deployment reads as a regression in
whichever finishes second.

    python3 cedar_term_bench.py [repetitions]
"""
import json, os, sqlite3, statistics, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ.get("CEDAR_TERM_BASE", "http://localhost:9004")
STORE = os.environ.get("CEDAR_TERMINOLOGY_STORE_INDEX",
                       os.path.expanduser("~/CEDAR/cedar-term/prod/search-index.sqlite"))

# A size ladder drawn from the store: term counts span four orders of magnitude.
ONTS = [("UO", 574), ("EDAM", 3539), ("DOID", 19578),
        ("MONDO", 36070), ("NCIT", 206860), ("NCBITAXON", 2854537)]


def post(path, body, timeout=300):
    req = urllib.request.Request(BASE + path, method="POST",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = r.read()
    return time.perf_counter() - t, json.loads(payload)


def get(path, timeout=300):
    t = time.perf_counter()
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        payload = r.read()
    return time.perf_counter() - t, json.loads(payload)


def integrated(acronym, text, page_size=25):
    """The lookup the authoring UI performs for an ontology-constrained field."""
    return post("/bioportal/integrated-search", {
        "parameterObject": {
            "valueConstraints": {
                "ontologies": [{"uri": f"http://data.bioontology.org/ontologies/{acronym}",
                                "acronym": acronym, "numTerms": 0, "name": acronym}],
                "branches": [], "classes": [], "valueSets": []},
            "inputText": text},
        "page": 1, "pageSize": page_size})


def integrated_branch(acronym, branch_iri, text, page_size=25):
    return post("/bioportal/integrated-search", {
        "parameterObject": {
            "valueConstraints": {
                "ontologies": [],
                "branches": [{"source": acronym, "acronym": acronym, "uri": branch_iri,
                              "name": "branch", "maxDepth": 0}],
                "classes": [], "valueSets": []},
            "inputText": text},
        "page": 1, "pageSize": page_size})


def versioned(text, sources=None, page_size=25):
    body = {"query": text, "pageSize": page_size}
    if sources:
        body["sources"] = [{"sourceAcronym": a} for a in sources]
    return post("/search", body)


def stats(xs):
    xs = sorted(xs)
    n = len(xs)
    q = lambda p: xs[min(n - 1, int(round(p * (n - 1))))]
    return dict(n=n, p50=q(.50), p90=q(.90), p99=q(.99), mn=xs[0], mx=xs[-1],
                mean=statistics.fmean(xs))


def row(label, s, extra=""):
    print("  %-42s p50 %7.1f  p90 %7.1f  p99 %7.1f  max %7.1f ms   %s"
          % (label, s["p50"] * 1e3, s["p90"] * 1e3, s["p99"] * 1e3, s["mx"] * 1e3, extra))


def sample_labels(conn, acronym, n, minlen=5):
    """Real preferred labels from this ontology, so the query has something to hit."""
    rows = conn.execute(
        "SELECT pref_label FROM term WHERE acronym=? AND pref_label IS NOT NULL "
        "AND LENGTH(pref_label) BETWEEN ? AND 40 LIMIT ?", (acronym, minlen, n * 4)).fetchall()
    return [r[0] for r in rows][:n]


def main():
    reps = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    conn = sqlite3.connect(STORE)

    print("\n=== A. Ontology-constrained lookup (integrated-search), exact labels")
    print("    the dominant production shape: one ontology, author has typed a full term\n")
    for acr, size in ONTS:
        labels = sample_labels(conn, acr, reps)
        if not labels:
            print("  %-42s (no labels sampled)" % acr); continue
        integrated(acr, labels[0])                       # warm
        ts = [integrated(acr, labels[i % len(labels)])[0] for i in range(reps)]
        row(f"{acr} ({size:,} terms)", stats(ts))

    print("\n=== B. Ontology-constrained lookup, prefix queries")
    print("    what the author is actually typing on the way to a term\n")
    for acr, size in [("DOID", 19578), ("NCIT", 206860), ("NCBITAXON", 2854537)]:
        for pfx in ["ce", "cell", "cellul"]:
            integrated(acr, pfx)
            ts = [integrated(acr, pfx)[0] for _ in range(reps)]
            row(f"{acr} ({size:,}) prefix {pfx!r}", stats(ts))

    print("\n=== C. Page size sweep (DOID, exact labels)\n")
    labels = sample_labels(conn, "DOID", reps)
    for ps in [10, 25, 50, 100]:
        integrated("DOID", labels[0], ps)
        ts = [integrated("DOID", labels[i % len(labels)], ps)[0] for i in range(reps)]
        row(f"pageSize={ps}", stats(ts))

    print("\n=== D. Versioned POST /search, source-scoped vs corpus-wide\n")
    for acr in ["DOID", "NCIT"]:
        labels = sample_labels(conn, acr, reps)
        versioned(labels[0], [acr])
        ts = [versioned(labels[i % len(labels)], [acr])[0] for i in range(reps)]
        row(f"scoped to {acr}", stats(ts))
    for q in ["melanoma", "disease", "cell", "ce"]:
        versioned(q)
        ts = [versioned(q)[0] for _ in range(max(3, reps // 6))]
        row(f"corpus-wide {q!r}", stats(ts))

    conn.close()


if __name__ == "__main__":
    main()
