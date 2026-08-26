#!/usr/bin/env python3
"""Create and resume immutable CEDAR development build trains."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "build-train.json"
TRAIN_RE = re.compile(r"^\d+\.\d+\.\d+-dev\.\d{8}\.\d{4}$")
MAVEN_NS = "http://maven.apache.org/POM/4.0.0"
NPM_INPUT_RE = re.compile(r"^export (CEDAR_[A-Z0-9_]+_NPM_VERSION)=(\S+)$", re.MULTILINE)


def run(arguments: list[str], cwd: Path | None = None, capture: bool = False) -> str:
    print("+", " ".join(arguments), f"(in {cwd})" if cwd else "", flush=True)
    result = subprocess.run(
        arguments,
        cwd=cwd,
        text=True,
        capture_output=capture,
        check=False,
    )
    if result.returncode:
        if capture:
            sys.stderr.write(result.stderr)
        raise RuntimeError(f"command failed with exit code {result.returncode}: {' '.join(arguments)}")
    return result.stdout.strip() if capture else ""


def load_config(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def validate_train(version: str) -> str:
    if not TRAIN_RE.fullmatch(version):
        raise ValueError(
            f"invalid train version {version!r}; expected 2.9.3-dev.YYYYMMDD.HHMM"
        )
    return version


def train_key(version: str) -> tuple[int, int, int, str, str]:
    validate_train(version)
    base, timestamp = version.split("-dev.", 1)
    major, minor, patch = (int(part) for part in base.split("."))
    day, minute = timestamp.split(".", 1)
    return major, minor, patch, day, minute


def train_output_timestamp(version: str) -> str:
    validate_train(version)
    timestamp = version.split("-dev.", 1)[1]
    parsed = dt.datetime.strptime(timestamp, "%Y%m%d.%H%M").replace(tzinfo=dt.timezone.utc)
    return parsed.isoformat().replace("+00:00", "Z")


def resolve_sha(organization: str, repository: str, branch: str) -> tuple[str, str]:
    url = f"https://github.com/{organization}/{repository}.git"
    output = run(["git", "ls-remote", url, f"refs/heads/{branch}"], capture=True)
    if not output:
        raise RuntimeError(f"{repository} has no {branch} branch")
    return repository, output.split()[0]


def capture_shas(config: dict) -> dict[str, str]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [
            executor.submit(
                resolve_sha,
                config["organization"],
                repository,
                config["sourceBranch"],
            )
            for repository in config["repositories"]
        ]
        return dict(sorted(future.result() for future in futures))


def checkout_one(organization: str, repository: str, sha: str, workspace: Path) -> None:
    target = workspace / repository
    if target.exists():
        raise RuntimeError(f"checkout target already exists: {target}")
    target.mkdir(parents=True)
    run(["git", "init", "--quiet"], cwd=target)
    run(["git", "remote", "add", "origin", f"https://github.com/{organization}/{repository}.git"], cwd=target)
    run(["git", "fetch", "--quiet", "--depth", "1", "origin", sha], cwd=target)
    run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], cwd=target)


def checkout_all(config: dict, repositories: dict[str, str], workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    if any(workspace.iterdir()):
        raise RuntimeError(f"train workspace is not empty: {workspace}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [
            executor.submit(
                checkout_one,
                config["organization"],
                repository,
                sha,
                workspace,
            )
            for repository, sha in repositories.items()
        ]
        for future in concurrent.futures.as_completed(futures):
            future.result()


def direct_child(element: ET.Element, name: str) -> ET.Element | None:
    return element.find(f"{{{MAVEN_NS}}}{name}")


def direct_text(element: ET.Element, name: str) -> str | None:
    child = direct_child(element, name)
    return child.text.strip() if child is not None and child.text else None


def pom_version(pom: Path) -> str:
    root = ET.parse(pom).getroot()
    version = direct_text(root, "version")
    if version:
        return version
    parent = direct_child(root, "parent")
    if parent is not None:
        version = direct_text(parent, "version")
    if not version:
        raise RuntimeError(f"cannot determine Maven version from {pom}")
    return version


def stamp_pom(pom: Path, source: str, target: str) -> bool:
    ET.register_namespace("", MAVEN_NS)
    tree = ET.parse(pom)
    root = tree.getroot()
    changed = False

    own_version = direct_child(root, "version")
    if own_version is not None and own_version.text and own_version.text.strip() == source:
        own_version.text = target
        changed = True

    parent = direct_child(root, "parent")
    if parent is not None and direct_text(parent, "groupId") == "org.metadatacenter":
        parent_version = direct_child(parent, "version")
        if parent_version is not None and parent_version.text and parent_version.text.strip() == source:
            parent_version.text = target
            changed = True

    properties = direct_child(root, "properties")
    if properties is not None:
        cedar_version = direct_child(properties, "cedar.version")
        if cedar_version is not None and cedar_version.text and cedar_version.text.strip() == source:
            cedar_version.text = target
            changed = True

    for tag in ("dependency", "plugin", "extension"):
        for item in root.iter(f"{{{MAVEN_NS}}}{tag}"):
            if direct_text(item, "groupId") != "org.metadatacenter":
                continue
            item_version = direct_child(item, "version")
            if item_version is not None and item_version.text and item_version.text.strip() == source:
                item_version.text = target
                changed = True

    if changed:
        tree.write(pom, encoding="utf-8", xml_declaration=True)
    return changed


def stamp_workspace(config: dict, workspace: Path, source: str, target: str) -> int:
    changed = 0
    for repository in config["mavenRepositories"]:
        for pom in (workspace / repository).rglob("pom.xml"):
            if any(part in {"target", ".git"} for part in pom.parts):
                continue
            changed += int(stamp_pom(pom, source, target))
    if not changed:
        raise RuntimeError(f"no POM contained source version {source}")
    return changed


def frontend_inputs(workspace: Path) -> dict[str, str]:
    manifest = workspace / "cedar-docker-build" / "bin" / "cedar-images-base.sh"
    return dict(sorted(NPM_INPUT_RE.findall(manifest.read_text(encoding="utf-8"))))


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def prepare(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    version = validate_train(args.resume or args.version)
    manifest_path = args.state / "trains" / f"{version}.json"
    completed_path = args.state / "completed" / f"{version}.json"
    if args.resume:
        if not manifest_path.exists():
            raise RuntimeError(f"train {version} has no recorded source manifest")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        repositories = manifest["repositories"]
    else:
        if manifest_path.exists():
            raise RuntimeError(f"train {version} already exists; use --resume {version}")
        repositories = capture_shas(config)

    checkout_all(config, repositories, args.workspace)
    source_version = pom_version(args.workspace / "cedar-parent" / "pom.xml")
    if source_version.endswith("-SNAPSHOT") is False:
        raise RuntimeError(f"cedar-parent develop version is not a snapshot: {source_version}")

    if not args.resume:
        manifest = {
            "schemaVersion": 2,
            "version": version,
            "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "sourceBranch": config["sourceBranch"],
            "sourceVersion": source_version,
            "mavenRepository": config["mavenRepository"],
            "repositories": repositories,
            # These are compatibility defaults from cedar-docker-build. The npm train replaces
            # every CEDAR package pin with versions derived from its captured source commits.
            "frontendPackages": frontend_inputs(args.workspace),
        }
        write_json(manifest_path, manifest)

    stamp_workspace(config, args.workspace, manifest["sourceVersion"], version)
    print(f"Prepared {version} from {len(repositories)} exact repository commits.")


def build(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    version = validate_train(args.version)
    local_repository = args.workspace / ".m2" / "repository"
    local_repository.mkdir(parents=True, exist_ok=True)
    for phase in config["phases"]:
        repository = args.workspace / phase["repository"]
        wrapper = repository / "mvnw"
        command = [
            str(wrapper),
            "--batch-mode",
            "--no-transfer-progress",
            "--settings",
            str(args.settings),
            f"-Dmaven.repo.local={local_repository}",
            f"-Dproject.build.outputTimestamp={train_output_timestamp(version)}",
            "clean",
            "install",
            "-DskipTests",
        ]
        print(f"\n=== {phase['name']}: {phase['repository']} ({version}) ===", flush=True)
        run(command, cwd=repository)
    publish_local_repository(local_repository, config["mavenRepository"], version)


def remote_bytes(url: str) -> bytes | None:
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def upload_file(source: Path, destination: str, username: str, password: str) -> str:
    content = source.read_bytes()
    existing = remote_bytes(destination)
    if existing is not None:
        if hashlib.sha256(existing).digest() != hashlib.sha256(content).digest():
            raise RuntimeError(f"immutable Nexus path contains different bytes: {destination}")
        return "unchanged"
    credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = urllib.request.Request(
        destination,
        data=content,
        method="PUT",
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/octet-stream",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status not in (200, 201, 204):
            raise RuntimeError(f"Nexus returned HTTP {response.status} for {destination}")
    return "uploaded"


def publish_local_repository(local_repository: Path, repository_url: str, version: str) -> None:
    username = os.environ.get("BMIR_NEXUS_USERNAME")
    password = os.environ.get("BMIR_NEXUS_PASSWORD")
    if not username or not password:
        raise RuntimeError("BMIR_NEXUS_USERNAME and BMIR_NEXUS_PASSWORD are required")
    group_root = local_repository / "org" / "metadatacenter"
    candidates = sorted(
        path for path in group_root.rglob("*")
        if path.is_file()
        and path.parent.name == version
        and not path.name.startswith(".")
        and path.name != "_remote.repositories"
        and not path.name.endswith((".lastUpdated", ".sha1", ".md5", ".sha256", ".sha512"))
        and not path.name.startswith("maven-metadata")
    )
    if not candidates:
        raise RuntimeError(f"the local Maven repository contains no files for {version}")
    counts = {"uploaded": 0, "unchanged": 0}
    for source in candidates:
        relative = source.relative_to(local_repository).as_posix()
        result = upload_file(source, repository_url.rstrip("/") + "/" + relative, username, password)
        counts[result] += 1
        print(f"{result:9} {relative}", flush=True)
    print(
        f"Published {counts['uploaded']} new files; verified {counts['unchanged']} existing files.",
        flush=True,
    )


def nexus_artifacts(repository_url: str, version: str) -> set[str]:
    base = repository_url.split("/repository/", 1)[0]
    repository = repository_url.rstrip("/").rsplit("/", 1)[-1]
    continuation = None
    artifacts: set[str] = set()
    while True:
        query = {"repository": repository, "version": version}
        if continuation:
            query["continuationToken"] = continuation
        url = f"{base}/service/rest/v1/search?{urllib.parse.urlencode(query)}"
        with urllib.request.urlopen(url, timeout=30) as response:
            payload = json.load(response)
        artifacts.update(item["name"] for item in payload.get("items", []))
        continuation = payload.get("continuationToken")
        if not continuation:
            return artifacts


def complete(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    version = validate_train(args.version)
    manifest_path = args.state / "trains" / f"{version}.json"
    if not manifest_path.exists():
        raise RuntimeError(f"train {version} has no source manifest")
    published = set()
    missing = list(config["requiredArtifacts"])
    for attempt in range(12):
        published = nexus_artifacts(config["mavenRepository"], version)
        missing = sorted(set(config["requiredArtifacts"]) - published)
        if not missing:
            break
        if attempt < 11:
            print("Waiting for Nexus search indexing: " + ", ".join(missing), flush=True)
            time.sleep(10)
    if missing:
        raise RuntimeError("Nexus is missing required train artifacts: " + ", ".join(missing))
    completed_at = dt.datetime.now(dt.timezone.utc).isoformat()
    completion = {
        "schemaVersion": 1,
        "version": version,
        "completedAt": completed_at,
        "manifest": f"trains/{version}.json",
        "verifiedArtifacts": sorted(published),
    }
    write_json(args.state / "completed" / f"{version}.json", completion)
    current_path = args.state / "current.json"
    current = json.loads(current_path.read_text(encoding="utf-8")) if current_path.exists() else None
    if current is None or train_key(version) > train_key(current["version"]):
        write_json(current_path, {
            "schemaVersion": 1,
            "version": version,
            "completedAt": completed_at,
            "manifest": f"trains/{version}.json",
            "completion": f"completed/{version}.json",
        })
    else:
        print(
            f"Completed {version}, but kept newer current train {current['version']}.",
            flush=True,
        )
    print(f"Train {version} is complete with {len(published)} Maven artifacts.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    commands = result.add_subparsers(dest="command", required=True)

    prepare_parser = commands.add_parser("prepare")
    selector = prepare_parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--version")
    selector.add_argument("--resume")
    prepare_parser.add_argument("--workspace", type=Path, required=True)
    prepare_parser.add_argument("--state", type=Path, required=True)
    prepare_parser.set_defaults(handler=prepare)

    build_parser = commands.add_parser("build")
    build_parser.add_argument("--version", required=True)
    build_parser.add_argument("--workspace", type=Path, required=True)
    build_parser.add_argument("--settings", type=Path, default=ROOT / "maven-train-settings.xml")
    build_parser.set_defaults(handler=build)

    complete_parser = commands.add_parser("complete")
    complete_parser.add_argument("--version", required=True)
    complete_parser.add_argument("--state", type=Path, required=True)
    complete_parser.set_defaults(handler=complete)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (OSError, RuntimeError, ValueError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
