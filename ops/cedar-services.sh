#!/bin/bash
# ------------------------------------------------------------------------------
# cedar-services.sh — start / stop / monitor the CEDAR app tier without 15 consoles.
#
# Runs the 15 Dropwizard microservices + the 7 frontends, which are named ui-* to keep them
# apart from the like-named microservices: ui-main (the AngularJS monolith) and the two previews
# being split out of it start under gulp, the 4 Angular applications under `ng serve`,
# as detached background processes, each logging to $CEDAR_HOME/log/, PIDs in $CEDAR_HOME/log/run/.
# macOS uses a non-restarting launchd submitted job so the services survive shells whose command
# runner reaps its whole process group; other systems retain the nohup launcher. One `status` view
# shows PID / port / health / error-count.
# Frontend health is port-only (no Dropwizard /healthcheck).
#
# Infra (Keycloak, Mongo, Neo4j, MySQL, Redis, OpenSearch, nginx) is NOT managed here —
# bring that up separately (it is already running in this session).
#
# Usage:
#   ./cedar-services.sh start [name...]     # start all, or only the named services
#   ./cedar-services.sh stop  [name...]     # stop all, or only the named
#   ./cedar-services.sh restart [name...]
#   ./cedar-services.sh status              # one-shot table
#   ./cedar-services.sh status-tsv          # machine-readable status for cedarcli
#   ./cedar-services.sh watch               # refreshing status (Ctrl-C to exit)
#   ./cedar-services.sh logs <name>         # tail -f a service log
#   ./cedar-services.sh health [name...]    # exit 0 only if all selected services are healthy
#   ./cedar-services.sh running              # verified native applications, one per line
#   ./cedar-services.sh running-infra        # host listeners on native infrastructure ports
# ------------------------------------------------------------------------------
export CEDAR_HOME="${CEDAR_HOME:-$HOME/CEDAR}"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# cedarcli hands this script the environment it resolved from the recorded profile, so a caller
# that already has one is trusted. Someone running the script directly gets the same environment
# from the one versioned profile, told which one to load by CEDAR_PROFILE.
if [ "${CEDAR_SERVICES_INSPECT_ONLY:-false}" != true ] && [ -z "${CEDAR_DEVELOP_HOME:-}" ]; then
  NATIVE_PROFILE="$CEDAR_HOME/cedar-development/bin/templates/cedar-profile-native.sh"
  if [ -z "${CEDAR_PROFILE:-}" ]; then
    echo "No CEDAR environment is loaded. Run this through cedarcli, or export CEDAR_PROFILE" >&2
    echo "as develop or server and source $NATIVE_PROFILE first." >&2
    exit 1
  fi
  if ! source "$NATIVE_PROFILE" >/dev/null 2>&1; then
    echo "Cannot load native CEDAR profile: $NATIVE_PROFILE" >&2
    exit 1
  fi
fi
if [ "${CEDAR_SERVICES_INSPECT_ONLY:-false}" != true ]; then
  # JDK 17 comes from the caller. cedarcli resolves it per platform; a login shell exports it.
  if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
    export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null)"
  fi
  if [ -z "${JAVA_HOME:-}" ]; then
    echo "JAVA_HOME is not set, and CEDAR needs JDK 17" >&2
    exit 1
  fi
fi
PATH="${JAVA_HOME:+$JAVA_HOME/bin:}/opt/homebrew/bin:$PATH"      # /opt/homebrew/bin for node + ng (aux frontends)
# Loopback is safest for the native-only stack. Set this to 0.0.0.0 when Docker nginx must proxy
# to the native Angular development servers through host.docker.internal.
CEDAR_FRONTEND_BIND_HOST="${CEDAR_FRONTEND_BIND_HOST:-127.0.0.1}"

RUN="$CEDAR_HOME/log/run"
LOGDIR="$CEDAR_HOME/log"
mkdir -p "$RUN" "$LOGDIR"

# name  app_port  admin_port   (admin_port 0 => not a Dropwizard service, check app_port only)
SERVICES=(
  "group 9009 9109"
  "messaging 9012 9112"
  "repo 9002 9102"
  "resource 9007 9107"
  "schema 9003 9103"
  "artifact 9001 9101"
  "terminology 9004 9104"
  "user 9005 9105"
  "valuerecommender 9006 9106"
  "submission 9010 9110"
  "worker 9011 9111"
  "openview 9013 9113"
  "monitor 9014 9114"
  "impex 9008 9108"
  "bridge 9015 9115"
  "ui-main 4200 0"
  "ui-workspace 4201 0"
  "ui-designer 4202 0"
  "ui-openview 4220 0"
  "ui-content 4240 0"
  "ui-monitoring 4300 0"
  "ui-bridging 4340 0"
)

