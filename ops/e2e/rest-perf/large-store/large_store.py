#!/usr/bin/env python3
"""Hold a production snapshot in a store of its own, and switch the native stack onto it.

The workstation's graph holds a few hundred artifacts, so a REST performance profile run against it
cannot show a cost that grows with the data. Production holds about 150,000 schema artifacts and as
many instances, and ``ops/cedar_snapshot.py`` keeps a verified archive of them. This tool loads such
an archive into Mongo, Neo4j and OpenSearch containers whose volumes belong to it alone (see
``compose.yml`` beside it), so the native stores and their data are never written.

Four commands make and use the store:

- ``build`` exports the native graph's users, groups and folders through the admin tool's read-only
  ``impex-exportAll``, and writes them, together with every artifact the snapshot served, as an
  import tree in the admin tool's format. Each snapshot artifact gets a perf identity as its owner
  and a folder in that identity's home.
- ``load`` starts the containers on side ports, so the native stack keeps serving, and imports the
  tree with ``impex-importAll``. The import writes the documents and graph nodes directly, as an
  export restore does: no artifact is validated or changed on the way in, so the store holds what
  production holds, invalid artifacts included.
- ``serve`` stops the native microservices and the three native stores, publishes the containers on
  the native ports, starts the microservices against them, and rebuilds the search index the first
  time a load is served.
- ``release`` reverses ``serve``.

``status`` reports which store the native stack is using, and ``discard`` removes the containers
and their volumes. State lives under
``$CEDAR_HOME/.cedar/large-store/``; ``state.json`` there is what the REST harness reads to refuse a
run whose ``--store`` does not match the store being served.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

HERE = Path(__file__).resolve().parent
OPS = HERE.parents[2]
sys.path.insert(0, str(OPS))

COMPOSE_FILE = HERE / "compose.yml"
PERF_EMAIL = re.compile(r"^restperf-(\d{3})@test\.com$")
PRODUCTION_BASES = ("https://repo.metadatacenter.net/", "https://repo.metadatacenter.org/")
SCHEMA_TYPES = ("template", "element", "field")
TYPE_PATHS = {"template": "templates", "element": "template-elements", "field": "template-fields",
              "instance": "template-instances"}
CONTEXT = {"schema": "http://schema.org/", "pav": "http://purl.org/pav/",
           "bibo": "http://purl.org/ontology/bibo/", "oslc": "http://open-services.net/ns/core#"}
# Schema artifacts are filed in folders of this many. Instances share a folder per template, up to
# INSTANCE_FOLDER_SIZE, so the store holds a few folders of tens of thousands of children beside many
# small ones. One production template has about 120,000 instances, and a single folder of that size
# would dominate every folder measurement.
SCHEMA_FOLDER_SIZE = 1000
INSTANCE_FOLDER_SIZE = 20000
# Folder identifiers derive from this namespace, so building twice from one snapshot gives one tree.
FOLDER_NAMESPACE = uuid.UUID("6f1c2d0e-8b7a-4c55-9a3e-1d2b3c4d5e6f")

SIDE_PORTS = {"LARGE_STORE_MONGO_PORT": "27018", "LARGE_STORE_NEO4J_HTTP_PORT": "7475",
              "LARGE_STORE_NEO4J_BOLT_PORT": "7688", "LARGE_STORE_OPENSEARCH_PORT": "9201",
              "LARGE_STORE_OPENSEARCH_TRANSPORT_PORT": "9301"}
NATIVE_PORTS = {"LARGE_STORE_MONGO_PORT": "27017", "LARGE_STORE_NEO4J_HTTP_PORT": "7474",
                "LARGE_STORE_NEO4J_BOLT_PORT": "7687", "LARGE_STORE_OPENSEARCH_PORT": "9200",
                "LARGE_STORE_OPENSEARCH_TRANSPORT_PORT": "9300"}


# --- Reading the snapshot -------------------------------------------------------------------------

class DuplicateKey(ValueError):
    pass


def _refuse_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    seen: dict[str, Any] = {}
    for key, value in pairs:
        if key in seen:
            raise DuplicateKey(key)
        seen[key] = value
    return seen


def parse_body(body: bytes) -> dict[str, Any]:
    """The body as the importer will read it. Its JSON reader refuses a duplicated key, and the
    importer reads every archive before it changes anything, so one such body would stop the load."""
    document = json.loads(body, object_pairs_hook=_refuse_duplicates)
    if not isinstance(document, dict):
        raise ValueError("not a JSON object")
    return document


def localize(text: str, local_base: str) -> str:
    """Production identifiers rewritten onto the local repository base, so a document's references
    to other artifacts resolve in the store it is loaded into."""
    for base in PRODUCTION_BASES:
        text = text.replace(base, local_base)
    return text


def reference(document: dict[str, Any], key: str) -> Optional[str]:
    value = document.get(key)
    return value if isinstance(value, str) and value else None


def text_value(document: dict[str, Any], key: str) -> str:
    value = document.get(key)
    return value if isinstance(value, str) else ""


def timestamp(value: Any, fallback: datetime) -> tuple[str, int]:
    """An ISO timestamp and its epoch seconds, as a graph node records both."""
    moment = None
    if isinstance(value, str):
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            moment = None
    if moment is None or moment.tzinfo is None:
        moment = fallback
    return moment.isoformat(timespec="seconds"), int(moment.timestamp())


# --- Version series -------------------------------------------------------------------------------

def series_flags(artifacts: dict[str, dict[str, Any]]) -> tuple[dict[str, str], dict[str, dict[str, bool]]]:
    """Each schema artifact's series root, and its three latest-version flags.

    ``artifacts`` maps an identifier to its version facts: ``previous``, ``status`` and ``created``.
    A series is followed through ``pav:previousVersion``. Where production has branched one, the
    successor created last continues the line, so every series has one latest version.
    """
    successors: dict[str, list[str]] = defaultdict(list)
    for artifact_id, facts in artifacts.items():
        previous = facts.get("previous")
        if previous in artifacts and previous != artifact_id:
            successors[previous].append(artifact_id)

    roots: dict[str, str] = {}
    flags: dict[str, dict[str, bool]] = {}
    for artifact_id in artifacts:
        if artifacts[artifact_id].get("previous") in artifacts:
            continue
        line = [artifact_id]
        visited = {artifact_id}
        while successors.get(line[-1]):
            following = max(successors[line[-1]], key=lambda candidate: artifacts[candidate].get("created", ""))
            if following in visited:
                break
            visited.add(following)
            line.append(following)
        published = [member for member in line if artifacts[member].get("status") == "bibo:published"]
        for member in line:
            roots[member] = artifact_id
            flags[member] = {
                "isLatestVersion": member == line[-1],
                "isLatestDraftVersion": member == line[-1] and artifacts[member].get("status") != "bibo:published",
                "isLatestPublishedVersion": bool(published) and member == published[-1],
            }
    # A member of a cycle, or of a branch the line did not take, has no root yet. It stands alone.
    for artifact_id in artifacts:
        if artifact_id not in roots:
            roots[artifact_id] = artifact_id
            flags[artifact_id] = {"isLatestVersion": True,
                                  "isLatestDraftVersion": artifacts[artifact_id].get("status") != "bibo:published",
                                  "isLatestPublishedVersion": artifacts[artifact_id].get("status") == "bibo:published"}
    return roots, flags


def owner_index(key: str, owners: int) -> int:
    return int(hashlib.sha256(key.encode()).hexdigest(), 16) % owners


# --- Graph nodes ----------------------------------------------------------------------------------

def base_node(resource_id: str, resource_type: str, name: str, owner: str, created: tuple[str, int],
              updated: tuple[str, int]) -> dict[str, Any]:
    return {
        "resourceId": {"id": resource_id}, "path": None, "parentPath": None, "everybodyPermission": None,
        "isOpen": False, "schema:description": "", "schema:identifier": None, "pathInfo": [],
        "ownedBy": owner, "pav:createdBy": owner, "oslc:modifiedBy": owner, "ownedByUserName": None,
        "createdByUserName": None, "lastUpdatedByUserName": None, "schema:name": name,
        "@id": resource_id, "resourceType": resource_type, "createdOnTS": created[1],
        "lastUpdatedOnTS": updated[1], "@context": CONTEXT, "pav:createdOn": created[0],
        "pav:lastUpdatedOn": updated[0], "sourceHash": None,
    }


def folder_node(folder_id: str, name: str, description: str, owner: str, now: tuple[str, int]) -> dict[str, Any]:
    node = base_node(folder_id, "folder", name, owner, now, now)
    node.update({"homeOf": None, "isUserHome": False, "isSystem": False, "isRoot": False,
                 "schema:description": description})
    return node


def artifact_node(resource_type: str, resource_id: str, document: dict[str, Any], owner: str,
                  flags: Optional[dict[str, bool]], now: datetime) -> dict[str, Any]:
    created = timestamp(document.get("pav:createdOn"), now)
    updated = timestamp(document.get("pav:lastUpdatedOn"), now)
    node = base_node(resource_id, resource_type, text_value(document, "schema:name"), owner, created, updated)
    node["schema:description"] = text_value(document, "schema:description")
    node["schema:identifier"] = reference(document, "schema:identifier")
    derived = reference(document, "pav:derivedFrom")
    node["pav:derivedFrom"] = {"id": derived} if derived else None
    node["doi"] = None
    if resource_type == "instance":
        based_on = reference(document, "schema:isBasedOn")
        node["schema:isBasedOn"] = {"id": based_on} if based_on else None
    else:
        previous = reference(document, "pav:previousVersion")
        node["pav:version"] = text_value(document, "pav:version") or "0.0.1"
        node["bibo:status"] = text_value(document, "bibo:status") or "bibo:draft"
        node["pav:previousVersion"] = {"id": previous} if previous else None
        node.update(flags or {"isLatestVersion": True, "isLatestDraftVersion": True,
                              "isLatestPublishedVersion": False})
    return node


def arcs(owner: str, parent: str, target: str) -> list[dict[str, str]]:
    return [{"sourceId": owner, "label": "OWNS", "targetId": target},
            {"sourceId": parent, "label": "CONTAINS", "targetId": target}]


def write_archive(path: Path, parts: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for name, value in parts.items():
            archive.writestr(name, value if isinstance(value, (bytes, str)) else json.dumps(value))


# --- The native export ----------------------------------------------------------------------------

def read_archive(path: Path, member: str) -> Any:
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read(member))


def perf_identities(export: Path) -> list[dict[str, str]]:
    """The fifty perf identities the profiles sign in as, each with its home folder."""
    folders: set[str] = set()
    for archive in (export / "resources").rglob("*.zip"):
        node = read_archive(archive, "resource.json")
        if node.get("resourceType") == "folder":
            folders.add(node["@id"])
    identities, missing = [], []
    for archive in (export / "users").rglob("*.zip"):
        user = read_archive(archive, "content.json")
        if not PERF_EMAIL.match(user.get("email") or ""):
            continue
        if user.get("homeFolderId") in folders:
            identities.append({"id": user["@id"], "email": user["email"], "home": user["homeFolderId"]})
        else:
            missing.append(user["email"])
    if not identities or missing:
        raise SystemExit(f"The native graph has {len(identities)} perf identities with a home folder; these "
                         f"have none: {sorted(missing)}. Run `npm run perf:rest:provision` first.")
    return sorted(identities, key=lambda identity: identity["email"])


# --- build ----------------------------------------------------------------------------------------

class TreeBuilder:
    def __init__(self, tree: Path, local_base: str, identities: list[dict[str, str]], now: datetime):
        self.resources = tree / "resources" / "large-store"
        self.local_base = local_base
        self.identities = identities
        self.now = now
        self.now_stamp = timestamp(None, now)
        self.folders: dict[str, str] = {}
        self.folder_children: dict[str, int] = defaultdict(int)
        self.sibling_names: dict[str, set[str]] = defaultdict(set)

    def folder_id(self, *names: str) -> str:
        return f"{self.local_base}folders/{uuid.uuid5(FOLDER_NAMESPACE, '/'.join(names))}"

    def sibling_name(self, parent: str, name: str) -> str:
        """A name no sibling folder holds, ignoring case, as the graph's constraint on folders requires.

        Two templates can share a name, and so would their instance folders under one owner's root.
        """
        taken = self.sibling_names[parent]
        candidate, n = name, 1
        while candidate.casefold() in taken:
            n += 1
            candidate = f"{name} [{n}]"
        taken.add(candidate.casefold())
        return candidate

    def folder(self, owner: dict[str, str], parent: str, name: str, description: str, *path: str) -> str:
        folder_id = self.folder_id(owner["email"], *path)
        if folder_id not in self.folders:
            name = self.sibling_name(parent, name)
            self.folders[folder_id] = name
            uid = folder_id.rsplit("/", 1)[1]
            write_archive(self.resources / uid[:2] / f"{uid}.zip", {
                "resource.json": folder_node(folder_id, name, description, owner["id"], self.now_stamp),
                "arcs-incoming.json": arcs(owner["id"], parent, folder_id),
            })
        return folder_id

    def root(self, owner: dict[str, str]) -> str:
        return self.folder(owner, owner["home"], "Large store",
                           "Artifacts loaded from a production snapshot", "large-store")

    def schema_folder(self, owner: dict[str, str], resource_type: str, ordinal: int) -> str:
        label = TYPE_PATHS[resource_type].replace("template-", "").capitalize()
        return self.folder(owner, self.root(owner), f"{label} {ordinal:03d}", "", "large-store",
                           resource_type, str(ordinal))

    def instance_folder(self, owner: dict[str, str], template_id: Optional[str], template_name: str,
                        ordinal: int) -> str:
        key = template_id or "no-template"
        name = f"Instances of {template_name}"[:190] if template_id else "Instances without a template"
        if ordinal > 1:
            name = f"{name} ({ordinal})"
        return self.folder(owner, self.root(owner), name, "", "large-store", "instances", key, str(ordinal))

    def artifact(self, resource_type: str, resource_id: str, body: str, node: dict[str, Any],
                 owner: dict[str, str], parent: str) -> None:
        uid = resource_id.rsplit("/", 1)[1]
        write_archive(self.resources / uid[:2] / f"{uid}.zip", {
            "resource.json": node, "content.json": body,
            "arcs-incoming.json": arcs(owner["id"], parent, resource_id),
        })
        self.folder_children[parent] += 1


def build(args: argparse.Namespace) -> int:
    from cedar_snapshot import Snapshot

    env = profile_environment()
    state_dir = state_root(env)
    snapshot = Snapshot(args.snapshot) if args.snapshot else Snapshot.latest(args.deployment)
    manifest, _ = snapshot.header()
    archive_name = manifest.get("archive", {}).get("name") or Path(snapshot.path).name
    local_base = f"https://repo.{env['CEDAR_HOST']}/"

    export = state_dir / "native-export"
    shutil.rmtree(export, ignore_errors=True)
    export.mkdir(parents=True)
    print(f"Exporting the native graph's users, groups and folders to {export}", flush=True)
    admin_tool(env, ["impex-exportAll"], properties={"cedar.importExport.exportDir": f"{export}/"},
               log=state_dir / "native-export.log")
    identities = perf_identities(export)

    tree = state_dir / "import"
    shutil.rmtree(tree, ignore_errors=True)
    for part in ("users", "groups", "resources"):
        shutil.copytree(export / part, tree / part)

    now = datetime.now(timezone.utc)
    excluded: dict[str, list[str]] = defaultdict(list)

    # First pass: the version facts of every schema artifact and the template of every instance,
    # which decide owners and folders before any archive is written.
    print("Reading the snapshot's version series", flush=True)
    versions: dict[str, dict[str, Any]] = {}
    template_names: dict[str, str] = {}
    for entry, body in snapshot.artifacts(SCHEMA_TYPES):
        try:
            document = parse_body(body)
        except ValueError as error:
            excluded[f"{entry['type']}: {type(error).__name__}"].append(entry["id"])
            continue
        artifact_id = localize(entry["id"], local_base)
        versions[artifact_id] = {"previous": localize(reference(document, "pav:previousVersion") or "", local_base),
                                 "status": text_value(document, "bibo:status"),
                                 "created": text_value(document, "pav:createdOn")}
        if entry["type"] == "template":
            template_names[artifact_id] = text_value(document, "schema:name") or "an unnamed template"
    roots, flags = series_flags(versions)

    def owner_of_series(artifact_id: str) -> dict[str, str]:
        return identities[owner_index(roots.get(artifact_id, artifact_id), len(identities))]

    builder = TreeBuilder(tree, local_base, identities, now)
    counts: dict[str, int] = defaultdict(int)
    schema_positions: dict[tuple[str, str], int] = defaultdict(int)
    instance_positions: dict[tuple[str, Optional[str]], int] = defaultdict(int)
    print("Writing the import tree", flush=True)
    for index, (entry, body) in enumerate(snapshot.artifacts(), start=1):
        resource_type = entry["type"]
        try:
            text = localize(body.decode("utf-8"), local_base)
            document = parse_body(text.encode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            if resource_type == "instance":
                excluded[f"instance: {type(error).__name__}"].append(entry["id"])
            continue
        resource_id = localize(entry["id"], local_base)
        if reference(document, "@id") != resource_id:
            excluded[f"{resource_type}: @id differs from its address"].append(entry["id"])
            continue
        if resource_type == "instance":
            template_id = reference(document, "schema:isBasedOn")
            owner = owner_of_series(template_id) if template_id in versions else \
                identities[owner_index(resource_id, len(identities))]
            folder_template = template_id if template_id in template_names else None
            position = instance_positions[(owner["id"], folder_template)]
            instance_positions[(owner["id"], folder_template)] += 1
            parent = builder.instance_folder(owner, folder_template, template_names.get(template_id or "", ""),
                                             position // INSTANCE_FOLDER_SIZE + 1)
        else:
            owner = owner_of_series(resource_id)
            position = schema_positions[(owner["id"], resource_type)]
            schema_positions[(owner["id"], resource_type)] += 1
            parent = builder.schema_folder(owner, resource_type, position // SCHEMA_FOLDER_SIZE + 1)
        node = artifact_node(resource_type, resource_id, document, owner["id"], flags.get(resource_id), now)
        builder.artifact(resource_type, resource_id, text, node, owner, parent)
        counts[resource_type] += 1
        if index % 20000 == 0:
            print(f"  {index} artifacts written", flush=True)

    largest = sorted(builder.folder_children.values(), reverse=True)[:5]
    summary = {
        "snapshot": archive_name,
        "snapshotFetchedAt": manifest.get("fetchedAt"),
        "builtAt": now.isoformat(timespec="seconds"),
        "artifacts": dict(counts),
        "folders": len(builder.folders),
        "largestFolders": largest,
        "excluded": {reason: len(ids) for reason, ids in excluded.items()},
        "owners": len(identities),
    }
    (state_dir / "excluded.json").write_text(json.dumps(excluded, indent=2) + "\n")
    (state_dir / "build.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


# --- load, serve, release -------------------------------------------------------------------------

def profile_environment() -> dict[str, str]:
    """The native profile's variables, sourced the way cedarcli supplies them to its children."""
    home = os.environ.get("CEDAR_HOME")
    if not home:
        raise SystemExit("Export CEDAR_HOME first.")
    profile = Path(home) / "cedar-development/bin/templates/cedar-profile-native.sh"
    script = (f'export CEDAR_HOME="{home}" CEDAR_PROFILE="${{CEDAR_PROFILE:-develop}}"; '
              f'source "{profile}" >/dev/null 2>&1; env -0')
    output = subprocess.run(["bash", "-c", script], check=True, capture_output=True).stdout
    env = dict(item.split("=", 1) for item in output.decode().split("\0") if "=" in item)
    env["JAVA_HOME"] = subprocess.run(["/usr/libexec/java_home", "-v", "17"], check=True,
                                      capture_output=True, text=True).stdout.strip()
    return env


