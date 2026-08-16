#!/bin/bash
#
# Backfills recent releases for ontologies the store holds only one or two of.
#
# The versioning work — the picker's release list, the per-release hierarchy, freeze-on-publish —
# is only exercisable where an ontology has several releases, and 1,109 of the store's 1,215 hold
# exactly one. This ingests a few recent submissions apiece for the ontologies a CEDAR template is
# most likely to constrain a field to, by BioPortal submission id.
#
# Sequential, one submission at a time: BioPortal is one API, and each of these is a full parse of
# an ontology. Already-held content is idempotent on the content hash, so re-ingesting a submission
# the store already has costs a download and changes nothing.
#
# Usage: backfill-releases.sh <plan.tsv> [logdir]
#   plan.tsv is `acronym<TAB>id,id,id` a line, ids newest first. An acronym suffixed `:valuesets`
#   is ingested as a value-set collection, which is the same content-hash mechanism under a
#   different kind in the catalog — CEDARVS is one, and ingesting it as an ontology would file it
#   under the wrong kind.

set -u
PLAN="${1:?usage: backfill-releases.sh <plan.tsv> [logdir]}"
LOGDIR="${2:-$CEDAR_HOME/cedar-term/prod/logs/backfill-$(date +%Y%m%d-%H%M%S)}"
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

while IFS=$'\t' read -r acronym ids; do
  [ -z "${acronym:-}" ] && continue
  # A plain string, not an array: under `set -u` bash 3.2 calls an empty array unbound, and macOS
  # ships bash 3.2. The flag has no spaces, so nothing is lost by not quoting it as one word.
  kind=""
  case "$acronym" in
    *:valuesets) kind="--valuesets"; acronym="${acronym%%:*}" ;;
  esac
  for id in ${ids//,/ }; do
    [ -z "$id" ] && continue
    started=$(date +%s)
    BIOPORTAL_API_KEY="$CEDAR_BIOPORTAL_API_KEY" java -Xmx10g -cp "$CP" \
        org.metadatacenter.terms.ingest.IngestJob "$CATALOG" "$SNAPSHOTS" \
        --submission "$id" $kind "$acronym" > "$LOGDIR/$acronym-$id.log" 2>&1
    status=$?
    took=$(( $(date +%s) - started ))
    version=$(grep -o 'version [0-9a-f]\{64\}' "$LOGDIR/$acronym-$id.log" | tail -1 | cut -d' ' -f2)
    printf '%s\t%s\t%s\t%ss\t%s\n' "$acronym" "$id" \
        "$([ $status -eq 0 ] && echo ok || echo "failed($status)")" "$took" "${version:0:12}" >> "$RESULTS"
    echo "$acronym submission $id: $([ $status -eq 0 ] && echo ok || echo FAILED) in ${took}s"
  done
done < "$PLAN"

echo "ingest done: $(grep -c 'ok' "$RESULTS") ok, $(grep -c failed "$RESULTS") failed"

# The index is derived, so it is rebuilt for whatever was touched rather than in whole.
ACR=$(cut -f1 "$RESULTS" | sort -u | paste -sd, -)
java -Xmx10g -cp "$CP" org.metadatacenter.terms.ingest.SearchIndexJob \
    "$CATALOG" "$CEDAR_HOME/cedar-term/prod/search-index.sqlite" --acronyms "$ACR" --force \
    > "$LOGDIR/index-rebuild.log" 2>&1
echo "index rebuild: $? — $(tail -1 "$LOGDIR/index-rebuild.log")"
echo "results: $RESULTS"