# These are the host ports used by the native infrastructure tier. The inspection command below
# reports anything outside Docker that is listening on them. Some services (notably Homebrew
# MySQL, Redis and nginx) have no CEDAR-specific process marker, so the occupied port is the only
# reliable fact available when deciding whether a Docker topology can start safely.
INFRASTRUCTURE_PORTS=(
  "nginx-http 80"
  "nginx-https 443"
  "mongodb 27017"
  "mysql 3306"
  "redis 6379"
  "opensearch 9200"
  "neo4j-http 7474"
  "neo4j-bolt 7687"
  "keycloak 8080"
)

# Source directory for every frontend. ui-main remains the production-safe monolith while
# ui-workspace and ui-designer, the two halves being extracted from it, run beside it.
fe_dir() {
  case "$1" in
    ui-main)       echo "$CEDAR_HOME/cedar-template-editor" ;;
    ui-workspace)  echo "$CEDAR_HOME/cedar-workspace" ;;
    ui-designer)   echo "$CEDAR_HOME/cedar-template-designer" ;;
    ui-openview)   echo "$CEDAR_HOME/cedar-openview/cedar-openview-src" ;;
    ui-content)    echo "$CEDAR_HOME/cedar-content-distribution" ;;
    ui-monitoring) echo "$CEDAR_HOME/cedar-monitoring/cedar-monitoring-src" ;;
    ui-bridging)   echo "$CEDAR_HOME/cedar-bridging/cedar-bridging-src" ;;
  esac
}

svc_field() { local n=$1 f=$2; for s in "${SERVICES[@]}"; do set -- $s; [ "$1" = "$n" ] && { echo "${!f}"; return; }; done; }
app_port()  { svc_field "$1" 2; }
admin_port(){ svc_field "$1" 3; }
pidfile()   { echo "$RUN/$1.pid"; }
logfile()   { case "$1" in ui-*) echo "$LOGDIR/$1.log";; *) echo "$LOGDIR/cedar-$1-server.log";; esac; }
# Every service writes two logs. The one above is its standard output and error, which carries the
# console appender plus everything the JVM and its libraries print before logback exists and
# whatever a failing launcher reports, and which start truncates. The one below is the Dropwizard
# file appender named in each config.yml: logging events only, but it survives restarts and
# rotates daily, so an earlier run's history is still there. Frontends declare no appender.
dropwizard_logfile() { case "$1" in ui-*) echo "";; *) echo "$LOGDIR/cedar-$1-server/dropwizard.log";; esac; }
log_error_count() {
  local log=$1
  [ -r "$log" ] || { echo 0; return; }
  # Count error events, not arbitrary occurrences of words such as "Exception". A WARN emitted by
  # CedarCedarExceptionMapper is still a WARN, and stack-trace lines belong to the ERROR record that
  # introduced them rather than being additional errors of their own.
  awk '/^ERROR([[:space:]]|$)/ { count++ } END { print count + 0 }' "$log"
}
port_open() { nc -z -G1 127.0.0.1 "$1" >/dev/null 2>&1; }
auxiliary_ports() {
  local admin; admin=$(admin_port "$1")
  [ "$admin" != 0 ] && printf '%s\n%s\n' "$admin" "$((admin+100))"
}

# Whoever is actually listening, pidfile or not. A listener is never assumed to be CEDAR merely
# because it owns a CEDAR port: Docker Desktop proxies many published ports through one host process,
# and killing that process takes down the entire Docker daemon.
port_owner() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; }
port_owners() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -nu; }
process_command() { ps -p "$1" -o command= 2>/dev/null; }
process_alive() { kill -0 "$1" 2>/dev/null; }
process_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

is_docker_port_forwarder() {
  local command
  command=$(process_command "$1")
  case "$command" in
    *com.docker.backend*|*Docker.app*|*docker-proxy*|*rootlesskit*|*vpnkit*|*gvproxy*|*podman*) return 0 ;;
  esac
  return 1
}

# Artifact is deliberately private to cedarnet and therefore has no host listener to inspect. A
# direct container check lets status describe its owner without pretending that this native script
# can assess the container's health. Keep the Compose project check so an unrelated container that
# happens to use the same name is not accepted as CEDAR.
docker_service_running() {
  local name=$1 container project details
  case "$name" in
    artifact) container="server-artifact"; project="cedar-microservices" ;;
    *) return 1 ;;
  esac
  command -v docker >/dev/null 2>&1 || return 1
  details=$(docker inspect --format '{{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null) || return 1
  [ "$details" = "true $project" ]
}

