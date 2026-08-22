#!/usr/bin/env bash
#
# harvest-obo-ingest.sh — ingest the current release of every active OBO Foundry ontology straight
# from its canonical PURL, refreshing the versions that lag BioPortal. Our OBO ontologies were all
# sourced from BioPortal (whose "latest submission" is often years behind the ontology's real
# release); this pulls the true current release from `http://purl.obolibrary.org/obo/<id>.owl`.
#
# Content-hash identity makes it safe and idempotent: a release that already matches an existing
# snapshot merges byte-for-byte (no duplicate); a newer OBO release adds a fresh snapshot and moves
# the `latest` tag. Each ontology is mapped to the acronym our catalog already uses for its canonical
# iri, so the update lands on the entry templates reference (not a parallel acronym).
#
# Usage:
#   harvest-obo-ingest.sh <catalog.sqlite> <snapshotDir> [options]
# Options:
#   --max N              ingest at most N ontologies (stalest first; default: all due)
#   --timeout S          per-ontology wall-clock cap in seconds (default: 1800 — some OBO OWL is GBs)
#   --skip-newer-days D  skip ontologies whose latest snapshot is within D days (default: 45 — already current)
#   --heap G             -Xmx for each ingest (default: 24g; the giants — NCBITaxon, PR, NCIT — need room)
#   --rebuild            force a Maven rebuild of the ingest module first
#
# Requires: Java 17, Maven, curl, python3, sqlite3, the cedar-terminology-server checkout, and
# BIOPORTAL_API_KEY is NOT needed (PURLs are public).

set -uo pipefail
die() { echo "error: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: harvest-obo-ingest.sh <catalog.sqlite> <snapshotDir> [--max N] [--timeout S] [--skip-newer-days D] [--heap G] [--rebuild]"
CATALOG=$1; SNAP=$2; shift 2
MAX=0; TIMEOUT=1800; SKIP_DAYS=45; HEAP=24g; REBUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX=$2; shift 2;;
    --timeout) TIMEOUT=$2; shift 2;;
    --skip-newer-days) SKIP_DAYS=$2; shift 2;;
    --heap) HEAP=$2; shift 2;;
    --rebuild) REBUILD=1; shift;;
    *) die "unknown option: $1";;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TS_DIR=${TS_DIR:-${CEDAR_HOME:+$CEDAR_HOME/cedar-terminology-server}}
[ -n "${TS_DIR:-}" ] && [ -d "$TS_DIR" ] || TS_DIR="$SCRIPT_DIR/../../cedar-terminology-server"
[ -d "$TS_DIR/cedar-terminology-server-ingest" ] || die "cedar-terminology-server not found (set TS_DIR or CEDAR_HOME)"
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null)}

WORK="${TMPDIR:-/tmp}/obo-harvest"; mkdir -p "$WORK"
DEPS="$WORK/deps.txt"; REG="$WORK/obofoundry.json"
CLASSES="$TS_DIR/cedar-terminology-server-ingest/target/classes"
if [ "$REBUILD" = 1 ] || [ ! -d "$CLASSES" ] || [ ! -s "$DEPS" ]; then
  echo "building ingest module + classpath ..." >&2
  ( cd "$TS_DIR" && mvn -q -pl cedar-terminology-server-ingest -am install -DskipTests \
      && mvn -q -pl cedar-terminology-server-ingest dependency:build-classpath -Dmdep.outputFile="$DEPS" ) \
    || die "maven build failed"
fi
CP="$CLASSES:$TS_DIR/cedar-terminology-server-store/target/classes:$TS_DIR/cedar-terminology-server-common/target/classes:$(cat "$DEPS")"

[ -s "$REG" ] || curl -s -m 60 "http://obofoundry.org/registry/ontologies.jsonld" -o "$REG" || die "OBO registry fetch failed"
mkdir -p "$SNAP"

