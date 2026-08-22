#!/usr/bin/env bash
#
# harvest-ols-ingest.sh — bulk-ingest ontologies from EBI OLS into the local snapshot store,
# in one command. OLS is a discovery catalogue (it does not host files); this reads each ontology's
# config.fileLocation and ingests it through `IngestJob --source url`.
#
# Re-runnable: identity is the content hash and the catalog upserts, so re-ingesting is idempotent;
# acronyms already in the catalog are skipped for speed (use --refresh-list to re-pull the OLS list,
# --reingest to force). Per-ontology failures (404 / SSL / timeout / parse / owl:imports) are logged
# and skipped so one bad ontology never aborts the batch.
#
# Usage:
#   harvest-ols-ingest.sh <catalog.sqlite> <snapshotDir> [options]
# Options:
#   --max N           ingest at most N new ontologies (default: all)
#   --max-terms T     skip ontologies with more than T terms (default: 5000; keeps it fast/self-contained)
#   --timeout S       per-ontology wall-clock cap in seconds (default: 180)
#   --reingest        do not skip acronyms already present in the catalog
#   --refresh-list    re-download the OLS ontology list (otherwise a cached copy is reused)
#   --rebuild         force a Maven rebuild of the ingest module before harvesting
#
# Requires: Java 17, Maven, curl, python3, sqlite3, and the cedar-terminology-server repo checkout.
# The terminology server is found at $CEDAR_HOME/cedar-terminology-server, or ../../cedar-terminology-server
# relative to this script, or $TS_DIR if set.

set -uo pipefail

die() { echo "error: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: harvest-ols-ingest.sh <catalog.sqlite> <snapshotDir> [--max N] [--max-terms T] [--timeout S] [--reingest] [--refresh-list] [--rebuild]"
CATALOG=$1; SNAP=$2; shift 2

MAX=0; MAX_TERMS=5000; TIMEOUT=180; REINGEST=0; REFRESH=0; REBUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX=$2; shift 2;;
    --max-terms) MAX_TERMS=$2; shift 2;;
    --timeout) TIMEOUT=$2; shift 2;;
    --reingest) REINGEST=1; shift;;
    --refresh-list) REFRESH=1; shift;;
    --rebuild) REBUILD=1; shift;;
    *) die "unknown option: $1";;
  esac
done

# --- locate the terminology server + Java 17 ---
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TS_DIR=${TS_DIR:-${CEDAR_HOME:+$CEDAR_HOME/cedar-terminology-server}}
[ -n "${TS_DIR:-}" ] && [ -d "$TS_DIR" ] || TS_DIR="$SCRIPT_DIR/../../cedar-terminology-server"
[ -d "$TS_DIR/cedar-terminology-server-ingest" ] || die "cedar-terminology-server not found (set TS_DIR or CEDAR_HOME)"
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null)}

WORK="${TMPDIR:-/tmp}/ols-harvest"; mkdir -p "$WORK"
CP_FILE="$WORK/classpath.txt"; DEPS="$WORK/deps.txt"; LIST="$WORK/ols_ontologies.json"

# --- build the ingest classpath (once, unless --rebuild) ---
CLASSES="$TS_DIR/cedar-terminology-server-ingest/target/classes"
if [ "$REBUILD" = 1 ] || [ ! -d "$CLASSES" ] || [ ! -s "$DEPS" ]; then
  echo "building ingest module + classpath ..." >&2
  ( cd "$TS_DIR" && mvn -q -pl cedar-terminology-server-ingest -am install -DskipTests \
      && mvn -q -pl cedar-terminology-server-ingest dependency:build-classpath -Dmdep.outputFile="$DEPS" ) \
    || die "maven build failed"
fi
CP="$CLASSES:$(cat "$DEPS")"