is_service_process() {
  local name=$1 pid=$2 command cwd expected prefix
  command=$(process_command "$pid")
  [ -n "$command" ] || return 1
  case "$name" in
    ui-*)
      expected=$(fe_dir "$name")
      [ -n "$expected" ] || return 1
      cwd=$(process_cwd "$pid")
      case "$cwd" in "$expected"|"$expected"/*) ;; *) return 1 ;; esac
      case "$command" in *gulp*|*"ng serve"*|*node*|*npm*) return 0 ;; esac
      ;;
    *)
      prefix="$CEDAR_HOME/cedar-${name}-server/cedar-${name}-server-application/target/cedar-${name}-server-application-"
      case "$command" in *"$prefix"*.jar*) return 0 ;; esac
      ;;
  esac
  return 1
}

service_port_owner() {
  local name=$1 port=$2 pid
  while read -r pid; do
    [ -n "$pid" ] || continue
    if is_service_process "$name" "$pid"; then
      echo "$pid"
      return 0
    fi
  done < <(port_owners "$port")
  return 1
}

process_summary() {
  local command
  command=$(process_command "$1")
  command=${command//$'\n'/ }
  printf '%s' "${command:0:160}"
}

# npm/gulp commonly has a non-listening wrapper above the Node process that owns the port. Killing
# only the listener can leave that wrapper alive long enough to replace it. Stop the wrapper when it
# is recognisably part of the same frontend, but never climb into an interactive shell or terminal.
listener_root() {
  local owner=$1 parent command
  parent=$(ps -o ppid= -p "$owner" 2>/dev/null | tr -d ' ')
  [ -n "$parent" ] && [ "$parent" -gt 1 ] || { echo "$owner"; return; }
  command=$(ps -o command= -p "$parent" 2>/dev/null)
  case "$command" in
    *"npm exec gulp"*|*"npx gulp"*|*"ng serve"*|*"node"*"gulp"*) echo "$parent" ;;
    *) echo "$owner" ;;
  esac
}

verified_listener_root() {
  local name=$1 owner=$2 root
  root=$(listener_root "$owner")
  if is_service_process "$name" "$root"; then echo "$root"; else echo "$owner"; fi
}

terminate_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do terminate_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

stop_port_processes() {
  local name=$1 port=$2 managed=$3 owner root attempt
  if [ -n "$managed" ] && kill -0 "$managed" 2>/dev/null; then
    if ! is_service_process "$name" "$managed"; then
      echo "  $name: REFUSED TO STOP pid $managed — it is not the expected CEDAR process: $(process_summary "$managed")" >&2
      return 1
    fi
    root=$(verified_listener_root "$name" "$managed")
    terminate_tree "$root"
  fi
  attempt=0
  while owner=$(port_owner "$port") && [ -n "$owner" ] && [ "$attempt" -lt 10 ]; do
    if ! is_service_process "$name" "$owner"; then
      echo "  $name: REFUSED TO STOP port $port owner pid $owner — it is not the expected CEDAR process: $(process_summary "$owner")" >&2
      return 1
    fi
    root=$(verified_listener_root "$name" "$owner")
    terminate_tree "$root"
    sleep 0.5
    attempt=$((attempt+1))
  done
  owner=$(port_owner "$port")
  if [ -n "$owner" ]; then
    if ! is_service_process "$name" "$owner"; then
      echo "  $name: REFUSED TO KILL port $port owner pid $owner — it is not the expected CEDAR process: $(process_summary "$owner")" >&2
      return 1
    fi
    root=$(verified_listener_root "$name" "$owner")
    kill -KILL "$root" 2>/dev/null || true
    sleep 0.5
  fi
  ! port_open "$port"
}

stop_auxiliary_processes() {
  local name=$1 port owner root result=0 attempt
  while read -r port; do
    [ -n "$port" ] || continue
    owner=$(port_owner "$port")
    [ -n "$owner" ] || continue
    if ! is_service_process "$name" "$owner"; then
      echo "  $name: REFUSED TO STOP auxiliary port $port owner pid $owner — it is not the expected CEDAR process: $(process_summary "$owner")" >&2
      result=1
      continue
    fi
    root=$(verified_listener_root "$name" "$owner")
    terminate_tree "$root"
    attempt=0
    while port_open "$port" && [ "$attempt" -lt 10 ]; do sleep 0.2; attempt=$((attempt+1)); done
    if port_open "$port"; then
      kill -KILL "$root" 2>/dev/null || true
      sleep 0.2
    fi
    if port_open "$port"; then
      echo "  $name: FAILED TO STOP auxiliary port $port (pid $owner)" >&2
      result=1
    else
      echo "  stopped stale $name process on auxiliary port $port (pid $owner)"
    fi
  done < <(auxiliary_ports "$name")
  return "$result"
}

remove_launchd_job() {
  local name=$1 label="org.metadatacenter.cedar.native.$1" attempt
  [ "$(uname -s)" = Darwin ] || return 1
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    launchctl remove "$label" >/dev/null 2>&1 || return 1
    # Removal is asynchronous. An immediate submit can otherwise observe the retiring job, reuse
    # its PID in the pidfile, and leave no replacement once launchd finishes the old removal.
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || return 0
      sleep 0.1
    done
    echo "  $name: launchd job did not finish stopping" >&2
    return 1
  fi
  return 1
}

launchd_job_pid() {
  local name=$1 label="org.metadatacenter.cedar.native.$1"
  launchctl print "gui/$(id -u)/$label" 2>/dev/null |
      sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -1
}

jar_of() { echo "$CEDAR_HOME/cedar-$1-server/cedar-$1-server-application/target/cedar-$1-server-application-${CEDAR_VERSION}.jar"; }

# The Template Designer is the one frontend that takes the Embeddable Editor from npm, and a gulp
# task copies the bundle out of node_modules into the tree gulp serves. The bytes therefore travel
# two hops that git never observes, because the served copy is ignored. A pin that moved without a
# reinstall, or a reinstall without a copy, leaves the previous editor on screen while package.json,
# the lock and the release ledger all name the new one. Check both hops.
cee_version() {  # echoes the version $1 records for CEE, under package key $2 or at the top level
  python3 - "$1" "$2" <<'CEEPY' 2>/dev/null
import json, sys
path, key = sys.argv[1], sys.argv[2]
try:
    doc = json.load(open(path))
except Exception:
    raise SystemExit(1)
node = doc.get("packages", {}).get(key, {}) if key else doc
print(node.get("version", ""))
CEEPY
}

cee_of() {  # echoes current|STALE|- for the Embeddable Editor the Template Designer serves
  local root="$CEDAR_HOME/cedar-template-editor" want have
  local lock="$root/package-lock.json"
  local manifest="$root/node_modules/cedar-embeddable-editor/package.json"
  local installed="$root/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js"
  local servedjs="$root/app/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js"
  command -v python3 >/dev/null 2>&1 || { echo '-'; return; }
  [ -f "$lock" ] || { echo '-'; return; }          # not an npm-managed checkout; nothing to compare
  [ -f "$manifest" ] && [ -f "$installed" ] && [ -f "$servedjs" ] || { echo STALE; return; }
  want=$(cee_version "$lock" node_modules/cedar-embeddable-editor)
  have=$(cee_version "$manifest" '')
  [ -n "$want" ] && [ -n "$have" ] || { echo '-'; return; }
  [ "$want" = "$have" ] || { echo STALE; return; } # the lock moved and npm ci never ran
  cmp -s "$installed" "$servedjs" || { echo STALE; return; }  # npm ci ran and copy:cee never did
  echo current
}

# A service can be healthy and still be serving code from before the last build, which makes a green
# gate meaningless. Compare when the process started against when its jar was written.
binary_of() {  # echoes current|STALE|- for a service and the pid serving it
  local name=$1 pid=$2 jar started j_epoch p_epoch
  case "$name" in
    ui-main) cee_of; return ;;
    ui-*) echo '-'; return ;;
  esac
  jar=$(jar_of "$name")
  [ -n "$pid" ] && [ -f "$jar" ] || { echo '-'; return; }
  started=$(ps -o lstart= -p "$pid" 2>/dev/null) || { echo '-'; return; }
  [ -n "$started" ] || { echo '-'; return; }
  p_epoch=$(date -j -f '%a %b %e %T %Y' "$started" +%s 2>/dev/null) || { echo '-'; return; }
  j_epoch=$(stat -f %m "$jar" 2>/dev/null) || { echo '-'; return; }
  [ -n "$p_epoch" ] && [ -n "$j_epoch" ] || { echo '-'; return; }
  if [ "$j_epoch" -gt "$p_epoch" ]; then echo STALE; else echo current; fi
}

run_one_foreground() {
  local name=$1 app; app=$(app_port "$name")
  case "$name" in
    ui-main)
      local dir; dir=$(fe_dir "$name")
      cd "$dir" || return 1
      exec gulp ;;
    ui-workspace|ui-designer)
      local dir; dir=$(fe_dir "$name")
      cd "$dir" || return 1
      export CEDAR_FRONTEND_PORT="$app"
      export CEDAR_WORKSPACE_FRONTEND_URL="${CEDAR_WORKSPACE_FRONTEND_URL:-https://workspace.${CEDAR_HOST}}"
      export CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL="${CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL:-https://designer.${CEDAR_HOST}}"
      exec gulp ;;
    ui-openview|ui-content|ui-monitoring|ui-bridging)
      local dir; dir=$(fe_dir "$name")
      cd "$dir" || return 1
      exec ng serve --port "$app" --host "$CEDAR_FRONTEND_BIND_HOST" ;;
    *)
      local jar="$CEDAR_HOME/cedar-$name-server/cedar-$name-server-application/target/cedar-$name-server-application-${CEDAR_VERSION}.jar"
      local cfg="$CEDAR_HOME/cedar-$name-server/cedar-$name-server-application/src/main/resources/config.yml"
      # Terminology local-store cutover: when CEDAR_TERMINOLOGY_STORE_CATALOG is set (in the profile),
      # serve the allowlisted ontologies from the local SQLite store, BioPortal for the rest. Scoped to
      # this service so the -D overrides do not touch other JVMs. Unset the env var to revert to proxy.
      local opts=""
      if [ "$name" = "terminology" ] && [ -n "$CEDAR_TERMINOLOGY_STORE_CATALOG" ]; then
        opts="-DterminologyStore.catalogPath=$CEDAR_TERMINOLOGY_STORE_CATALOG -DterminologyStore.localOntologies=$CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES"
        [ -n "$CEDAR_TERMINOLOGY_LOCAL_ROOTS_ONTOLOGIES" ] && opts="$opts -DterminologyStore.localRootsOntologies=$CEDAR_TERMINOLOGY_LOCAL_ROOTS_ONTOLOGIES"
        [ -n "$CEDAR_TERMINOLOGY_LOCAL_ONLY" ] && opts="$opts -DterminologyStore.localOnly=$CEDAR_TERMINOLOGY_LOCAL_ONLY"
        # The cross-snapshot search index, which POST /search and /search/hierarchy need. Its own
        # variable because it is its own file: the catalog can be served without it, and those two
        # endpoints then report themselves unavailable rather than answering from BioPortal.
        [ -n "$CEDAR_TERMINOLOGY_STORE_INDEX" ] && opts="$opts -DterminologyStore.searchIndexPath=$CEDAR_TERMINOLOGY_STORE_INDEX"
      fi
      exec java $opts -jar "$jar" server "$cfg" ;;
  esac
}

start_one() {
  local name=$1 app p owner; app=$(app_port "$name"); local log; log=$(logfile "$name")
  p=$(cat "$(pidfile "$name")" 2>/dev/null)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    if is_service_process "$name" "$p"; then
      echo "  $name: already running (pid $p)"
      return 0
    fi
    echo "  $name: ignoring stale pidfile for unrelated live pid $p" >&2
    rm -f "$(pidfile "$name")"
  fi
  if port_open "$app"; then
    owner=$(port_owner "$app")
    if [ -n "$owner" ] && is_service_process "$name" "$owner"; then
      echo "  $name: native process already owns port $app (pid $owner, no pidfile)"
      return 0
    fi
    if [ -n "$owner" ]; then
      echo "  $name: REFUSED TO START — port $app belongs to non-CEDAR pid $owner: $(process_summary "$owner")" >&2
    else
      echo "  $name: REFUSED TO START — port $app is occupied and its owner could not be identified" >&2
    fi
    return 1
  fi
  local auxiliary owner
  while read -r auxiliary; do
    [ -n "$auxiliary" ] || continue
    if port_open "$auxiliary"; then
      owner=$(port_owner "$auxiliary")
      if [ -n "$owner" ] && is_service_process "$name" "$owner"; then
        echo "  $name: REFUSED TO START — stale CEDAR pid $owner owns auxiliary port $auxiliary; run stop first" >&2
      elif [ -n "$owner" ]; then
        echo "  $name: REFUSED TO START — auxiliary port $auxiliary belongs to non-CEDAR pid $owner: $(process_summary "$owner")" >&2
      else
        echo "  $name: REFUSED TO START — auxiliary port $auxiliary is occupied and its owner could not be identified" >&2
      fi
      return 1
    fi
  done < <(auxiliary_ports "$name")
  case "$name" in
    ui-*)
      local dir; dir=$(fe_dir "$name")
      [ -d "$dir" ] || { echo "  $name: SRC MISSING ($dir) — skip"; return 1; } ;;
    *)
      local jar; jar=$(jar_of "$name")
      local cfg="$CEDAR_HOME/cedar-$name-server/cedar-$name-server-application/src/main/resources/config.yml"
      [ -f "$jar" ] || { echo "  $name: JAR MISSING ($jar) — build it first"; return 1; }
      [ -f "$cfg" ] || { echo "  $name: CONFIG MISSING ($cfg)"; return 1; } ;;
  esac

  if [ "$(uname -s)" = Darwin ]; then
    local label="org.metadatacenter.cedar.native.$name" attempt
    remove_launchd_job "$name" >/dev/null 2>&1 || true
    # launchctl's -o/-e files append by default; retain the old nohup launcher's one-log-per-run
    # behavior so status does not attribute an earlier process's errors to the current binary.
    : > "$log"
    # launchd starts a submitted job from its own environment and not this shell's, so the child
    # arrives with no CEDAR variables at all and loads the profile for itself. Name which one it
    # is, since nothing may guess that on the host's behalf.
    if [ -z "${CEDAR_PROFILE:-}" ]; then
      echo "  $name: CEDAR_PROFILE is not set, and launchd cannot inherit this shell's environment" >&2
      return 1
    fi
    launchctl submit -l "$label" -o "$log" -e "$log" -- /bin/bash -c \
      'export CEDAR_HOME="$1" CEDAR_PROFILE="$2"; exec "$3" run-one "$4"' \
      cedar-launchd-run "$CEDAR_HOME" "$CEDAR_PROFILE" "$SCRIPT_PATH" "$name" || return 1
    p=""
    for attempt in 1 2 3 4 5; do
      p=$(launchd_job_pid "$name")
      [ -n "$p" ] && break
      sleep 0.2
    done
    [ -n "$p" ] || { echo "  $name: launchd did not report a child PID" >&2; return 1; }
  else
    nohup "$SCRIPT_PATH" run-one "$name" >"$log" 2>&1 &
    p=$!
  fi
  # A PID proves only that the launcher spawned something. A submitted job restarts when it exits,
  # so a service that cannot start shows a fresh PID on every look and buries its first, useful
  # error under identical repeats. Give it a moment and confirm this same process is still there,
  # which catches what fails before a JVM starts: an unreadable profile, a missing config, no JDK.
  # A service that dies later still reads as unhealthy in status and health.
  sleep 0.5
  if ! process_alive "$p"; then
    remove_launchd_job "$name" || true
    echo "  $name: exited immediately (pid $p); last lines of $log:" >&2
    tail -n 4 "$log" 2>/dev/null | sed 's/^/    /' >&2
    return 1
  fi
  echo "$p" > "$(pidfile "$name")"
  echo "  started $name (pid $p) -> port $app, log $log"
}

stop_one() {
  local name=$1 p result=0; p=$(cat "$(pidfile "$name")" 2>/dev/null)
  local port; port=$(app_port "$name")
  # Removing a submitted launchd job terminates its process without restarting it. Wait for its
  # listener to close before falling through to the ordinary process-tree safety checks.
  if remove_launchd_job "$name"; then
    local attempt=0
    while port_open "$port" && [ "$attempt" -lt 10 ]; do sleep 0.2; attempt=$((attempt+1)); done
    if ! port_open "$port"; then
      echo "  stopped $name${p:+ (pid $p)}"
      stop_auxiliary_processes "$name" || result=1
      rm -f "$(pidfile "$name")"
      return "$result"
    fi
  fi
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && is_service_process "$name" "$p"; then
    if stop_port_processes "$name" "$port" "$p"; then
      echo "  stopped $name (pid $p)"
    else
      echo "  $name: FAILED TO STOP — port $port is still open" >&2
      result=1
    fi
  else
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      echo "  $name: ignoring stale pidfile for unrelated live pid $p" >&2
    fi
    # No pidfile, but something may still hold the port. Stopping it is the whole point of stop:
    # leaving it up is how a restart silently keeps serving the previous build.
    local owner; owner=$(port_owner "$(app_port "$name")")
    if [ -n "$owner" ] && is_service_process "$name" "$owner"; then
      if stop_port_processes "$name" "$port" ""; then
        echo "  stopped $name (pid $owner, adopted — it had no pidfile, started outside this script)"
      else
        echo "  $name: FAILED TO STOP — port $port is still open" >&2
        result=1
      fi
    elif [ -n "$owner" ]; then
      echo "  $name: REFUSED TO STOP port $port owner pid $owner — it is not the expected CEDAR process: $(process_summary "$owner")" >&2
      result=1
    else echo "  $name: not running"; fi
  fi
  stop_auxiliary_processes "$name" || result=1
  rm -f "$(pidfile "$name")"
  return "$result"
}

names() { if [ $# -gt 0 ]; then printf '%s\n' "$@"; else for s in "${SERVICES[@]}"; do set -- $s; echo "$1"; done; fi; }

health_of() {  # echoes healthy|UNHEALTHY|starting|down
  local name=$1 app admin; app=$(app_port "$name"); admin=$(admin_port "$name")
  if [ "$admin" = 0 ]; then port_open "$app" && echo healthy || echo down; return; fi
  local code; code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$admin/healthcheck" 2>/dev/null)
  case "$code" in 200) echo healthy;; 500) echo UNHEALTHY;; *) port_open "$app" && echo starting || echo down;; esac
}

health() {
  local bad=0 n
  while read -r n; do
    [ "$(health_of "$n")" = healthy ] || bad=1
  done < <(names "$@")
  return "$bad"
}

status() {
  printf "%-18s %-8s %-8s %-10s %-8s %s\n" SERVICE PID PORT HEALTH BINARY "ERRORS(log)"
  printf "%-18s %-8s %-8s %-10s %-8s %s\n" "------" "---" "----" "------" "------" "-----------"
  local up=0 total=0 stale=0 cee_stale=0 unmanaged=0 foreign=0 docker_owned=0
  while read -r name; do
    total=$((total+1))
    inspect_status "$name"
    [ "$STATUS_HEALTH" = healthy ] && up=$((up+1))
    if [ "$STATUS_BINARY" = STALE ]; then
      case "$name" in
        ui-main)  cee_stale=$((cee_stale+1)) ;;
        *)        stale=$((stale+1)) ;;
      esac
    fi
    case "$STATUS_PID" in
      '~'*) unmanaged=$((unmanaged+1)) ;;
      '!'*) foreign=$((foreign+1)) ;;
      docker) docker_owned=$((docker_owned+1)) ;;
    esac
    printf "%-18s %-8s %-8s %-10s %-8s %s\n" \
      "$name" "$STATUS_PID" "$STATUS_LISTENER" "$STATUS_HEALTH" "$STATUS_BINARY" "$STATUS_ERRORS"
  done < <(names)
  echo "-------------------------------------------------------------"
  if [ "$docker_owned" -gt 0 ]; then
    [ "$total" -gt "$docker_owned" ] && echo "native healthy: $up / $((total-docker_owned))"
    echo "Docker-owned services are marked docker; run cedarcli docker status for container health."
  else
    echo "healthy: $up / $total   (login at https://cedar.$CEDAR_HOST once ui-main + resource/user are healthy)"
  fi
  [ "$stale" -gt 0 ] && echo "WARNING: $stale service(s) marked STALE — running a jar older than the build. Run: $0 restart"
  [ "$cee_stale" -gt 0 ] && {
    echo "WARNING: ui-main marked STALE — serving an Embeddable Editor other than the one package-lock.json names."
    echo "         Run: (cd \$CEDAR_HOME/cedar-template-editor && npm ci && npx gulp copy:cee)"
  }
  [ "$unmanaged" -gt 0 ] && echo "WARNING: $unmanaged service(s) marked ~pid — started outside this script. restart now adopts them."
  [ "$foreign" -gt 0 ] && echo "ERROR: $foreign service port(s) marked !pid belong to non-CEDAR processes. Native start/stop will not touch them."
  return 0
}

# Populate one row without formatting it. Keeping inspection here gives the human shell table and
# cedarcli's richer table one source of truth instead of making the Python side scrape aligned text.
inspect_status() {
    local name=$1 p own pid_disp docker_row=false
    STATUS_APP_PORT=$(app_port "$name")
    p=$(cat "$(pidfile "$name")" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && is_service_process "$name" "$p"; then pid_disp="$p"; own="$p"
    else
      own=$(service_port_owner "$name" "$(app_port "$name")")
      if [ -n "$own" ]; then
        pid_disp="~$own"
      else
        own=$(port_owner "$(app_port "$name")")
        if [ -n "$own" ]; then
          if is_docker_port_forwarder "$own"; then
            pid_disp="docker"; docker_row=true; own=""
          else
            pid_disp="!$own"; own=""
          fi
        elif docker_service_running "$name"; then
          pid_disp="docker"; docker_row=true; own=""
        else pid_disp="-"; fi
      fi
    fi
    if port_open "$STATUS_APP_PORT"; then
      STATUS_LISTENER="up"
    elif [ "$docker_row" = true ]; then
      STATUS_LISTENER="internal"
    else
      STATUS_LISTENER="down"
    fi
    if [ "$docker_row" = true ]; then
      STATUS_HEALTH="docker"
    else
      STATUS_HEALTH=$(health_of "$name")
    fi
    STATUS_BINARY=$(binary_of "$name" "$own")
    if [ "$docker_row" = true ]; then
      # These files belong to an earlier native run. Container logs and health belong to cedarcli.
      STATUS_ERRORS="-"
    else
      STATUS_ERRORS=$(log_error_count "$(logfile "$name")")
    fi
    STATUS_PID=$pid_disp
}

status_tsv() {
  printf 'service\tpid\tport\tlistener\thealth\tbinary\tlog_errors\n'
  local name
  while read -r name; do
    inspect_status "$name"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$STATUS_PID" "$STATUS_APP_PORT" "$STATUS_LISTENER" \
      "$STATUS_HEALTH" "$STATUS_BINARY" "$STATUS_ERRORS"
  done < <(names)
}

running() {
  local name p owner
  while read -r name; do
    p=$(cat "$(pidfile "$name")" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && is_service_process "$name" "$p"; then
      echo "$name"
      continue
    fi
    owner=$(service_port_owner "$name" "$(app_port "$name")")
    if [ -n "$owner" ]; then
      echo "$name"
    fi
  done < <(names "$@")
}

running_infrastructure() {
  local name port pid found
  for service in "${INFRASTRUCTURE_PORTS[@]}"; do
    set -- $service
    name=$1
    port=$2
    found=false
    while read -r pid; do
      [ -n "$pid" ] || continue
      found=true
      if ! is_docker_port_forwarder "$pid"; then
        echo "$name (port $port, pid $pid)"
      fi
    done < <(port_owners "$port")
    # A listener can occasionally be visible to connect(2) while its owning process is hidden
    # from lsof. Report that uncertainty rather than allowing a mode switch to collide with it.
    if [ "$found" = false ] && port_open "$port"; then
      echo "$name (port $port, owner unknown)"
    fi
  done
}

follow_log() {
  local lines=100 appender=stdout name="" log
  while [ $# -gt 0 ]; do
    case "$1" in
      -n|--lines)
        case "${2:-}" in
          "" | *[!0-9]*) echo "logs: --lines takes a number, not '${2:-}'" >&2; return 2 ;;
        esac
        lines=$2; shift 2 ;;
      --dropwizard) appender=dropwizard; shift ;;
      --stdout) appender=stdout; shift ;;
      -*) echo "usage: $0 logs <service> [-n LINES] [--dropwizard]" >&2; return 2 ;;
      *)
        [ -z "$name" ] || { echo "logs: follows one service, and '$name' was already named" >&2; return 2; }
        name=$1; shift ;;
    esac
  done
  [ -n "$name" ] || { echo "usage: $0 logs <service> [-n LINES] [--dropwizard]" >&2; return 2; }
  [ -n "$(app_port "$name")" ] || { echo "logs: unknown service '$name'" >&2; return 2; }
  if [ "$appender" = dropwizard ]; then
    log=$(dropwizard_logfile "$name")
    [ -n "$log" ] || { echo "logs: $name is a frontend and declares no Dropwizard appender" >&2; return 2; }
  else
    log=$(logfile "$name")
  fi
  [ -e "$log" ] || { echo "logs: $name has written no log yet at $log" >&2; return 1; }
  echo "==> $log"
  # -F rather than -f: start truncates the stdout log in place and the appender rotates itself at
  # midnight, and either one leaves a -f following a file nothing writes to any more.
  exec tail -F -n "$lines" "$log"
}

if [ "${CEDAR_SERVICES_LIBRARY_ONLY:-false}" = true ]; then
  return 0 2>/dev/null || exit 0
fi

cmd="${1:-status}"; shift 2>/dev/null
case "$cmd" in
  run-one) run_one_foreground "$1" ;;
  start)   echo "Starting CEDAR app tier (JDK 17)..."; failed=0; while read -r n; do start_one "$n" || failed=1; sleep 3; done < <(names "$@"); exit "$failed" ;;
  stop)    failed=0; while read -r n; do stop_one "$n" || failed=1; done < <(names "$@"); exit "$failed" ;;
  restart) "$SCRIPT_PATH" stop "$@" || exit $?; sleep 2; "$SCRIPT_PATH" start "$@" ;;
  status)  status ;;
  status-tsv) status_tsv ;;
  watch)   while true; do clear; date; status; sleep 5; done ;;
  running) running "$@" ;;
  running-infra) running_infrastructure ;;
  health)  health "$@"; exit $? ;;
  logs)    follow_log "$@"; exit $? ;;
  *) echo "usage: $0 {start|stop|restart|status|watch|running|running-infra|health} [name...]"
     echo "       $0 logs <name> [-n LINES] [--dropwizard]" ;;
esac