# --- candidate list: active ontology -> (our-acronym, purl, current-latest-date); skip already-current ---
CANDS="$WORK/cands.tsv"
python3 - "$REG" "$CATALOG" "$SKIP_DAYS" "$MAX" > "$CANDS" <<'PY'
import sys, json, sqlite3, datetime
reg, cat, skipdays, maxn = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
act = [o for o in json.load(open(reg))["ontologies"] if o.get("activity_status") == "active"]
c = sqlite3.connect(cat)
iri2acr = {}
for acr, iri in c.execute("SELECT acronym, iri FROM ontology_source WHERE iri IS NOT NULL"):
    iri2acr.setdefault(iri, acr)
latest = {}
for acr, dd in c.execute(
        "SELECT s.acronym, COALESCE(s.source_date, substr(s.released_at,1,10)) FROM snapshot s "
        "JOIN version_tag t ON t.acronym=s.acronym AND t.version_id=s.version_id AND t.tag='latest'"):
    latest[acr] = dd
c.close()
cutoff = (datetime.date.today() - datetime.timedelta(days=skipdays)).isoformat()
rows = []
for o in act:
    oid = o["id"]
    purl = o.get("ontology_purl") or ("http://purl.obolibrary.org/obo/%s.owl" % oid)
    acr = iri2acr.get("http://purl.obolibrary.org/obo/" + oid, oid.upper().replace("_", "-"))
    ld = latest.get(acr, "")
    if ld and ld >= cutoff:          # already current — skip the re-download
        continue
    rows.append((acr, purl, ld or "none"))
rows.sort(key=lambda r: r[2])        # stalest first
if maxn:
    rows = rows[:maxn]
for acr, purl, ld in rows:
    print("%s\t%s\t%s" % (acr, purl, ld))
PY

TOTAL=$(wc -l < "$CANDS" | tr -d ' ')
echo "candidates: $TOTAL active OBO ontologies due a refresh (skip-newer-days=$SKIP_DAYS, timeout=${TIMEOUT}s, heap=$HEAP)" >&2
[ "$TOTAL" -gt 0 ] || { echo "nothing to ingest — all active OBO ontologies are already current."; exit 0; }

run_to() { local s=$1; shift; "$@" >"$WORK/.o" 2>"$WORK/.e" & local p=$!; ( sleep "$s"; kill -9 "$p" 2>/dev/null )& local k=$!; wait "$p" 2>/dev/null; local rc=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; return $rc; }

ok=0; fail=0; n=0
while IFS=$'\t' read -r ACR URL LD; do
  n=$((n+1))
  run_to "$TIMEOUT" java -Xmx"$HEAP" -cp "$CP" org.metadatacenter.terms.ingest.IngestJob \
      "$CATALOG" "$SNAP" --source url --url "$URL" --backend obofoundry --format OWL "$ACR"
  if grep -qE 'version [0-9a-f]{16}' "$WORK/.o"; then
    ver=$(grep -oE 'version [0-9a-f]+' "$WORK/.o" | head -1 | awk '{print substr($2,1,12)}')
    cnt=$(grep -oE '[0-9]+ classes' "$WORK/.o" | head -1 | grep -oE '^[0-9]+')
    ok=$((ok+1)); printf "[%4d/%d] OK   %-16s v%s %6s cls (was %s)\n" "$n" "$TOTAL" "$ACR" "$ver" "${cnt:-?}" "$LD"
  else
    fail=$((fail+1)); why=$(grep -vE 'SLF4J' "$WORK/.e" | grep -iE 'HTTP|Exception|Error|timed|refus|empty' | head -1 | cut -c1-64)
    printf "[%4d/%d] FAIL %-16s %s\n" "$n" "$TOTAL" "$ACR" "${why:-killed/timeout}"
  fi
done < "$CANDS"

echo "-------------------------------------------------------------"
echo "OBO harvest done: $ok refreshed/merged, $fail failed of $TOTAL"
sqlite3 "$CATALOG" "SELECT 'catalog now: '||COUNT(DISTINCT acronym)||' acronyms, '||COUNT(*)||' snapshots, '||COUNT(DISTINCT version_id)||' content hashes' FROM snapshot;" 2>/dev/null
