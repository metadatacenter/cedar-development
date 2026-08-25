#!/bin/bash
# ------------------------------------------------------------------------------
# cedar-services.sh — start / stop / monitor the CEDAR app tier without 15 consoles.
#
# Runs the 15 Dropwizard microservices + the production frontend (gulp) + the two
# split frontend previews (gulp) + the 4 auxiliary Angular frontends (via `ng serve`)
# as background processes (nohup), each logging to $CEDAR_HOME/log/, PIDs in
# $CEDAR_HOME/log/run/. One `status` view shows PID / port / health / error-count.
# Frontend health is port-only (no Dropwizard /healthcheck). The non-essential CEE
# demos (cee-dev/demo.cee) are NOT managed here — cedarcli doesn't start them
# by default either.
#
# Infra (Keycloak, Mongo, Neo4j, MySQL, Redis, OpenSearch, nginx) is NOT managed here —
# bring that up separately (it is already running in this session).
#
# Usage:
#   ./cedar-services.sh start [name...]     # start all, or only the named services
#   ./cedar-services.sh stop  [name...]     # stop all, or only the named
#   ./cedar-services.sh restart [name...]
#   ./cedar-services.sh status              # one-shot table
#   ./cedar-services.sh watch               # refreshing status (Ctrl-C to exit)
#   ./cedar-services.sh logs <name>         # tail -f a service log
#   ./cedar-services.sh health              # exit 0 only if every service is healthy
#   ./cedar-services.sh running              # verified native applications, one per line
#   ./cedar-services.sh running-infra        # host listeners on native infrastructure ports
# ------------------------------------------------------------------------------
export CEDAR_HOME="${CEDAR_HOME:-$HOME/CEDAR}"
if [ "${CEDAR_SERVICES_INSPECT_ONLY:-false}" != true ]; then
  if ! source "$CEDAR_HOME/cedar-profile-native-develop.sh" >/dev/null 2>&1; then
    echo "Cannot load native CEDAR profile: $CEDAR_HOME/cedar-profile-native-develop.sh" >&2
    exit 1
  fi
fi
export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null)"   # CEDAR + Keycloak need JDK 17
PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"                    # /opt/homebrew/bin for node + ng (aux frontends)
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
  "frontend 4200 0"
  "workspace 4201 0"
  "designer 4202 0"
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

# ng-serve source dir for each aux (ui-*) frontend
fe_dir() {
  case "$1" in
    ui-openview)   echo "$CEDAR_HOME/cedar-openview/cedar-openview-src" ;;
    ui-content)    echo "$CEDAR_HOME/cedar-content-distribution" ;;
    ui-monitoring) echo "$CEDAR_HOME/cedar-monitoring/cedar-monitoring-src" ;;
    ui-bridging)   echo "$CEDAR_HOME/cedar-bridging/cedar-bridging-src" ;;
  esac
}

# AngularJS/Gulp frontends. `frontend` remains the production-safe monolith while
# Workspace and Designer run beside it during the extraction.
gulp_fe_dir() {
  case "$1" in
    frontend)  echo "$CEDAR_HOME/cedar-template-editor" ;;
    workspace) echo "$CEDAR_HOME/cedar-workspace" ;;
    designer)  echo "$CEDAR_HOME/cedar-template-designer" ;;
  esac
}

svc_field() { local n=$1 f=$2; for s in "${SERVICES[@]}"; do set -- $s; [ "$1" = "$n" ] && { echo "${!f}"; return; }; done; }
app_port()  { svc_field "$1" 2; }
admin_port(){ svc_field "$1" 3; }
pidfile()   { echo "$RUN/$1.pid"; }
logfile()   { case "$1" in frontend|workspace|designer) echo "$LOGDIR/cedar-$1.log";; ui-*) echo "$LOGDIR/frontend-${1#ui-}.log";; *) echo "$LOGDIR/cedar-$1-server.log";; esac; }
port_open() { nc -z -G1 127.0.0.1 "$1" >/dev/null 2>&1; }

# Whoever is actually listening, pidfile or not. A listener is never assumed to be CEDAR merely
# because it owns a CEDAR port: Docker Desktop proxies many published ports through one host process,
# and killing that process takes down the entire Docker daemon.
port_owner() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; }
port_owners() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -nu; }
process_command() { ps -p "$1" -o command= 2>/dev/null; }
process_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

is_docker_port_forwarder() {
  local command
  command=$(process_command "$1")
  case "$command" in
    *com.docker.backend*|*Docker.app*|*docker-proxy*|*rootlesskit*|*vpnkit*|*gvproxy*|*podman*) return 0 ;;
  esac
  return 1
}

