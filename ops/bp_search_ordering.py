#!/usr/bin/env python3
"""
bp_search_ordering.py — how BioPortal orders search hits, and whether a local
SQLite-backed store can reproduce that order from ontology metadata alone.

BioPortal scores with Solr edismax (ontologies_api/helpers/search_helper.rb):

  qf      resource_id^100 notation^100 oboId^100 prefLabelExact^90 prefLabel^70
          synonymExact^50 synonym^10 (+ definition, properties when requested)
  bq      idAcronymMatch:true^80
  boost   sum(ontologyRank,1)          <- multiplicative, so a [1,2] factor

ontologyRank is an ontology-level prior, not a per-term signal
(ontologies_linked_data Ontology.rank + ncbo_cron/ontology_rank.rb):

  rank = 0.50 * log10-normalised BioPortal page visits over a trailing 12 months
       + 0.50 * (1 if the ontology is in the UMLS group else 0)

computed by cron, cached in Redis, pushed into the term_search index by
RankSolrPropagator. None of this is in the /search API documentation.

The experiment replicates the field half from what /search returns (prefLabel,
synonym, matchType) and substitutes *locally derivable* ontology metadata for
ontologyRank: size, hierarchy depth, number of uploads, recency of uploads. The
candidate pool for each query is BioPortal's own result set, so recall is held
fixed and only the ordering function varies.

Three sections:
  models  per-term agreement of each ordering with BioPortal's, plus top-10 tables
  proxies corpus-wide correlation of each proxy with the real ontologyRank, and a
          grid search for the best weighting (the metadata-only ceiling)
  exact   the clean cut: within one query's exact-prefLabel group, where the field
          boosts are equal by construction, what predicts BioPortal's order

Needs CEDAR_BIOPORTAL_API_KEY (set-env-external.sh) and the local catalog. HTTP
responses are cached under <cache-dir>, so re-runs are offline and free.

  python3 ops/bp_search_ordering.py                       # all sections
  python3 ops/bp_search_ordering.py --section exact
  python3 ops/bp_search_ordering.py --terms melanoma,kidney --pool 100
"""
import argparse, itertools, json, math, os, re, sqlite3, sys, time
import urllib.parse, urllib.request

BASE = "https://data.bioontology.org"
DEFAULT_TERMS = ["melanoma", "diabetes mellitus", "kidney", "blood pressure",
                 "aspirin", "water", "temperature", "cell membrane"]
# trailing 12 complete months; ncbo_cron uses BP_VISITS_NUMBER_MONTHS = 12
WINDOW_END = (2026, 8)


def window(end=WINDOW_END, months=12):
    y, m = end
    out = []
    for _ in range(months):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append((y, m))
    return out


# ------------------------------------------------------------------ http + cache
class Api:
    def __init__(self, cache, apikey):
        self.cache, self.apikey = cache, apikey
        os.makedirs(cache, exist_ok=True)

    def get(self, path, **params):
        key = re.sub(r"[^A-Za-z0-9]+", "_", path + json.dumps(sorted(params.items())))[:180]
        fn = os.path.join(self.cache, key + ".json")
        if os.path.exists(fn):
            return json.load(open(fn))
        url = f"{BASE}{path}?" + urllib.parse.urlencode({**params, "apikey": self.apikey})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=180) as r:
                    d = json.load(r)
                break
            except Exception:                                     # noqa: BLE001
                if attempt == 2:
                    raise
                time.sleep(2 + 3 * attempt)
        json.dump(d, open(fn, "w"))
        return d


# ------------------------------------------------------- BioPortal ontologyRank
def ontology_rank(api):
    """Reconstruct ontologyRank the way ncbo_cron computes it."""
    analytics = api.get("/analytics")
    win = window()
    visits = {a: sum(y.get(str(yy), {}).get(str(mm), 0) for yy, mm in win)
              for a, y in analytics.items() if not a.startswith("@")}
    logs = {a: math.log10(v) if v > 0 else 0.0 for a, v in visits.items()}
    mx = max(logs.values()) or 1.0
    umls = {}
    for o in api.get("/ontologies", include="acronym,group"):
        umls[o["acronym"]] = 1.0 if any(
            "UMLS" in (g if isinstance(g, str) else g.get("@id", ""))
            for g in (o.get("group") or [])) else 0.0
    rank = {a: round(0.5 * logs[a] / mx + 0.5 * umls.get(a, 0.0), 3) for a in logs}
    return rank, visits, umls


