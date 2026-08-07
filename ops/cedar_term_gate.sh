#!/usr/bin/env bash
# Terminology equivalence gate runner.
#
#   verify  Stand up a throwaway local-store terminology instance (all ingested ontologies, strict
#           localOnly) and verify it against the recorded BioPortal goldens on both gates
#           (integrated-search and /classes/roots). Emits the ready sets — the signal for what may be
#           added to the cutover allowlists. Tears the instance down afterward.
#   record  Re-record the BioPortal goldens from a BioPortal-proxy server (drift refresh). Slow.
#
# The equivalence bar and per-atom logic live in cedar_termdiff.py; this just wires up the instance,
# ports, and paths. Requires the CEDAR profile sourced (CEDAR_HOME, CEDAR_VERSION, JAVA_HOME 17, the
# BioPortal/admin API keys) and a built terminology application jar.
set -euo pipefail

CMD=${1:-verify}
: "${CEDAR_HOME:?source the CEDAR profile first}"
: "${CEDAR_VERSION:?source the CEDAR profile first}"
OPS="$CEDAR_HOME/cedar-development/ops"
APP="$CEDAR_HOME/cedar-terminology-server/cedar-terminology-server-application"

STORE=$CEDAR_HOME/cedar-term
CATALOG=${TERM_CATALOG:-${CEDAR_TERMINOLOGY_STORE_CATALOG:-$STORE/prod/catalog.sqlite}}
GOLDENS=${TERM_GOLDENS:-$STORE/goldens}
GOLDENS_ROOTS=${TERM_GOLDENS_ROOTS:-$STORE/goldens_roots}
MATRIX=${TERM_MATRIX:-$STORE/matrix.jsonl}
REPORT_DIR=${TERM_REPORT_DIR:-$STORE}
# CEDAR key for the roots endpoint (needs CEDAR auth, unlike integrated-search).
APIKEY=${CEDAR_ADMIN_USER_API_KEY:-}

# Verify runs on the dev+10000 test ports so a running dev stack never collides.
PORT=19004 ADMIN=19104 STOPPORT=19204

allowlist() { sqlite3 "$CATALOG" "SELECT group_concat(acronym) FROM (SELECT acronym FROM ontology ORDER BY acronym)"; }

verify() {
  local jar="$APP/target/cedar-terminology-server-application-${CEDAR_VERSION}.jar"
  local cfg="$APP/src/main/resources/config.yml"
  [ -f "$jar" ] || { echo "build the terminology app jar first: $jar" >&2; exit 1; }

  echo "== launching throwaway local-store instance on :$PORT (all ontologies, localOnly) =="
  CEDAR_TERMINOLOGY_HTTP_PORT=$PORT CEDAR_TERMINOLOGY_ADMIN_PORT=$ADMIN CEDAR_TERMINOLOGY_STOP_PORT=$STOPPORT \
    nohup java -DterminologyStore.catalogPath="$CATALOG" \
      -DterminologyStore.localOntologies="$(allowlist)" \
      -DterminologyStore.localOnly=true \
      -jar "$jar" server "$cfg" >"$REPORT_DIR/term-gate-instance.log" 2>&1 &
  local pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do curl -sk --max-time 3 "http://localhost:$ADMIN/healthcheck" >/dev/null 2>&1 && break; sleep 2; done

  echo "== integrated-search gate =="
  python3 "$OPS/cedar_termdiff.py" verify --matrix "$MATRIX" --goldens "$GOLDENS" \
    --server "http://localhost:$PORT" --report "$REPORT_DIR/gate_integrated_search.json"
  echo "== roots gate =="
  python3 "$OPS/cedar_termdiff.py" verify --roots --matrix "$MATRIX" --goldens "$GOLDENS_ROOTS" \
    --server "http://localhost:$PORT" --api-key "$APIKEY" --report "$REPORT_DIR/gate_roots.json"

  echo "== cutover sets =="
  python3 - "$REPORT_DIR/gate_integrated_search.json" "$REPORT_DIR/gate_roots.json" <<'PY'
import json, sys
srch=set(json.load(open(sys.argv[1]))["ready"])
roots=set(json.load(open(sys.argv[2]))["ready"])
print(f"  search-ready (localOntologies):        {len(srch)}")
print(f"  roots-ready ∩ search (localRootsOntologies): {len(srch & roots)}")
PY
}

record() {
  # Re-record goldens from a BioPortal-proxy server (a terminology server with an empty local store).
  local server=${TERM_RECORD_SERVER:-http://localhost:9004}
  echo "== recording BioPortal goldens (integrated-search) from $server =="
  python3 "$OPS/cedar_termdiff.py" record --matrix "$MATRIX" --goldens "$GOLDENS" \
    --server "$server" --api-key "$APIKEY" --force
  echo "== recording BioPortal goldens (roots) from $server =="
  python3 "$OPS/cedar_termdiff.py" record --roots --matrix "$MATRIX" --goldens "$GOLDENS_ROOTS" \
    --server "$server" --api-key "$APIKEY" --force
}

case "$CMD" in
  verify) verify ;;
  record) record ;;
  *) echo "usage: $0 {verify|record}" >&2; exit 2 ;;
esac