expected_frontend_dir() {
  case "$1" in
    frontend) echo "$CEDAR_HOME/cedar-template-editor" ;;
    workspace) echo "$CEDAR_HOME/cedar-workspace" ;;
    designer) echo "$CEDAR_HOME/cedar-template-designer" ;;
    ui-openview) echo "$CEDAR_HOME/cedar-openview/cedar-openview-src" ;;
    ui-content) echo "$CEDAR_HOME/cedar-content-distribution" ;;
    ui-monitoring) echo "$CEDAR_HOME/cedar-monitoring/cedar-monitoring-src" ;;
    ui-bridging) echo "$CEDAR_HOME/cedar-bridging/cedar-bridging-src" ;;
  esac
}

is_service_process() {
  local name=$1 pid=$2 command cwd expected prefix
  command=$(process_command "$pid")
  [ -n "$command" ] || return 1
  case "$name" in
    frontend|workspace|designer|ui-*)
      expected=$(expected_frontend_dir "$name")
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

remove_launchd_job() {
  local name=$1 label="org.metadatacenter.cedar.native.$1"
  [ "$(uname -s)" = Darwin ] || return 0
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    launchctl remove "$label" >/dev/null 2>&1 || true
  fi
}

jar_of() { echo "$CEDAR_HOME/cedar-$1-server/cedar-$1-server-application/target/cedar-$1-server-application-${CEDAR_VERSION}.jar"; }

# A service can be healthy and still be serving code from before the last build, which makes a green
# gate meaningless. Compare when the process started against when its jar was written.
binary_of() {  # echoes current|STALE|- for a service and the pid serving it
  local name=$1 pid=$2 jar started j_epoch p_epoch
  case "$name" in frontend|workspace|designer|ui-*) echo '-'; return;; esac
  jar=$(jar_of "$name")
  [ -n "$pid" ] && [ -f "$jar" ] || { echo '-'; return; }
  started=$(ps -o lstart= -p "$pid" 2>/dev/null) || { echo '-'; return; }
  [ -n "$started" ] || { echo '-'; return; }
  p_epoch=$(date -j -f '%a %b %e %T %Y' "$started" +%s 2>/dev/null) || { echo '-'; return; }
  j_epoch=$(stat -f %m "$jar" 2>/dev/null) || { echo '-'; return; }
  [ -n "$p_epoch" ] && [ -n "$j_epoch" ] || { echo '-'; return; }
  if [ "$j_epoch" -gt "$p_epoch" ]; then echo STALE; else echo current; fi
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
  case "$name" in
    frontend)
      [ -d "$CEDAR_HOME/cedar-template-editor" ] || {
        echo "  $name: SRC MISSING ($CEDAR_HOME/cedar-template-editor) — skip"
        return 1
      }
      ( cd "$CEDAR_HOME/cedar-template-editor" && exec nohup gulp >"$log" 2>&1 ) & ;;
    workspace|designer)
      local dir; dir=$(gulp_fe_dir "$name")
      [ -d "$dir" ] || { echo "  $name: SRC MISSING ($dir) — skip"; return 1; }
      ( cd "$dir" \
        && export CEDAR_FRONTEND_PORT="$app" \
        && export CEDAR_WORKSPACE_FRONTEND_URL="${CEDAR_WORKSPACE_FRONTEND_URL:-https://workspace.${CEDAR_HOST}}" \
        && export CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL="${CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL:-https://designer.${CEDAR_HOST}}" \
        && exec nohup gulp >"$log" 2>&1 ) & ;;
    ui-*)
      local dir; dir=$(fe_dir "$name")
      [ -d "$dir" ] || { echo "  $name: SRC MISSING ($dir) — skip"; return 1; }
      ( cd "$dir" && exec nohup ng serve --port "$app" --host "$CEDAR_FRONTEND_BIND_HOST" >"$log" 2>&1 ) & ;;
    *)
      local jar="$CEDAR_HOME/cedar-$name-server/cedar-$name-server-application/target/cedar-$name-server-application-${CEDAR_VERSION}.jar"
      local cfg="$CEDAR_HOME/cedar-$name-server/cedar-$name-server-application/src/main/resources/config.yml"
      [ -f "$jar" ] || { echo "  $name: JAR MISSING ($jar) — build it first"; return 1; }
      [ -f "$cfg" ] || { echo "  $name: CONFIG MISSING ($cfg)"; return 1; }
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
      nohup java $opts -jar "$jar" server "$cfg" >"$log" 2>&1 & ;;
  esac
  echo $! > "$(pidfile "$name")"
  echo "  started $name (pid $!) -> port $app, log $log"
}