def state_root(env: dict[str, str]) -> Path:
    root = Path(env["CEDAR_HOME"]) / ".cedar" / "large-store"
    root.mkdir(parents=True, exist_ok=True)
    return root


def read_state(env: dict[str, str]) -> dict[str, Any]:
    path = state_root(env) / "state.json"
    return json.loads(path.read_text()) if path.exists() else {"serving": False}


def write_state(env: dict[str, str], state: dict[str, Any]) -> None:
    path = state_root(env) / "state.json"
    path.write_text(json.dumps(state, indent=2) + "\n")


def admin_tool(env: dict[str, str], arguments: list[str], properties: dict[str, str] | None = None,
               overrides: dict[str, str] | None = None, log: Path | None = None, confirm: bool = False) -> None:
    jar = Path(env["CEDAR_HOME"]) / f"cedar-admin-tool/target/cedar-admin-tool-{env['CEDAR_VERSION']}.jar"
    if not jar.exists():
        raise SystemExit(f"{jar} is missing; `cedarcli build java` builds it.")
    command = [f"{env['JAVA_HOME']}/bin/java"]
    command += [f"-D{key}={value}" for key, value in (properties or {}).items()]
    command += ["-jar", str(jar), *arguments]
    child_env = {**env, **(overrides or {})}
    with open(log or os.devnull, "w") as sink:
        result = subprocess.run(command, env=child_env, input="yes\n" if confirm else None, text=True,
                                stdout=sink, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        raise SystemExit(f"`{' '.join(arguments)}` failed (exit {result.returncode}); see {log}.")


def compose(env: dict[str, str], ports: dict[str, str], *arguments: str) -> None:
    subprocess.run(["docker", "compose", "-f", str(COMPOSE_FILE), *arguments], env={**env, **ports}, check=True)


def ensure_mongo_user(env: dict[str, str]) -> None:
    """The application user the native store defines. Neither store enforces authentication, but
    the servers present this user's credentials, and a store that does not know the user refuses
    them. The script travels on stdin, so the password appears in no process listing."""
    user = json.dumps(env["CEDAR_MONGO_APP_USER_NAME"])
    password = json.dumps(env["CEDAR_MONGO_APP_USER_PASSWORD"])
    script = (f"var cedar = db.getSiblingDB('cedar');"
              f"if (!cedar.getUser({user})) {{ cedar.createUser({{user: {user}, pwd: {password}, "
              f"roles: [{{role: 'readWrite', db: 'cedar'}}]}}); }}\n")
    subprocess.run(["docker", "exec", "-i", "large-store-mongo", "mongo", "--quiet"], input=script, text=True,
                   check=True, stdout=subprocess.DEVNULL)


def side_overrides() -> dict[str, str]:
    return {"CEDAR_MONGO_PORT": SIDE_PORTS["LARGE_STORE_MONGO_PORT"],
            "CEDAR_NEO4J_REST_PORT": SIDE_PORTS["LARGE_STORE_NEO4J_HTTP_PORT"],
            "CEDAR_NEO4J_BOLT_PORT": SIDE_PORTS["LARGE_STORE_NEO4J_BOLT_PORT"],
            "CEDAR_OPENSEARCH_REST_PORT": SIDE_PORTS["LARGE_STORE_OPENSEARCH_PORT"]}


def load(args: argparse.Namespace) -> int:
    env = profile_environment()
    state_dir = state_root(env)
    if read_state(env).get("serving"):
        raise SystemExit("The large store is being served; `release` it before loading another.")
    build_record = state_dir / "build.json"
    if not build_record.exists():
        raise SystemExit("Nothing is built; run `build` first.")
    summary = json.loads(build_record.read_text())

    print("Starting the store's containers on side ports", flush=True)
    compose(env, SIDE_PORTS, "up", "-d", "--wait")
    ensure_mongo_user(env)
    started = time.monotonic()
    print("Creating the graph's indices and constraints", flush=True)
    admin_tool(env, ["graphDb-createIndices"], overrides=side_overrides(), log=state_dir / "indices.log")
    # An import copies documents, which carry no indexes. Without the unique @id index every lookup
    # by identifier is a collection scan, which at 150,000 instances costs a search rebuild hours.
    admin_tool(env, ["artifactServer-initDB"], overrides=side_overrides(), log=state_dir / "mongo-indices.log")
    print(f"Importing {sum(summary['artifacts'].values())} artifacts; progress is in {state_dir / 'import.log'}",
          flush=True)
    admin_tool(env, ["impex-importAll"], properties={"cedar.importExport.importDir": f"{state_dir / 'import'}/"},
               overrides=side_overrides(), log=state_dir / "import.log", confirm=True)
    # The import wipes the graph and the export carries no categories, so the root category, which
    # every report and category tree reads, is created afterwards with the other global objects.
    admin_tool(env, ["graphDb-createGlobalObjects"], overrides=side_overrides(),
               log=state_dir / "global-objects.log")
    compose(env, SIDE_PORTS, "stop")
    write_state(env, {"serving": False, "loaded": summary["snapshot"], "loadedAt": now_iso(),
                      "loadSeconds": round(time.monotonic() - started), "indexed": False,
                      "artifacts": summary["artifacts"]})
    print(f"Loaded {summary['snapshot']} in {round(time.monotonic() - started)} s. `serve` switches to it.")
    return 0


def infra(env: dict[str, str], *scripts: str) -> None:
    """Run the native stores' start and stop scripts, which the infra aliases name."""
    for script in scripts:
        subprocess.run(["bash", f"{env['CEDAR_UTIL_BIN']}/services-osx/{script}.sh"], env=env, check=True)


def cedarcli(env: dict[str, str], *arguments: str) -> None:
    subprocess.run(["bash", f"{env['CEDAR_HOME']}/cedar-cli/cli.sh", *arguments], env=env, check=True)


def wait_for_port_free(port: int, seconds: int = 120) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True).returncode != 0:
            return
        time.sleep(2)
    raise SystemExit(f"Port {port} is still in use after {seconds} s.")