def submissions(api, acr):
    subs = api.get(f"/ontologies/{acr}/submissions",
                   display="submissionId,released,creationDate")
    if not isinstance(subs, list):
        return {"n_submissions": 0, "newest": None}
    dates = [s.get("released") or s.get("creationDate") for s in subs if isinstance(s, dict)]
    dates = [d for d in dates if d]
    return {"n_submissions": len(subs), "newest": max(dates) if dates else None}


# ------------------------------------------------------------- local store facts
def catalog_facts(prod):
    con = sqlite3.connect(f"file:{os.path.join(prod, 'catalog.sqlite')}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    out = {}
    for r in con.execute("""
        SELECT s.acronym, s.class_count, s.edge_count, s.file_path,
               (SELECT COUNT(*) FROM snapshot s2 WHERE s2.acronym = s.acronym) AS n_snap,
               (SELECT MAX(COALESCE(s3.released_at, s3.ingested_at)) FROM snapshot s3
                 WHERE s3.acronym = s.acronym) AS newest
          FROM snapshot s
          JOIN version_tag v ON v.acronym = s.acronym AND v.version_id = s.version_id
         WHERE v.tag = 'latest'"""):
        out[r["acronym"].upper()] = dict(r)
    con.close()
    return out


def depth(prod, cache, acr, fact, sample=3000):
    """Depth proxy: median/p90 ancestor count over a strided concept sample."""
    fn = os.path.join(cache, f"depth_{acr}.json")
    if os.path.exists(fn):
        return json.load(open(fn))
    path = os.path.join(prod, fact["file_path"])
    if not path.endswith(".sqlite"):
        path += ".sqlite"
    if not os.path.exists(path):
        return {}
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    n = con.execute("SELECT COUNT(*) FROM concept").fetchone()[0]
    ids = [r[0] for r in con.execute("SELECT id FROM concept WHERE id % ? = 0 LIMIT ?",
                                     (max(1, n // sample), sample))]
    out = {"n_concepts": n, "sampled": len(ids)}
    if ids:
        qs = ",".join("?" * len(ids))
        counts = dict(con.execute(
            f"SELECT descendant_id, COUNT(*) FROM closure WHERE descendant_id IN ({qs})"
            " GROUP BY descendant_id", ids).fetchall())
        vals = sorted(counts.get(i, 0) for i in ids)
        out.update(median_ancestors=vals[len(vals) // 2],
                   p90_ancestors=vals[int(0.9 * (len(vals) - 1))],
                   mean_ancestors=round(sum(vals) / len(vals), 2))
    con.close()
    json.dump(out, open(fn, "w"))
    return out


# ------------------------------------------------------------------ field model
WS = re.compile(r"[^a-z0-9]+")


def norm(s):
    return WS.sub(" ", (s or "").lower()).strip()


def field_score(rec, q):
    """The qf half, approximated from the returned record and its matchType.
    Non-exact matches carry a 1/sqrt(tokens) factor standing in for Solr's fieldNorm."""
    qn, pl = norm(q), rec.get("prefLabel") or ""
    mt = rec.get("matchType") or ""
    syns = [s for s in (rec.get("synonym") or []) if isinstance(s, str)]
    ntok = lambda s: max(1, len(norm(s).split()))
    if mt == "prefLabel":
        return 90.0 if norm(pl) == qn else 70.0 / math.sqrt(ntok(pl))
    if mt == "synonym":
        if any(norm(s) == qn for s in syns):
            return 50.0
        return 10.0 / math.sqrt(min((ntok(s) for s in syns if qn in norm(s)), default=ntok(pl)))
    if mt == "definition":
        return 2.0
    return 5.0                                        # notation / oboId / id-acronym


# --------------------------------------------------------------------- statistics
def ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    out, i = [0.0] * len(v), 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return out


def spearman(a, b):
    n = len(a)
    if n < 2:
        return float("nan")
    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / n, sum(rb) / n
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return sum((x - ma) * (y - mb) for x, y in zip(ra, rb)) / den if den else float("nan")


def kendall(a, b):
    c = d = 0
    for i in range(len(a)):
        for j in range(i + 1, len(a)):
            s = (a[i] - a[j]) * (b[i] - b[j])
            c += s > 0
            d += s < 0
    return (c - d) / (c + d) if c + d else float("nan")


def months_old(iso, end=WINDOW_END):
    if not iso:
        return 240.0
    return max(0.0, (end[0] - int(iso[:4])) * 12 + (end[1] - int(iso[5:7])))


# ----------------------------------------------------------------------- driver
def build(api, args):
    rank, visits, umls = ontology_rank(api)
    cat = catalog_facts(args.prod)
    pools = {}
    for term in args.terms:
        recs, page = [], 1
        while len(recs) < args.pool:
            d = api.get("/search", q=term, pagesize=100, page=page)
            recs += d.get("collection", [])
            if not d.get("nextPage"):
                break
            page += 1
        for i, r in enumerate(recs[:args.pool]):
            r["_bp"] = i + 1
            r["_acr"] = ((r.get("links") or {}).get("ontology") or "").rsplit("/", 1)[-1]
        pools[term] = recs[:args.pool]

    acrs = sorted({r["_acr"] for p in pools.values() for r in p if r["_acr"]})
    prox = {}
    for a in acrs:
        f = cat.get(a.upper())
        sub = submissions(api, a)
        dep = depth(args.prod, api.cache, a.upper(), f) if f else {}
        prox[a] = {"in_catalog": bool(f),
                   "class_count": (f or {}).get("class_count"),
                   "edge_count": (f or {}).get("edge_count"),
                   "median_ancestors": dep.get("median_ancestors"),
                   "n_submissions": sub["n_submissions"],
                   "newest": sub["newest"] or (f or {}).get("newest"),
                   "bp_rank": rank.get(a, 0.0),
                   "visits_12mo": visits.get(a, 0),
                   "umls": umls.get(a, 0.0)}

    def lognorm(key):
        v = {a: math.log10(1 + (prox[a][key] or 0)) for a in acrs}
        mx = max(v.values()) or 1.0
        return {a: x / mx for a, x in v.items()}

    priors = {"size": lognorm("class_count"), "depth": lognorm("median_ancestors"),
              "uploads": lognorm("n_submissions"),
              "recency": {a: math.exp(-months_old(prox[a]["newest"]) / 36.0) for a in acrs}}
    return dict(rank=rank, visits=visits, umls=umls, cat=cat, pools=pools,
                acrs=acrs, prox=prox, priors=priors)


def agreement(ctx, terms, prior):
    """mean Spearman rho / Kendall tau / top-10 and top-20 overlap vs BioPortal order."""
    out = []
    for t in terms:
        pool = ctx["pools"][t]
        sc = [field_score(r, t) * (1 + prior(r["_acr"])) for r in pool]
        bpo = [r["_bp"] for r in pool]
        ordered = [x[0] for x in sorted(zip(pool, sc), key=lambda z: (-z[1], z[0]["@id"]))]
        mine = ranks([-s for s in sc])
        out.append((spearman(bpo, mine), kendall(bpo, mine),
                    len({r["@id"] for r in ordered[:10]} & {r["@id"] for r in pool[:10]}),
                    len({r["@id"] for r in ordered[:20]} & {r["@id"] for r in pool[:20]}),
                    ordered,
                    spearman(bpo[:10], mine[:10])))
    return out


def levenshtein(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def agreement_by_key(ctx, terms, keyfn):
    """Agreement for an ordering expressed as a sort key rather than a score."""
    out = []
    for t in terms:
        pool = ctx["pools"][t]
        keyed = sorted(range(len(pool)), key=lambda i: (keyfn(pool[i], t), pool[i]["@id"]))
        keys = [keyfn(r, t) for r in pool]
        distinct = sorted(set(keys))
        mine = ranks([distinct.index(k) for k in keys])
        bpo = [r["_bp"] for r in pool]
        ordered = [pool[i] for i in keyed]
        out.append((spearman(bpo, mine), kendall(bpo, mine),
                    len({r["@id"] for r in ordered[:10]} & {r["@id"] for r in pool[:10]}),
                    len({r["@id"] for r in ordered[:20]} & {r["@id"] for r in pool[:20]}),
                    ordered,
                    spearman(bpo[:10], mine[:10])))
    return out


def cedar_current_key(rec, term):
    """What the terminology server does today across sources: preferred labels that
    contain the query first, then Levenshtein distance to it (Util.sortByClosestMatch /
    SearchResultComparator). Synonym-blind and ontology-blind."""
    pl, q = (rec.get("prefLabel") or "").lower(), term.lower()
    return (0 if q in pl else 1, levenshtein(pl, q))


def section_models(ctx, args):
    P, prox = ctx["priors"], ctx["prox"]
    models = {
        "field only (no ontology prior)": lambda a: 0.0,
        "x real ontologyRank (BP's own)": lambda a: prox[a]["bp_rank"],
        "x size": lambda a: P["size"][a],
        "x depth": lambda a: P["depth"][a],
        "x uploads": lambda a: P["uploads"][a],
        "x recency": lambda a: P["recency"][a],
        "x all four (equal weights)": lambda a: sum(P[k][a] for k in P) / 4,
    }
    res = {n: agreement(ctx, args.terms, f) for n, f in models.items()}
    models["CEDAR today (contains + Levenshtein)"] = None
    res["CEDAR today (contains + Levenshtein)"] = agreement_by_key(
        ctx, args.terms, cedar_current_key)
    print("\n=== agreement with BioPortal's ordering, same candidate pool ===")
    for label, idx in (("Spearman rho", 0), ("top-10 overlap", 2)):
        print(f"\n-- {label}")
        print(f"{'model':38s}" + "".join(f"{t[:11]:>13s}" for t in args.terms))
        for n in models:
            print(f"{n:38s}" + "".join(
                (f"{r[idx]:13.3f}" if idx == 0 else f"{r[idx]:13d}") for r in res[n]))
    print(f"\n=== mean over {len(args.terms)} terms ===")
    print("   rho/tau: whole pool.  top10/top20: set overlap with BioPortal's.")
    print("   rho@10: order *within* BioPortal's top ten — what the user actually reads.")
    print(f"{'model':38s}{'rho':>8s}{'tau':>8s}{'top10':>8s}{'top20':>8s}{'rho@10':>9s}")
    for n in models:
        v = res[n]
        ok = [x[5] for x in v if x[5] == x[5]]
        print(f"{n:38s}" + "".join(f"{sum(x[i] for x in v)/len(v):8.3f}" for i in (0, 1))
              + "".join(f"{sum(x[i] for x in v)/len(v):8.1f}" for i in (2, 3))
              + f"{(sum(ok)/len(ok) if ok else float('nan')):9.3f}")

    print("\n=== top-10: BioPortal vs the four-proxy model ===")
    for t, r in zip(args.terms, res["x all four (equal weights)"]):
        print(f"\n-- {t}  (pool {len(ctx['pools'][t])})")
        print(f"   {'#':>2}  {'BioPortal':44s} {'proxy model':44s}")
        for i in range(min(10, len(r[4]))):
            b, m = ctx["pools"][t][i], r[4][i]
            left = f"{b['_acr']}:{(b.get('prefLabel') or '')[:26]}"
            right = f"{m['_acr']}:{(m.get('prefLabel') or '')[:20]} (bp#{m['_bp']})"
            print(f"   {i+1:>2}  {left:44s} {right:44s}")


def section_proxies(ctx, args):
    cat, rank, prox, P = ctx["cat"], ctx["rank"], ctx["prox"], ctx["priors"]
    common = [a for a in cat if a in rank]
    print(f"\n=== corpus-wide: {len(common)} acronyms in both the local catalog and BP analytics ===")
    base = [rank[a] for a in common]
    for label, f in (("log class_count", lambda a: math.log10(1 + (cat[a]["class_count"] or 0))),
                     ("log edge_count", lambda a: math.log10(1 + (cat[a]["edge_count"] or 0))),
                     ("recency (exp decay)", lambda a: math.exp(-months_old(cat[a]["newest"]) / 36.0)),
                     ("log local snapshots", lambda a: math.log10(1 + (cat[a]["n_snap"] or 0)))):
        print(f"  rho(ontologyRank, {label:22s}) = {spearman(base, [f(a) for a in common]):6.3f}")

    pooled = [a for a in ctx["acrs"] if prox[a]["in_catalog"]]
    print(f"\n=== the same, over the {len(pooled)} ontologies that actually compete in these queries ===")
    base = [prox[a]["bp_rank"] for a in pooled]
    for k in list(P) + ["visits", "umls"]:
        series = ([P[k][a] for a in pooled] if k in P else
                  [math.log10(1 + prox[a]["visits_12mo"]) for a in pooled] if k == "visits" else
                  [prox[a]["umls"] for a in pooled])
        print(f"  rho(ontologyRank, {k:22s}) = {spearman(base, series):6.3f}")

    print("\n=== grid search: best weighting of the four metadata proxies ===")
    best = []
    for w in itertools.product(range(5), repeat=4):
        if sum(w) != 4:
            continue
        ws = [x / 4 for x in w]
        pr = lambda a, ws=ws: sum(x * P[k][a] for x, k in zip(ws, P))
        v = agreement(ctx, args.terms, pr)
        best.append((sum(x[0] for x in v) / len(v), sum(x[2] for x in v) / len(v), ws))
    best.sort(reverse=True)
    print(f"  {'rho':>6s} {'top10':>6s}   " + " ".join(f"{k:>8s}" for k in P))
    for rho, o10, ws in best[:5]:
        print(f"  {rho:6.3f} {o10:6.1f}   " + " ".join(f"{x:8.2f}" for x in ws))
    print(f"  worst: {best[-1][0]:.3f} / {best[-1][1]:.1f} at " +
          ", ".join(f"{k}={x:.2f}" for k, x in zip(P, best[-1][2])))
    for label, pr in (("none (field only)", lambda a: 0.0),
                      ("real ontologyRank", lambda a: prox[a]["bp_rank"]),
                      ("best grid weighting",
                       lambda a: sum(x * P[k][a] for x, k in zip(best[0][2], P)))):
        v = agreement(ctx, args.terms, pr)
        print(f"  reference {label:22s} rho={sum(x[0] for x in v)/len(v):6.3f} "
              f"top10={sum(x[2] for x in v)/len(v):5.1f}")


def section_exact(ctx, args):
    prox, P = ctx["prox"], ctx["priors"]
    sig = {"real ontologyRank": lambda a: prox[a]["bp_rank"],
           "log visits (12mo)": lambda a: math.log10(1 + prox[a]["visits_12mo"]),
           "umls flag": lambda a: prox[a]["umls"],
           **{f"{k} (metadata)": (lambda a, k=k: P[k][a]) for k in P}}
    print("\n=== within one query's exact-prefLabel group (field boosts equal by construction) ===")
    print("    rho of BioPortal rank vs each signal; -1.000 = the signal predicts the order exactly\n")
    groups = {}
    for t in args.terms:
        qn = norm(t)
        groups[t] = [r for r in ctx["pools"][t]
                     if r.get("matchType") == "prefLabel"
                     and norm(r.get("prefLabel") or "") == qn and r["_acr"] in prox]
    print(f"{'group size':26s}" + "".join(f"{len(groups[t]):11d}" for t in args.terms))
    print(f"{'signal':26s}" + "".join(f"{t[:10]:>11s}" for t in args.terms) + f"{'mean':>9s}")
    for name, f in sig.items():
        vals = [spearman([r["_bp"] for r in groups[t]], [f(r["_acr"]) for r in groups[t]])
                for t in args.terms]
        ok = [v for v in vals if v == v]
        print(f"{name:26s}" + "".join(f"{v:11.3f}" for v in vals) +
              f"{(sum(ok)/len(ok) if ok else float('nan')):9.3f}")

    for t in args.terms[:args.show]:
        print(f"\n-- {t}: the group in BioPortal order")
        for r in groups[t][:12]:
            p = prox[r["_acr"]]
            print(f"   bp#{r['_bp']:>3}  {r['_acr']:14s} visits={p['visits_12mo']:>10,}"
                  f"  umls={int(p['umls'])}  classes={p['class_count'] if p['class_count'] is not None else '-':>9}"
                  f"  depth={p['median_ancestors'] if p['median_ancestors'] is not None else '-':>4}"
                  f"  uploads={p['n_submissions']:>4}  rank={p['bp_rank']:.3f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--section", choices=["all", "models", "proxies", "exact"], default="all")
    ap.add_argument("--terms", default=",".join(DEFAULT_TERMS))
    ap.add_argument("--pool", type=int, default=200)
    ap.add_argument("--show", type=int, default=4, help="terms to list group-by-group")
    ap.add_argument("--prod", default=os.path.join(os.environ.get("CEDAR_HOME", ""), "cedar-term/prod"))
    ap.add_argument("--cache-dir", default=os.path.join(os.path.expanduser("~"), ".cache/cedar-bp-ordering"))
    args = ap.parse_args()
    args.terms = [t.strip() for t in args.terms.split(",") if t.strip()]
    key = os.environ.get("CEDAR_BIOPORTAL_API_KEY")
    if not key:
        sys.exit("CEDAR_BIOPORTAL_API_KEY is not set (source set-env-external.sh)")
    ctx = build(Api(args.cache_dir, key), args)
    print(f"pool: {len(args.terms)} terms, {sum(len(p) for p in ctx['pools'].values())} results, "
          f"{len(ctx['acrs'])} ontologies "
          f"({sum(1 for a in ctx['acrs'] if ctx['prox'][a]['in_catalog'])} in the local catalog)")
    if args.section in ("all", "models"):
        section_models(ctx, args)
    if args.section in ("all", "proxies"):
        section_proxies(ctx, args)
    if args.section in ("all", "exact"):
        section_exact(ctx, args)


if __name__ == "__main__":
    main()
