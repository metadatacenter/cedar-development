#!/bin/bash
# ------------------------------------------------------------------------------
# cedar-services.sh — start / stop / monitor the CEDAR app tier without 15 consoles.
#
# Runs the 15 Dropwizard microservices + the main frontend (gulp) + the 5 auxiliary
# Angular frontends (ui-openview/content/monitoring/artifacts/bridging, via `ng serve`)
# as background processes (nohup), each logging to $CEDAR_HOME/log/, PIDs in
# $CEDAR_HOME/log/run/. One `status` view shows PID / port / health / error-count.
# Frontend health is port-only (no Dropwizard /healthcheck). The non-essential CEE
# demos (cee-dev/demo.cee/docs.cee) are NOT managed here — cedarcli doesn't start them
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
export CEDAR_HOME="${CEDAR_HOME:-/Users/martin/CEDAR}"
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
      nohup java -jar "$jar" server "$cfg" >"$log" 2>&1 & ;;
  esac
  echo $! > "$(pidfile "$name")"
  echo "  started $name (pid $!) -> port $app, log $log"
}

stop_one() {
  local name=$1 p; p=$(cat "$(pidfile "$name")" 2>/dev/null)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; echo "  stopped $name (pid $p)"
  else echo "  $name: not running (per pidfile)"; fi
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
  printf "%-18s %-8s %-6s %-10s %s\n" SERVICE PID PORT HEALTH "ERRORS(log)"
  printf "%-18s %-8s %-6s %-10s %s\n" "------" "---" "----" "------" "-----------"
  local up=0 total=0
  while read -r name; do
    total=$((total+1))
    local p pid_disp port_disp h errs
    p=$(cat "$(pidfile "$name")" 2>/dev/null); pid_disp="-"; kill -0 "$p" 2>/dev/null && pid_disp="$p"
    port_open "$(app_port "$name")" && port_disp="up" || port_disp="down"
    h=$(health_of "$name"); [ "$h" = healthy ] && up=$((up+1))
    # Exclude logback's own configuration chatter, which mentions appenders named FILE-ERROR
    errs=$(grep -iE "ERROR|Exception" "$(logfile "$name")" 2>/dev/null | grep -cv "|-INFO in"); errs=${errs:-0}
    printf "%-18s %-8s %-6s %-10s %s\n" "$name" "$pid_disp" "$port_disp" "$h" "$errs"
  done < <(names)
  echo "-------------------------------------------------------------"
  echo "healthy: $up / $total   (login at https://cedar.$CEDAR_HOST once frontend + resource/user are healthy)"
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
