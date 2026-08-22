#!/bin/bash
#
# Rebuilds the search index for named ontologies.
#
# The index is derived from the snapshots, and nothing rebuilds it when a snapshot changes. A
# re-ingest therefore leaves the index serving the previous extraction's labels — correctly, since
# that is what it holds, and confusingly, since the catalog has moved on. Rebuilding is incremental
# and takes seconds per ontology, so it is rebuilt for whatever was touched rather than in whole.
#
# Usage: reindex.sh <acronym,acronym,...> [logdir]
#        reindex.sh --from-results <results.tsv> [logdir]   # every acronym in column 1

set -u

CATALOG="$CEDAR_HOME/cedar-term/prod/catalog.sqlite"
INDEX="$CEDAR_HOME/cedar-term/prod/search-index.sqlite"
# The runtime classpath, kept beside the store rather than in /tmp, which is swept.
CPFILE="$CEDAR_HOME/cedar-term/prod/ingest-cp.txt"
[ -s "$CPFILE" ] || { echo "no classpath at $CPFILE — run mvn dependency:build-classpath" >&2; exit 2; }
CP="$CEDAR_HOME/cedar-terminology-server/cedar-terminology-server-ingest/target/classes:$(cat "$CPFILE")"

if [ "${1:-}" = "--from-results" ]; then
  RESULTS="${2:?usage: reindex.sh --from-results <results.tsv> [logdir]}"
  [ -s "$RESULTS" ] || { echo "no results at $RESULTS" >&2; exit 2; }
  ACR=$(cut -f1 "$RESULTS" | grep . | sort -u | paste -sd, -)
  LOGDIR="${3:-$CEDAR_HOME/cedar-term/prod/logs/reindex-$(date +%Y%m%d-%H%M%S)}"
else
  ACR="${1:?usage: reindex.sh <acronym,acronym,...> [logdir]}"
  LOGDIR="${2:-$CEDAR_HOME/cedar-term/prod/logs/reindex-$(date +%Y%m%d-%H%M%S)}"
fi
mkdir -p "$LOGDIR"

count=$(printf '%s' "$ACR" | tr ',' '\n' | grep -c .)
echo "reindexing $count ontologies: $ACR"
started=$(date +%s)
java -Xmx10g -cp "$CP" org.metadatacenter.terms.ingest.SearchIndexJob \
    "$CATALOG" "$INDEX" --acronyms "$ACR" --force > "$LOGDIR/index-rebuild.log" 2>&1
status=$?
echo "index rebuild: exit $status in $(( $(date +%s) - started ))s"
tail -3 "$LOGDIR/index-rebuild.log"
echo "log: $LOGDIR/index-rebuild.log"
exit $status
