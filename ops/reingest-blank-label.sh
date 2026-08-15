#!/bin/bash
#
# Re-ingests the ontologies whose labels were lost to the blank-literal defect.
#
# An ontology can assert `rdfs:label ""` beside the real one. Both extractors ranked the blank
# literal like any other and kept whichever came first, so a concept that lost the toss counted as
# unlabeled and drew the IRI-fragment fallback — ABD's "White pine blister rust" was served as
# "?id=118". The extractors now skip blank literals; a snapshot already written keeps the wrong
# label, because a version id is a hash over pref_label and correcting one in place would change
# the release's identity rather than repair it. Re-ingesting is the repair, and it mints a new
# version id, which is the versioning model working rather than a side effect to hide.
#
# Sequential on purpose: BioPortal is one API and a parallel fleet is how a key gets throttled.
# Each ontology is independent, so a failure is logged and the run continues.
#
# Usage: reingest-blank-label.sh <plan.tsv> [logdir]
#   plan.tsv is `acronym|backend` a line, backend one of bioportal / obofoundry / url.

set -u
PLAN="${1:?usage: reingest-blank-label.sh <plan.tsv> [logdir]}"
LOGDIR="${2:-$CEDAR_HOME/cedar-term/prod/logs/reingest-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$LOGDIR"

CATALOG="$CEDAR_HOME/cedar-term/prod/catalog.sqlite"
SNAPSHOTS="$CEDAR_HOME/cedar-term/prod/snapshots"
CP="$CEDAR_HOME/cedar-terminology-server/cedar-terminology-server-ingest/target/classes:$(cat /tmp/ingest-cp.txt)"
RESULTS="$LOGDIR/results.tsv"
: > "$RESULTS"

total=$(grep -c . "$PLAN")
n=0
while IFS='|' read -r acronym backend; do
  [ -z "$acronym" ] && continue
  n=$((n + 1))
  # `set -u` treats an empty array as unbound under bash 3.2, which is what macOS ships.
  case "$backend" in
    obofoundry) args=(--source obofoundry) ;;
    bioportal)  args=(--source bioportal) ;;
    *)          printf '%s\t%s\tskipped\tno reproducible source\n' "$acronym" "$backend" >> "$RESULTS"; continue ;;
  esac
  started=$(date +%s)
  BIOPORTAL_API_KEY="$CEDAR_BIOPORTAL_API_KEY" java -Xmx8g -cp "$CP" \
      org.metadatacenter.terms.ingest.IngestJob "$CATALOG" "$SNAPSHOTS" \
      "${args[@]}" "$acronym" > "$LOGDIR/$acronym.log" 2>&1
  status=$?
  took=$(( $(date +%s) - started ))
  version=$(grep -o 'version [0-9a-f]\{64\}' "$LOGDIR/$acronym.log" | tail -1 | cut -d' ' -f2)
  printf '%s\t%s\t%s\t%ss\t%s\n' "$acronym" "$backend" \
      "$([ $status -eq 0 ] && echo ok || echo "failed($status)")" "$took" "${version:-—}" >> "$RESULTS"
  echo "[$n/$total] $acronym $([ $status -eq 0 ] && echo ok || echo FAILED) in ${took}s"
done < "$PLAN"

echo "done: $(grep -c 'ok' "$RESULTS") ok, $(grep -c failed "$RESULTS") failed, $(grep -c skipped "$RESULTS") skipped"
echo "results: $RESULTS"