def serve(args: argparse.Namespace) -> int:
    env = profile_environment()
    state = read_state(env)
    if state.get("serving"):
        print("The large store is already being served.")
        return 0
    if not state.get("loaded"):
        raise SystemExit("No snapshot is loaded; run `build` and `load` first.")
    print("Stopping the native microservices and the native Mongo, Neo4j and OpenSearch", flush=True)
    cedarcli(env, "native", "stop", "microservices")
    infra(env, "stopmongo", "stopneo", "stopopensearch")
    for port in (27017, 7474, 7687, 9200, 9300):
        wait_for_port_free(port)
    compose(env, NATIVE_PORTS, "up", "-d", "--wait")
    ensure_mongo_user(env)
    state.update({"serving": True, "servedSince": now_iso()})
    write_state(env, state)
    cedarcli(env, "native", "start", "microservices")
    if not state.get("indexed"):
        started = time.monotonic()
        regenerate_search_index(env)
        state.update({"indexed": True, "indexSeconds": round(time.monotonic() - started)})
        write_state(env, state)
    print(f"The native stack now serves {state['loaded']}. `release` switches back.")
    return 0


def release(args: argparse.Namespace) -> int:
    env = profile_environment()
    state = read_state(env)
    if not state.get("serving"):
        print("The large store is not being served.")
        return 0
    print("Switching the native stack back to its own stores", flush=True)
    cedarcli(env, "native", "stop", "microservices")
    compose(env, NATIVE_PORTS, "stop")
    infra(env, "startmongo", "startneo", "startopensearch")
    state.update({"serving": False, "servedSince": None})
    write_state(env, state)
    cedarcli(env, "native", "start", "microservices")
    print("The native stack serves its own stores again.")
    return 0