# --- fetch the OLS ontology list (cached unless --refresh-list) ---
if [ "$REFRESH" = 1 ] || [ ! -s "$LIST" ]; then
  echo "fetching OLS ontology list ..." >&2
  curl -s -m 120 "https://www.ebi.ac.uk/ols4/api/ontologies?size=1000" -o "$LIST" || die "OLS list fetch failed"
fi

mkdir -p "$SNAP"

# --- select candidates: http fileLocation, terms <= max-terms, not already ingested (unless --reingest) ---
CANDS="$WORK/candidates.tsv"
python3 - "$LIST" "$CATALOG" "$MAX_TERMS" "$REINGEST" "$MAX" > "$CANDS" <<'PY'
import sys, json, sqlite3
listp, cat, maxterms, reingest, maxn = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]=="1", int(sys.argv[5])
have=set()
if not reingest:
    try:
        c=sqlite3.connect(cat); have={r[0].upper() for r in c.execute("SELECT DISTINCT acronym FROM snapshot")}; c.close()
    except Exception: pass
d=json.load(open(listp))
onts=d.get("_embedded",{}).get("ontologies", d if isinstance(d,list) else [])
rows=[]
for o in onts:
    cfg=o.get("config",{}) or {}
    fl=cfg.get("fileLocation") or ""
    oid=(o.get("ontologyId") or cfg.get("preferredPrefix") or "").upper()
    terms=o.get("numberOfTerms") or 0
    if not fl.startswith("http") or not oid or oid in have: continue
    if maxterms and terms and terms>maxterms: continue
    fmt="SKOS" if cfg.get("isSkos") else "OWL"
    rows.append((oid, fl, fmt, terms))
rows.sort(key=lambda r: r[3] or 999999)   # smallest first
if maxn: rows=rows[:maxn]
for oid,fl,fmt,terms in rows:
    print(f"{oid}\t{fl}\t{fmt}\t{terms}")
PY

TOTAL=$(wc -l < "$CANDS" | tr -d ' ')
echo "candidates: $TOTAL new ontologies (max-terms=$MAX_TERMS, timeout=${TIMEOUT}s)" >&2
[ "$TOTAL" -gt 0 ] || { echo "nothing to ingest."; exit 0; }

run_to(){ local s=$1; shift; "$@" >"$WORK/.o" 2>"$WORK/.e" & local p=$!; ( sleep "$s"; kill -9 "$p" 2>/dev/null )& local k=$!; wait "$p" 2>/dev/null; local rc=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; return $rc; }

ok=0; fail=0; n=0
while IFS=$'\t' read -r ACR URL FMT TERMS; do
  n=$((n+1))
  run_to "$TIMEOUT" java -Xmx4g -cp "$CP" org.metadatacenter.terms.ingest.IngestJob \
      "$CATALOG" "$SNAP" --source url --url "$URL" --format "$FMT" --backend ols "$ACR"
  if grep -qE "classes" "$WORK/.o"; then
    cls=$(grep -E classes "$WORK/.o" | head -1 | grep -oE "[0-9]+ classes" | grep -oE "^[0-9]+")
    ok=$((ok+1)); printf "[%3d/%d] OK   %-14s %6s cls\n" "$n" "$TOTAL" "$ACR" "$cls"
  else
    fail=$((fail+1)); why=$(grep -vE SLF4J "$WORK/.e" | grep -iE "HTTP|Exception|Error|timed" | head -1 | cut -c1-60)
    printf "[%3d/%d] FAIL %-14s %s\n" "$n" "$TOTAL" "$ACR" "${why:-killed/timeout}"
  fi
done < "$CANDS"

echo "-------------------------------------------------------------"
echo "harvest done: $ok ingested, $fail failed of $TOTAL attempted"
sqlite3 "$CATALOG" "SELECT 'catalog now: '||COUNT(DISTINCT acronym)||' ontologies, '||COUNT(*)||' snapshots, '||COUNT(DISTINCT version_id)||' distinct content hashes' FROM snapshot;" 2>/dev/null
