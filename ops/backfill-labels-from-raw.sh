#!/usr/bin/env bash
#
# backfill-labels-from-raw.sh — fill the multilingual label side-table (all-language labels + synonyms)
# for served snapshots by re-extracting from each snapshot's RETAINED LOCAL RAW download: the file under
# snapshots/<ACR>/raw/ whose SHA-256 matches the snapshot's stored `file_hash`. No network, no credentials.
#
# Use this instead of the BioPortal-refetch backfill (`--backfill-labels`) once sources have drifted —
# BioPortal no longer serves the exact bytes a snapshot was built from, so a re-download hashes to a
# different version and the identity gate declines it. The retained raw is that exact content, and because
# labels key by concept IRI (addLabels is INSERT-OR-IGNORE on c.iri), the file_hash match alone proves
# authenticity: the run does NOT gate on the recomputed content-hash, so extractor evolution since ingest
# is harmless. Idempotent/resumable — snapshots that already carry labels are skipped.
#
# Terminology is stopped for the run (giant re-extractions are RAM-heavy) and restarted after, unless told
# otherwise. Snapshots with no matching retained raw are reported as `no-matching-raw` and left untouched
# (they need their source re-fetched — see VERSIONING-ROADMAP item 17).
#
# Usage:
#   backfill-labels-from-raw.sh <catalog.sqlite> <snapshotDir> [ACRONYM ...] [options]
# Options:
#   --heap G       -Xmx for the ingest JVM (default: 40g; the giants — MESH, DDSS, BERO — need room)
#   --timeout S    wall-clock cap in seconds (default: 21600 = 6h)
#   --keep-serving do NOT stop terminology (only safe for a small acronym set; giants will swap)
#   --no-restart   leave terminology stopped after the run
#   --rebuild      force a Maven rebuild of the ingest module first
# With no ACRONYMs, every ontology is processed (already-labeled snapshots are skipped).

set -uo pipefail
die() { echo "error: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: backfill-labels-from-raw.sh <catalog.sqlite> <snapshotDir> [ACRONYM ...] [--heap G] [--timeout S] [--keep-serving] [--no-restart] [--rebuild]"
CATALOG=$1; SNAP=$2; shift 2
HEAP=40g; TIMEOUT=21600; STOP=1; RESTART=1; REBUILD=0; ACRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --heap) HEAP=$2; shift 2;;
    --timeout) TIMEOUT=$2; shift 2;;
    --keep-serving) STOP=0; shift;;
    --no-restart) RESTART=0; shift;;
    --rebuild) REBUILD=1; shift;;
    --*) die "unknown option: $1";;
    *) ACRS+=("$1"); shift;;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TS_DIR=${TS_DIR:-${CEDAR_HOME:+$CEDAR_HOME/cedar-terminology-server}}
[ -n "${TS_DIR:-}" ] && [ -d "$TS_DIR/cedar-terminology-server-ingest" ] || TS_DIR="$SCRIPT_DIR/../../cedar-terminology-server"
[ -d "$TS_DIR/cedar-terminology-server-ingest" ] || die "cedar-terminology-server not found (set TS_DIR or CEDAR_HOME)"
SVC="$SCRIPT_DIR/cedar-services.sh"
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null)}

WORK="${TMPDIR:-/tmp}/label-raw-backfill"; mkdir -p "$WORK"; DEPS="$WORK/deps.txt"
CLASSES="$TS_DIR/cedar-terminology-server-ingest/target/classes"
if [ "$REBUILD" = 1 ] || [ ! -d "$CLASSES" ] || [ ! -s "$DEPS" ]; then
  echo "building ingest module + classpath ..." >&2
  ( cd "$TS_DIR" && mvn -q -pl cedar-terminology-server-ingest -am install -DskipTests \
      && mvn -q -pl cedar-terminology-server-ingest dependency:build-classpath -Dmdep.outputFile="$DEPS" ) \
    || die "maven build failed"
fi
CP="$CLASSES:$TS_DIR/cedar-terminology-server-store/target/classes:$TS_DIR/cedar-terminology-server-common/target/classes:$(cat "$DEPS")"
stamp() { date '+%Y-%m-%d %H:%M:%S'; }
run_to() { local s=$1; shift; "$@" & local p=$!; ( sleep "$s"; kill -9 "$p" 2>/dev/null )& local k=$!; wait "$p" 2>/dev/null; local rc=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; return $rc; }

if [ "$STOP" = 1 ]; then
  echo "=== $(stamp)  STOP terminology (RAM-safe window) ==="
  bash "$SVC" stop terminology 2>&1 | tail -2; sleep 5
fi

echo "=== $(stamp)  BACKFILL LABELS FROM RAW ${ACRS:+(${#ACRS[@]} acronyms)}${ACRS:-(all ontologies)} ==="
run_to "$TIMEOUT" java -Xmx"$HEAP" -cp "$CP" org.metadatacenter.terms.ingest.IngestJob \
    "$CATALOG" "$SNAP" --backfill-labels-from-raw "${ACRS[@]}"

if [ "$STOP" = 1 ] && [ "$RESTART" = 1 ]; then
  echo "=== $(stamp)  START terminology ==="
  bash "$SVC" start terminology 2>&1 | tail -2
fi
echo "=== $(stamp)  DONE ==="
