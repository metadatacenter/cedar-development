#!/bin/bash
# ------------------------------------------------------------------------------
# cedar-services.sh — start / stop / monitor the CEDAR app tier without 15 consoles.
#
# Runs the 15 Dropwizard microservices + the main frontend (gulp) + the 5 auxiliary
# Angular frontends (ui-openview/content/monitoring/artifacts/bridging, via `ng serve`)
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
# ------------------------------------------------------------------------------
export CEDAR_HOME="${CEDAR_HOME:-$HOME/CEDAR}"
source "$CEDAR_HOME/cedar-profile-native-develop.sh" >/dev/null 2>&1
export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null)"   # CEDAR + Keycloak need JDK 17
PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"                    # /opt/homebrew/bin for node + ng (aux frontends)

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
  "ui-openview 4220 0"
  "ui-content 4240 0"
  "ui-monitoring 4300 0"
  "ui-artifacts 4320 0"
  "ui-bridging 4340 0"
)

# ng-serve source dir for each aux (ui-*) frontend
fe_dir() {
  case "$1" in
    ui-openview)   echo "$CEDAR_HOME/cedar-openview/cedar-openview-src" ;;
    ui-content)    echo "$CEDAR_HOME/cedar-content-distribution" ;;
    ui-monitoring) echo "$CEDAR_HOME/cedar-monitoring/cedar-monitoring-src" ;;
    ui-artifacts)  echo "$CEDAR_HOME/cedar-artifacts/cedar-artifacts-src" ;;
    ui-bridging)   echo "$CEDAR_HOME/cedar-bridging/cedar-bridging-src" ;;
  esac
}

svc_field() { local n=$1 f=$2; for s in "${SERVICES[@]}"; do set -- $s; [ "$1" = "$n" ] && { echo "${!f}"; return; }; done; }
app_port()  { svc_field "$1" 2; }
admin_port(){ svc_field "$1" 3; }
pidfile()   { echo "$RUN/$1.pid"; }
logfile()   { case "$1" in frontend) echo "$LOGDIR/cedar-frontend.log";; ui-*) echo "$LOGDIR/frontend-${1#ui-}.log";; *) echo "$LOGDIR/cedar-$1-server.log";; esac; }
alive()     { local p; p=$(cat "$(pidfile "$1")" 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
port_open() { nc -z -G1 127.0.0.1 "$1" >/dev/null 2>&1; }

# Whoever is actually listening, pidfile or not. Two services were once started outside this script;
# stop skipped them because no pidfile named them, restart therefore left them up, and they went on
# serving two-day-old jars while status called them healthy. Ownership is the port, not the pidfile.
port_owner() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; }
owner_of()  { local p; p=$(cat "$(pidfile "$1")" 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "$p"; else port_owner "$(app_port "$1")"; fi; }

jar_of() { echo "$CEDAR_HOME/cedar-$1-server/cedar-$1-server-application/target/cedar-$1-server-application-${CEDAR_VERSION}.jar"; }

# A service can be healthy and still be serving code from before the last build, which makes a green
# gate meaningless. Compare when the process started against when its jar was written.
binary_of() {  # echoes current|STALE|- for a service and the pid serving it
  local name=$1 pid=$2 jar started j_epoch p_epoch
  case "$name" in frontend|ui-*) echo '-'; return;; esac
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
  local name=$1 app; app=$(app_port "$name"); local log; log=$(logfile "$name")
  if alive "$name"; then echo "  $name: already running (pid $(cat "$(pidfile "$name")"))"; return; fi
  if port_open "$app"; then echo "  $name: port $app already in use (started elsewhere) — skipping"; return; fi
  case "$name" in
    frontend)
      ( cd "$CEDAR_HOME/cedar-template-editor" && exec nohup gulp >"$log" 2>&1 ) & ;;
    ui-*)
      local dir; dir=$(fe_dir "$name")
      [ -d "$dir" ] || { echo "  $name: SRC MISSING ($dir) — skip"; return; }
      ( cd "$dir" && exec nohup ng serve --port "$app" --host 127.0.0.1 >"$log" 2>&1 ) & ;;
    *)
      local jar="$CEDAR_HOME/cedar-$name-server/cedar-$name-server-application/target/cedar-$name-server-application-${CEDAR_VERSION}.jar"
      local cfg="$CEDAR_HOME/cedar-$name-server/cedar-$name-server-application/src/main/resources/config.yml"
      [ -f "$jar" ] || { echo "  $name: JAR MISSING ($jar) — build it first"; return; }
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
  local name=$1 p; p=$(cat "$(pidfile "$name")" 2>/dev/null)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; echo "  stopped $name (pid $p)"
  else
    # No pidfile, but something may still hold the port. Stopping it is the whole point of stop:
    # leaving it up is how a restart silently keeps serving the previous build.
    local owner; owner=$(port_owner "$(app_port "$name")")
    if [ -n "$owner" ]; then
      pkill -TERM -P "$owner" 2>/dev/null; kill -TERM "$owner" 2>/dev/null
      echo "  stopped $name (pid $owner, adopted — it had no pidfile, started outside this script)"
    else echo "  $name: not running"; fi
  fi
  rm -f "$(pidfile "$name")"
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
  local up=0 total=0 stale=0 unmanaged=0
  while read -r name; do
    total=$((total+1))
    local p own pid_disp port_disp h bin errs
    p=$(cat "$(pidfile "$name")" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then pid_disp="$p"; own="$p"
    else
      # A tilde marks a process this script does not own, so it can never again read as a clean "-".
      own=$(port_owner "$(app_port "$name")")
      [ -n "$own" ] && { pid_disp="~$own"; unmanaged=$((unmanaged+1)); } || pid_disp="-"
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
  return 0
}

cmd="${1:-status}"; shift 2>/dev/null
case "$cmd" in
  start)   echo "Starting CEDAR app tier (JDK 17)..."; while read -r n; do start_one "$n"; sleep 3; done < <(names "$@") ;;
  stop)    while read -r n; do stop_one "$n"; done < <(names "$@") ;;
  restart) "$0" stop "$@"; sleep 2; "$0" start "$@" ;;
  status)  status ;;
  watch)   while true; do clear; date; status; sleep 5; done ;;
  health)  bad=0; while read -r n; do [ "$(health_of "$n")" = healthy ] || bad=1; done < <(names); exit $bad ;;
  logs)    [ -n "$1" ] && tail -f "$(logfile "$1")" || echo "usage: $0 logs <service>" ;;
  *) echo "usage: $0 {start|stop|restart|status|watch|logs <name>|health} [name...]" ;;
esac