def regenerate_search_index(env: dict[str, str]) -> None:
    """Rebuild the index from the graph and documents, as the backend runbook describes."""
    print("Rebuilding the search index from the loaded store", flush=True)
    # The resource server directly, not through nginx, which answers an unmatched path with a 200.
    server = "http://localhost:9007"
    request = urllib.request.Request(
        f"{server}/command/regenerate-search-index", data=b'{"force": true}', method="POST",
        headers={"Authorization": f"apiKey {env['CEDAR_ADMIN_USER_API_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        location = response.headers.get("Location")
        job = json.loads(response.read() or b"{}")
    if not location:
        raise SystemExit(f"The rebuild started no job: {job}")
    location = urllib.parse.urljoin(server, location)
    started = time.monotonic()
    while True:
        time.sleep(15)
        poll = urllib.request.Request(location, headers={"Authorization": f"apiKey {env['CEDAR_ADMIN_USER_API_KEY']}"})
        with urllib.request.urlopen(poll, timeout=60) as response:
            job = json.loads(response.read())
        elapsed = round(time.monotonic() - started)
        if job.get("state") != "RUNNING":
            break
        print(f"  rebuilding, {elapsed} s", flush=True)
    if job.get("state") != "COMPLETE":
        raise SystemExit(f"The search index rebuild ended {job.get('state')}: {job}")
    print(f"Search index rebuilt in {elapsed} s.")


def discard(args: argparse.Namespace) -> int:
    """Remove the containers and their volumes. The import tree stays, so `load` can run again."""
    env = profile_environment()
    if read_state(env).get("serving"):
        raise SystemExit("The large store is being served; `release` it first.")
    compose(env, SIDE_PORTS, "down", "--volumes")
    (state_root(env) / "state.json").unlink(missing_ok=True)
    print("The large store's containers and volumes are removed.")
    return 0


def status(args: argparse.Namespace) -> int:
    env = profile_environment()
    state = read_state(env)
    build_record = state_root(env) / "build.json"
    state["built"] = json.loads(build_record.read_text()) if build_record.exists() else None
    print(json.dumps(state, indent=2))
    return 0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build", help="write the import tree from a snapshot")
    build_parser.add_argument("--deployment", default="production")
    build_parser.add_argument("--snapshot", help="an archive path; the deployment's latest by default")
    build_parser.set_defaults(handler=build)
    for name, handler, text in (("load", load, "import the tree into the store's containers"),
                                ("serve", serve, "switch the native stack onto the store"),
                                ("release", release, "switch the native stack back"),
                                ("discard", discard, "remove the containers and their volumes"),
                                ("status", status, "say which store is being served")):
        commands.add_parser(name, help=text).set_defaults(handler=handler)
    args = parser.parse_args(list(argv) if argv is not None else None)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