stop_one() {
  local name=$1 p result=0; p=$(cat "$(pidfile "$name")" 2>/dev/null)
  local port; port=$(app_port "$name")
  # Retire jobs created by the former launchd experiment before touching their processes;
  # otherwise KeepAlive immediately replaces every PID that stop terminates.
  remove_launchd_job "$name"
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

status() {
  printf "%-18s %-8s %-6s %-10s %-8s %s\n" SERVICE PID PORT HEALTH BINARY "ERRORS(log)"
  printf "%-18s %-8s %-6s %-10s %-8s %s\n" "------" "---" "----" "------" "------" "-----------"
  local up=0 total=0 stale=0 unmanaged=0 foreign=0
  while read -r name; do
    total=$((total+1))
    local p own pid_disp port_disp h bin errs
    p=$(cat "$(pidfile "$name")" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && is_service_process "$name" "$p"; then pid_disp="$p"; own="$p"
    else
      own=$(service_port_owner "$name" "$(app_port "$name")")
      if [ -n "$own" ]; then
        pid_disp="~$own"; unmanaged=$((unmanaged+1))
      else
        own=$(port_owner "$(app_port "$name")")
        if [ -n "$own" ]; then
          pid_disp="!$own"; foreign=$((foreign+1)); own=""
        else pid_disp="-"; fi
      fi
    fi
    port_open "$(app_port "$name")" && port_disp="up" || port_disp="down"
    h=$(health_of "$name"); [ "$h" = healthy ] && up=$((up+1))
    bin=$(binary_of "$name" "$own"); [ "$bin" = STALE ] && stale=$((stale+1))
    # Exclude logback's own configuration chatter. Its internal status lines all take the
    # form "|-LEVEL in <class>" (INFO/WARN/ERROR/…), and one WARN reports an appender named
    # FILE-ERROR "not referenced" — which the old "|-INFO in"-only filter let through as a
    # phantom error. Real application errors have no "|-" prefix (e.g. "ERROR [ts] logger:").
    errs=$(grep -iE "ERROR|Exception" "$(logfile "$name")" 2>/dev/null | grep -cvE "\|-(INFO|WARN|ERROR|TRACE|DEBUG) in "); errs=${errs:-0}
    printf "%-18s %-8s %-6s %-10s %-8s %s\n" "$name" "$pid_disp" "$port_disp" "$h" "$bin" "$errs"
  done < <(names)
  echo "-------------------------------------------------------------"
  echo "healthy: $up / $total   (login at https://cedar.$CEDAR_HOST once frontend + resource/user are healthy)"
  [ "$stale" -gt 0 ] && echo "WARNING: $stale service(s) marked STALE — running a jar older than the build. Run: $0 restart"
  [ "$unmanaged" -gt 0 ] && echo "WARNING: $unmanaged service(s) marked ~pid — started outside this script. restart now adopts them."
  [ "$foreign" -gt 0 ] && echo "ERROR: $foreign service port(s) marked !pid belong to non-CEDAR processes. Native start/stop will not touch them."
  return 0
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

if [ "${CEDAR_SERVICES_LIBRARY_ONLY:-false}" = true ]; then
  return 0 2>/dev/null || exit 0
fi

cmd="${1:-status}"; shift 2>/dev/null
case "$cmd" in
  start)   echo "Starting CEDAR app tier (JDK 17)..."; failed=0; while read -r n; do start_one "$n" || failed=1; sleep 3; done < <(names "$@"); exit "$failed" ;;
  stop)    failed=0; while read -r n; do stop_one "$n" || failed=1; done < <(names "$@"); exit "$failed" ;;
  restart) "$0" stop "$@" || exit $?; sleep 2; "$0" start "$@" ;;
  status)  status ;;
  watch)   while true; do clear; date; status; sleep 5; done ;;
  running) running "$@" ;;
  running-infra) running_infrastructure ;;
  health)  bad=0; while read -r n; do [ "$(health_of "$n")" = healthy ] || bad=1; done < <(names); exit $bad ;;
  logs)    [ -n "$1" ] && tail -f "$(logfile "$1")" || echo "usage: $0 logs <service>" ;;
  *) echo "usage: $0 {start|stop|restart|status|watch|running|running-infra|logs <name>|health} [name...]" ;;
esac
