#!/usr/bin/env python3
"""Decide which templates can take a created @context.required without invalidating an instance.

The repair tightens what an instance must carry, so a template with instances is only safe when every
instance it already has still validates against the proposed body. Nothing is written: the proposed
body is validated in memory, against the same library the audit uses.
"""
import argparse, collections, importlib.util, json, pathlib, sys, urllib.parse, urllib.request
import concurrent.futures as cf


OPS = pathlib.Path(__file__).resolve().parent.parent


def load(name):
    here = pathlib.Path(__file__).with_name(f"{name}.py")
    spec = importlib.util.spec_from_file_location(name, here if here.is_file() else OPS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


audit = load("cedar_artifact_validation_audit")
repair = load("cedar_artifact_repair")

parser = argparse.ArgumentParser()
parser.add_argument("--api-key-file", required=True)
parser.add_argument("--templates", required=True, help="JSON list of template IDs to weigh")
parser.add_argument("--records", required=True, help="audit records naming each template's instances")
parser.add_argument("--out", required=True)
parser.add_argument("--server", default="https://resource.metadatacenter.org")
parser.add_argument("--java-log", default="/tmp/ctxreq-at-risk-java.log")
arguments = parser.parse_args()

key = pathlib.Path(arguments.api_key_file).expanduser().read_text().strip()
wanted = set(json.load(open(arguments.templates)))

instances = collections.defaultdict(list)
for line in open(arguments.records):
    line = line.strip()
    if not line:
        continue
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if record.get("artifactType") != "instance":
        continue
    template_id = (record.get("validation") or {}).get("templateId")
    if template_id in wanted:
        instances[template_id].append(record["artifactId"])

print(f"weighing {len(wanted)} templates over {sum(len(v) for v in instances.values())} instances",
      flush=True)


def get(artifact_id, segment):
    url = f"{arguments.server}/{segment}/{urllib.parse.quote(artifact_id, safe='')}"
    request = urllib.request.Request(url, headers={"Authorization": f"apiKey {key}",
                                                   "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as answer:
        return json.load(answer)


java, classpath = audit.resolve_toolchain(
    argparse.Namespace(java=None, classpath=None), parser)
bridge = audit.ValidationBridge(java, classpath, audit.BRIDGE_SOURCE, 500, "2g",
                                pathlib.Path(arguments.java_log), 180)
bridge.start()

verdicts = []
safe = at_risk = refused = 0
for number, template_id in enumerate(sorted(wanted), 1):
    row = {"templateId": template_id, "instances": len(instances[template_id])}
    try:
        stored = get(template_id, "templates")
    except Exception as error:
        row.update(outcome="template-unreadable", detail=str(error)[:160])
        verdicts.append(row); refused += 1; continue
    try:
        proposed, changes = repair.complete_context_required(stored)
    except repair.TransformRefused as refusal:
        row.update(outcome="transform-refused", detail=str(refusal)[:160])
        verdicts.append(row); refused += 1; continue
    row["paths"] = len(changes)
    if not changes:
        row.update(outcome="already-clean")
        verdicts.append(row); safe += 1; continue
    if bridge.validate("template", proposed).get("status") != "valid":
        row.update(outcome="proposed-body-invalid")
        verdicts.append(row); refused += 1; continue

    bodies = {}
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(get, i, "template-instances"): i for i in instances[template_id]}
        for future in cf.as_completed(futures):
            try:
                bodies[futures[future]] = future.result()
            except Exception:
                bodies[futures[future]] = None

    broke, unreadable = [], 0
    bridge.cache_template(template_id, stored)
    was_valid = set()
    for identifier, body in bodies.items():
        if body is None:
            unreadable += 1
            continue
        if bridge.validate("instance", body, template_id).get("status") == "valid":
            was_valid.add(identifier)
    bridge.cache_template(template_id, proposed)
    for identifier in was_valid:
        if bridge.validate("instance", bodies[identifier], template_id).get("status") != "valid":
            broke.append(identifier)

    row.update(outcome="at-risk" if broke else "safe", wouldBreak=len(broke),
               validBefore=len(was_valid), unreadable=unreadable)
    if broke:
        row["examples"] = broke[:3]
        at_risk += 1
    else:
        safe += 1
    verdicts.append(row)
    if number % 20 == 0:
        print(f"[{number}/{len(wanted)}] safe={safe} at-risk={at_risk} refused={refused}", flush=True)

bridge.kill()
with open(arguments.out, "w", encoding="utf-8") as stream:
    for row in verdicts:
        stream.write(json.dumps(row) + "\n")
print(f"\nsafe={safe} at-risk={at_risk} refused={refused}; verdicts in {arguments.out}")
json.dump([r["templateId"] for r in verdicts if r["outcome"] in ("safe", "already-clean")],
          open(arguments.out.replace(".jsonl", "-safe.json"), "w"))
