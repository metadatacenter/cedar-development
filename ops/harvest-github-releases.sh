#!/usr/bin/env bash
#
# harvest-github-releases.sh — ingest an ontology's release history from GitHub, one snapshot per
# release, in one command.
#
# Most non-BioPortal sources hand out only the current file: OLS exposes what it has loaded, a w3id
# or vendor URL serves whatever is behind it today, and an OBO PURL's dated form has to be guessed a
# date at a time. GitHub releases are different. Each release is dated, immutable, carries named
# assets at stable URLs, and the whole list is one API call — the same first-class version history
# OntoPortal submissions give, for ontologies no OntoPortal carries.
#
# Identity is the content hash, so a release whose bytes match a snapshot we already hold merges into
# it and costs only the download; re-running is therefore safe and mostly free. What it cannot do is
# know in advance which releases it already has, since only the bytes can answer that: bound the work
# with --max-releases and --since rather than expecting it to skip.
#
# Usage:
#   harvest-github-releases.sh <catalog.sqlite> <snapshotDir> <plan.tsv> [options]
#
# The plan is one line per ontology, tab-separated, comments and blank lines ignored:
#   ACRONYM <tab> owner/repo <tab> asset-regex <tab> [OWL|SKOS]
# e.g.
#   MEDGEN  monarch-initiative/medgen   ^medgen\.ttl\.gz$      OWL
#   EDAM    edamontology/edamontology   ^EDAM_[0-9.]+\.owl$    OWL
#
# Options:
#   --max-releases N  newest N releases per ontology (default: 5)
#   --since YYYY-MM-DD  ignore releases published before this date
#   --timeout S       per-release wall-clock cap in seconds (default: 1800)
#   --heap G          -Xmx for each ingest (default: 24g)
#   --dry-run         print what would be ingested and stop
#
# A GitHub token in GITHUB_TOKEN raises the API rate limit from 60 requests an hour to 5,000. One
# request per ontology is enough for the release list, so the anonymous limit covers a plan of any
# size a night can ingest anyway.
#
# Requires: Java 17, curl, python3, sqlite3, and the cedar-terminology-server checkout.

set -uo pipefail

die() { echo "error: $*" >&2; exit 1; }

[ $# -ge 3 ] || die "usage: harvest-github-releases.sh <catalog.sqlite> <snapshotDir> <plan.tsv> [options]"
CATALOG=$1; SNAP=$2; PLAN=$3; shift 3
[ -s "$CATALOG" ] || die "no catalog at $CATALOG"
[ -s "$PLAN" ]    || die "no plan at $PLAN"

MAXREL=5; SINCE=""; TIMEOUT=1800; HEAP=24g; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-releases) MAXREL=$2; shift 2;;
    --since) SINCE=$2; shift 2;;
    --timeout) TIMEOUT=$2; shift 2;;
    --heap) HEAP=$2; shift 2;;
    --dry-run) DRY=1; shift;;
    *) die "unknown option: $1";;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TS_DIR=${TS_DIR:-${CEDAR_HOME:+$CEDAR_HOME/cedar-terminology-server}}
[ -n "${TS_DIR:-}" ] && [ -d "$TS_DIR" ] || TS_DIR="$SCRIPT_DIR/../../cedar-terminology-server"
[ -d "$TS_DIR/cedar-terminology-server-ingest" ] || die "cedar-terminology-server not found (set TS_DIR or CEDAR_HOME)"
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null)}

# The runtime classpath, kept beside the store rather than in /tmp, which is swept. A missing file
# leaves only the classes directory and every ingest then dies on NoClassDefFoundError in under a
# second, which reads as a hundred failures rather than as one missing file.
CPFILE=${CPFILE:-${CEDAR_HOME:-}/cedar-term/prod/ingest-cp.txt}
[ -s "$CPFILE" ] || die "no classpath at $CPFILE — run mvn dependency:build-classpath"
CP="$TS_DIR/cedar-terminology-server-ingest/target/classes:$(cat "$CPFILE")"

WORK="${TMPDIR:-/tmp}/github-harvest"; mkdir -p "$WORK"

