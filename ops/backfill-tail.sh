#!/bin/bash
#
# Backfills recent releases across a long list of ontologies, planning each one as it goes.
#
# Unlike backfill-releases.sh, which takes submission ids worked out in advance, this asks BioPortal
# what an ontology has at the moment it reaches it. Over a thousand ontologies that matters twice: a
# planning pass would be a thousand API calls before the first ingest, and roughly a quarter of the
# tail has one submission or none, which is only discoverable by asking.
#
# Skips submissions the catalog already records, so a re-run costs a listing call an ontology and
# nothing more. Sequential: BioPortal is one API and each ingest is a full parse.
#
# Usage: backfill-tail.sh <acronyms.txt> <keep> [logdir]
#   acronyms.txt is one acronym a line; keep is how many recent releases to end up holding.

set -u
LIST="${1:?usage: backfill-tail.sh <acronyms.txt> <keep> [logdir]}"
KEEP="${2:?how many recent releases to hold}"
LOGDIR="${3:-$CEDAR_HOME/cedar-term/prod/logs/tail-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$LOGDIR"

CATALOG="$CEDAR_HOME/cedar-term/prod/catalog.sqlite"
SNAPSHOTS="$CEDAR_HOME/cedar-term/prod/snapshots"
# The runtime classpath, kept beside the store rather than in /tmp, which is swept: a missing
# file leaves only the classes directory and every ingest dies on NoClassDefFoundError in
# under a second, which reads as a thousand failures rather than as one missing file.
CPFILE="$CEDAR_HOME/cedar-term/prod/ingest-cp.txt"
[ -s "$CPFILE" ] || { echo "no classpath at $CPFILE — run mvn dependency:build-classpath" >&2; exit 2; }
CP="$CEDAR_HOME/cedar-terminology-server/cedar-terminology-server-ingest/target/classes:$(cat "$CPFILE")"
RESULTS="$LOGDIR/results.tsv"
: > "$RESULTS"

total=$(grep -c . "$LIST")
n=0
while read -r acronym; do
  [ -z "$acronym" ] && continue
  n=$((n + 1))

  held=$(sqlite3 "$CATALOG" "SELECT COALESCE(submission_id, -1) FROM snapshot WHERE acronym='$acronym';" | paste -sd, -)
  ids=$(curl -s -m 45 \
      "https://data.bioontology.org/ontologies/$acronym/submissions?apikey=$CEDAR_BIOPORTAL_API_KEY&display=submissionId" \
      | KEEP="$KEEP" HELD="${held:-}" python3 -c '
import json, os, sys
keep = int(os.environ["KEEP"])
held = {h for h in os.environ.get("HELD", "").split(",") if h}
try:
    subs = json.load(sys.stdin)
except Exception:
    subs = []
ids = [str(s.get("submissionId")) for s in subs if s.get("submissionId") is not None]
print(",".join([i for i in ids if i not in held][:keep]))' 2>/dev/null)

  if [ -z "$ids" ]; then
    printf '%s\t—\tnothing to fetch\t0s\t\n' "$acronym" >> "$RESULTS"
    echo "[$n/$total] $acronym — nothing to fetch"
    continue
  fi

  for id in ${ids//,/ }; do
    started=$(date +%s)
    BIOPORTAL_API_KEY="$CEDAR_BIOPORTAL_API_KEY" java -Xmx10g -cp "$CP" \
        org.metadatacenter.terms.ingest.IngestJob "$CATALOG" "$SNAPSHOTS" \
        --submission "$id" "$acronym" > "$LOGDIR/$acronym-$id.log" 2>&1
    status=$?
    took=$(( $(date +%s) - started ))
    version=$(grep -o 'version [0-9a-f]\{64\}' "$LOGDIR/$acronym-$id.log" | tail -1 | cut -d' ' -f2)
    printf '%s\t%s\t%s\t%ss\t%s\n' "$acronym" "$id" \
        "$([ $status -eq 0 ] && echo ok || echo "failed($status)")" "$took" "${version:0:12}" >> "$RESULTS"
    # A failed ingest leaves the previous snapshot alone, so the log is the record and the run goes on.
    [ $status -eq 0 ] || rm -f "$LOGDIR/$acronym-$id.log.keep"
  done
  echo "[$n/$total] $acronym — $(grep -c "^$acronym	" "$RESULTS") attempted"
done < "$LIST"

echo "ingest done: $(awk -F'\t' '$3=="ok"' "$RESULTS" | wc -l) ok, $(grep -c failed "$RESULTS") failed, $(grep -c 'nothing to fetch' "$RESULTS") had nothing"

ACR=$(awk -F'\t' '$3=="ok" {print $1}' "$RESULTS" | sort -u | paste -sd, -)
if [ -n "$ACR" ]; then
  java -Xmx10g -cp "$CP" org.metadatacenter.terms.ingest.SearchIndexJob \
      "$CATALOG" "$CEDAR_HOME/cedar-term/prod/search-index.sqlite" --acronyms "$ACR" --force \
      > "$LOGDIR/index-rebuild.log" 2>&1
  echo "index rebuild: $? — $(tail -1 "$LOGDIR/index-rebuild.log")"
fi
echo "results: $RESULTS"
