#!/bin/bash
# Purge CEDAR snapshots from Nexus through cleanup policies rather than per-component DELETEs.
#
#   ./nexus_snapshot_cleanup.sh preview      # read-only: what each policy would remove, and what survives
#   ./nexus_snapshot_cleanup.sh create       # create the three policies, attached to nothing
#   ./nexus_snapshot_cleanup.sh arm          # attach them — the daily 01:00 cleanup task then deletes
#   ./nexus_snapshot_cleanup.sh disarm       # detach them again
#
# Nothing is deleted by this script. "arm" hands the deletion to Nexus's own scheduled task,
# which runs on cron "0 0 1 * * ?" and needs no further click.
set -euo pipefail

AGE_DAYS=${AGE_DAYS:-3}          # remove only what has not been written for this many days
NEXUS=${NEXUS:-https://nexus.bmir.stanford.edu}
API="$NEXUS/service/rest"

eval "$(python3 -c "
import xml.etree.ElementTree as ET, os, shlex
ns={'m':'http://maven.apache.org/SETTINGS/1.0.0'}
t=ET.parse(os.path.expanduser('~/.m2/settings.xml'))
for s in t.getroot().iter('{http://maven.apache.org/SETTINGS/1.0.0}server'):
    i=s.find('m:id',ns)
    if i is not None and i.text=='bmir-nexus-releases':
        print('NX_U=%s' % shlex.quote(s.find('m:username',ns).text))
        print('NX_P=%s' % shlex.quote(s.find('m:password',ns).text))
")"
export NX_U NX_P AGE_DAYS API

case "${1:-preview}" in
  preview) python3 - <<'PY'
import base64, json, os, urllib.request, datetime, re, collections
auth=base64.b64encode(f"{os.environ['NX_U']}:{os.environ['NX_P']}".encode()).decode()
API=os.environ['API']; AGE=int(os.environ['AGE_DAYS'])
cut=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=AGE)
def get(u):
    r=urllib.request.Request(u, headers={"Authorization":f"Basic {auth}"})
    with urllib.request.urlopen(r, timeout=60) as x: return json.load(x)
PLAN={"snapshots":"maven-pre","maven-snapshots":"maven-pre","cedar-maven-dev":"maven-pre",
      "npm-cedar":"npm-pre","docker-cedar":"docker-dev","docker-cedar-internal":"docker-dev"}
print("age threshold: %d days (blob last written before %s)\n" % (AGE, cut.date()))
print("%-24s %8s %8s %8s   %s" % ("REPOSITORY","TOTAL","REMOVE","KEEP","newest kept"))
for repo,kind in PLAN.items():
    tot=rm=0; keep=[]; token=None
    while True:
        d=get(f"{API}/v1/components?repository={repo}"+(f"&continuationToken={token}" if token else ""))
        for c in d["items"]:
            tot+=1; v=c.get("version") or ""
            pre = ("SNAPSHOT" in v.upper() or re.search(r"-\d{8}\.\d{6}-\d+$",v) or "-dev." in v)
            if kind=="docker-dev": pre = bool(re.search(r"-dev\.",v))
            ts=max([a.get("blobCreated") or "" for a in c.get("assets",[])] or [""])
            old = ts[:19] < cut.strftime("%Y-%m-%dT%H:%M:%S") if ts else False
            if pre and old: rm+=1
            else: keep.append((ts,"%s:%s"%(c.get("name"),v)))
        token=d.get("continuationToken")
        if not token: break
    keep.sort(reverse=True)
    print("%-24s %8d %8d %8d   %s" % (repo,tot,rm,len(keep), keep[0][1] if keep else "-"))
PY
  ;;
  create) python3 - <<'PY'
import base64, json, os, urllib.request, urllib.error
auth=base64.b64encode(f"{os.environ['NX_U']}:{os.environ['NX_P']}".encode()).decode()
URL=os.environ['API']+"/internal/cleanup-policies"; AGE=int(os.environ['AGE_DAYS'])
P=[("cedar_maven_snapshots_purge","maven2","PRERELEASES",None,
    "CEDAR: maven SNAPSHOTs older than %dd. PRERELEASES never matches a release."%AGE),
   ("cedar_npm_prereleases_purge","npm","PRERELEASES",None,
    "CEDAR: npm prereleases older than %dd. Released versions are untouched."%AGE),
   ("cedar_docker_dev_purge","docker",None,r".*-dev\..*",
    "CEDAR: docker train tags X.Y.Z-dev.DATE.TIME older than %dd. docker has no isPrerelease."%AGE)]
for name,fmt,rel,rx,notes in P:
    body=json.dumps({"name":name,"format":fmt,"notes":notes,"criteriaLastBlobUpdated":AGE,
        "criteriaLastDownloaded":None,"criteriaReleaseType":rel,"criteriaAssetRegex":rx,
        "retain":None,"sortBy":None}).encode()
    req=urllib.request.Request(URL,data=body,method="POST",
        headers={"Authorization":f"Basic {auth}","Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=60) as r: print("created %-30s HTTP %s"%(name,r.status))
    except urllib.error.HTTPError as e: print("FAILED  %-30s HTTP %s %s"%(name,e.code,e.read().decode()[:200]))
PY
  ;;
  arm|disarm) python3 - "$1" <<'PY'
import base64, json, os, sys, urllib.request
auth=base64.b64encode(f"{os.environ['NX_U']}:{os.environ['NX_P']}".encode()).decode()
API=os.environ['API']; arm = sys.argv[1]=="arm"
MAP={"snapshots":"cedar_maven_snapshots_purge","maven-snapshots":"cedar_maven_snapshots_purge",
     "cedar-maven-dev":"cedar_maven_snapshots_purge","npm-cedar":"cedar_npm_prereleases_purge",
     "docker-cedar":"cedar_docker_dev_purge","docker-cedar-internal":"cedar_docker_dev_purge"}
def call(u,data=None,method="GET"):
    r=urllib.request.Request(u,data=data,method=method,
        headers={"Authorization":f"Basic {auth}","Content-Type":"application/json"})
    with urllib.request.urlopen(r,timeout=60) as x:
        return json.load(x) if x.status==200 and x.headers.get("Content-Type","").startswith("application/json") else None
for repo,policy in MAP.items():
    cfg=call(f"{API}/v1/repositories/{repo}")
    fmt,typ=cfg["format"],cfg["type"]
    existing=set(cfg.get("cleanup",{}).get("policyNames") or []) if cfg.get("cleanup") else set()
    new = (existing | {policy}) if arm else (existing - {policy})
    cfg["cleanup"]={"policyNames":sorted(new)}
    for k in ("format","type","url"): cfg.pop(k,None)
    call(f"{API}/v1/repositories/{fmt}/{typ}/{repo}",json.dumps(cfg).encode(),"PUT")
    print("%-24s policies -> %s" % (repo, sorted(new) or "none"))
print("\nCleanup service cron is 0 0 1 * * ? — it will act on this at the next 01:00 run.")
PY
  ;;
  *) echo "usage: $0 {preview|create|arm|disarm}" >&2; exit 2 ;;
esac