# ---------------------------------------------------------------------------- plan the release list
# One API call per ontology, newest release first, keeping the assets whose names the plan asks for.
python3 - "$PLAN" "$MAXREL" "$SINCE" > "$WORK/releases.tsv" <<'PY'
import json, re, sys, urllib.request, urllib.error
plan, maxrel, since = sys.argv[1], int(sys.argv[2]), sys.argv[3]
token = __import__('os').environ.get('GITHUB_TOKEN')
for line in open(plan):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    parts = line.split('\t')
    if len(parts) < 3:
        print(f"skipping malformed plan line: {line}", file=sys.stderr); continue
    acr, repo, pattern = parts[0], parts[1], parts[2]
    fmt = parts[3] if len(parts) > 3 else 'OWL'
    url = f"https://api.github.com/repos/{repo}/releases?per_page=100"
    headers = {'User-Agent': 'cedar-github-harvest'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    try:
        rels = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30))
    except urllib.error.HTTPError as e:
        print(f"{acr}: releases API HTTP {e.code}", file=sys.stderr); continue
    except Exception as e:
        print(f"{acr}: releases API {type(e).__name__}", file=sys.stderr); continue
    kept = 0
    for r in rels:
        date = (r.get('published_at') or '')[:10]
        if since and date and date < since:
            continue
        for a in (r.get('assets') or []):
            if re.search(pattern, a.get('name') or ''):
                print('\t'.join([acr, repo, r.get('tag_name') or '', date,
                                 a.get('browser_download_url') or '', fmt]))
                kept += 1
                break
        if kept >= maxrel:
            break
    if kept == 0:
        print(f"{acr}: no release asset matched /{pattern}/", file=sys.stderr)
PY

TOTAL=$(wc -l < "$WORK/releases.tsv" | tr -d ' ')
echo "planned: $TOTAL releases (max-releases=$MAXREL${SINCE:+, since=$SINCE})" >&2
[ "$TOTAL" -gt 0 ] || { echo "nothing to ingest."; exit 0; }
if [ "$DRY" = 1 ]; then cat "$WORK/releases.tsv"; exit 0; fi

# The source label of everything already held. A driver stamps its own --backend on whatever it
# ingests, and an identical-bytes merge lands on a snapshot that already exists — which would repaint
# a BioPortal or OBO Foundry release as though it came from GitHub. Put the old labels back at the
# end so a label only ever says where a snapshot actually came from.
sqlite3 "$CATALOG" "SELECT acronym||'|'||version_id||'|'||COALESCE(backend,'') FROM snapshot;" \
  > "$WORK/labels-before.txt"

run_to() {  # $1 seconds, then the command
  local s=$1; shift
  "$@" > "$WORK/.out" 2>&1 &
  local p=$!
  ( sleep "$s"; kill -9 "$p" 2>/dev/null ) &
  local k=$!
  wait "$p" 2>/dev/null; local rc=$?
  kill "$k" 2>/dev/null; wait "$k" 2>/dev/null
  return $rc
}

RESULTS="${RESULTS:-$WORK/results.tsv}"; : > "$RESULTS"
ok=0; fail=0; n=0
while IFS=$'\t' read -r ACR REPO TAG DATE URL FMT; do
  n=$((n+1))
  printf '[%3d/%3d] %-16s %-24s ' "$n" "$TOTAL" "$ACR" "$TAG" >&2
  # --release is BioPortal's dated-PURL flag and does not apply here; the tag goes in as the
  # declared version through the asset URL, which is itself immutable.
  if run_to "$TIMEOUT" "$JAVA_HOME/bin/java" -Xmx"$HEAP" -cp "$CP" \
       org.metadatacenter.terms.ingest.IngestJob "$CATALOG" "$SNAP" \
       --source url --url "$URL" --format "$FMT" --backend github "$ACR"; then
    ok=$((ok+1)); echo "OK" >&2
    printf '%s\t%s\t%s\tok\n' "$ACR" "$TAG" "$DATE" >> "$RESULTS"
  else
    fail=$((fail+1)); echo "FAIL" >&2
    tail -3 "$WORK/.out" | sed 's/^/    /' >&2
    printf '%s\t%s\t%s\tfail\n' "$ACR" "$TAG" "$DATE" >> "$RESULTS"
  fi
done < "$WORK/releases.tsv"

python3 - "$CATALOG" "$WORK/labels-before.txt" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
was = {}
for line in open(sys.argv[2]):
    a, v, b = line.rstrip('\n').split('|')
    was[(a, v)] = b or None
n = 0
for a, v, b in con.execute("SELECT acronym, version_id, backend FROM snapshot").fetchall():
    if (a, v) in was and was[(a, v)] != b:
        con.execute("UPDATE snapshot SET backend=? WHERE acronym=? AND version_id=?", (was[(a, v)], a, v))
        n += 1
con.commit()
print(f"source labels put back on {n} snapshots we already held", file=sys.stderr)
PY

echo "ingested $ok of $TOTAL releases, $fail failed. results: $RESULTS" >&2
echo "rebuild the index for whatever moved: ops/reindex.sh \$(cut -f1 $RESULTS | sort -u | paste -sd,)" >&2
