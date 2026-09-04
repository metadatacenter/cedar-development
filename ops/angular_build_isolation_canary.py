#!/usr/bin/env python3
"""Prove a train-style frontend build cannot disturb a live Angular checkout."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import socket
import subprocess
import sys
import time
from typing import Iterator
from urllib.error import URLError
from urllib.request import urlopen


class CanaryFailure(RuntimeError):
    pass


def run(command: list[str], *, cwd: Path) -> str:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def git_state(repository: Path) -> bytes:
    """Include tracked content and the names of every untracked output."""
    status = subprocess.run(
        ["git", "-C", str(repository), "status", "--porcelain=v1", "--untracked-files=all"],
        check=True,
        capture_output=True,
    ).stdout
    diff = subprocess.run(
        ["git", "-C", str(repository), "diff", "--binary", "HEAD", "--"],
        check=True,
        capture_output=True,
    ).stdout
    return status + b"\0" + diff


def tree_snapshot(root: Path) -> dict[str, object]:
    """Return a content identity for a tree, including an absent tree."""
    digest = hashlib.sha256()
    files = 0
    size = 0
    if not root.exists():
        digest.update(b"absent\0")
        return {"sha256": digest.hexdigest(), "files": files, "bytes": size, "exists": False}

    for path in sorted(root.rglob("*"), key=lambda candidate: candidate.as_posix()):
        relative = path.relative_to(root).as_posix().encode()
        if path.is_symlink():
            digest.update(b"link\0" + relative + b"\0" + os.readlink(path).encode() + b"\0")
        elif path.is_file():
            digest.update(b"file\0" + relative + b"\0")
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
            files += 1
        elif path.is_dir():
            digest.update(b"dir\0" + relative + b"\0")
    return {"sha256": digest.hexdigest(), "files": files, "bytes": size, "exists": True}


def stable_tree_snapshot(
    root: Path,
    process: subprocess.Popen,
    *,
    timeout_seconds: float,
) -> dict[str, object]:
    """Wait until a live server's cache has the same content twice in succession."""
    deadline = time.monotonic() + timeout_seconds
    previous = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise CanaryFailure(f"development server exited with code {process.returncode}")
        try:
            current = tree_snapshot(root)
        except OSError:
            current = None
        if current is not None and current["files"] and current == previous:
            return current
        previous = current
        time.sleep(1)
    raise CanaryFailure(f"Angular cache did not become stable within {timeout_seconds:g} seconds")


@contextlib.contextmanager
def forced_persistent_angular_cache(angular_json: Path) -> Iterator[None]:
    """Force the live CI server to exercise disk caching, then restore exact bytes."""
    original = angular_json.read_bytes()
    configuration = json.loads(original)
    cli = configuration.setdefault("cli", {})
    cli["cache"] = {
        "enabled": True,
        "environment": "all",
        "path": ".angular/cache",
    }
    angular_json.write_text(json.dumps(configuration, indent=2) + "\n", encoding="utf-8")
    try:
        yield
    finally:
        angular_json.write_bytes(original)


def unused_local_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def server_is_healthy(port: int) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{port}/", timeout=3) as response:
            return 200 <= response.status < 400 and bool(response.read(1))
    except (OSError, URLError):
        return False


def wait_for_server(process: subprocess.Popen, port: int, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise CanaryFailure(f"development server exited with code {process.returncode}")
        if server_is_healthy(port):
            return
        time.sleep(1)
    raise CanaryFailure(f"development server was not healthy within {timeout_seconds:g} seconds")


def stop_process_group(process: subprocess.Popen | None) -> None:
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=5)
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        return
    # npm normally remains the group leader until ng exits. If it ever stops first, still reap
    # any child that inherited the canary's process group.
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def tail(path: Path, lines: int = 40) -> str:
    if not path.is_file():
        return ""
    return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])


def validate_workspace(workspace: Path) -> tuple[Path, Path, Path]:
    monitoring = workspace / "cedar-monitoring"
    source = monitoring / "cedar-monitoring-src"
    cli = workspace / "cedar-cli" / "cli.sh"
    required = (
        monitoring / ".git",
        source / "angular.json",
        source / "node_modules" / ".bin" / "ng",
        cli,
        workspace / "cedar-cli" / ".venv" / "bin" / "activate",
    )
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise CanaryFailure("workspace prerequisite(s) missing: " + ", ".join(missing))
    return monitoring, source, cli


def execute_canary(
    workspace: Path,
    evidence_directory: Path,
    *,
    ready_timeout_seconds: float,
    build_timeout_seconds: float,
) -> dict[str, object]:
    monitoring, source, cli = validate_workspace(workspace)
    angular_json = source / "angular.json"
    cache = source / ".angular" / "cache"
    source_dist = source / "dist"
    tracked_dist = monitoring / "cedar-monitoring-dist"
    evidence_directory.mkdir(parents=True, exist_ok=True)
    server_log = evidence_directory / "development-server.log"
    build_log = evidence_directory / "isolated-build.log"

    initial_git = git_state(monitoring)
    initial_source_dist = tree_snapshot(source_dist)
    initial_tracked_dist = tree_snapshot(tracked_dist)
    port = unused_local_port()
    process = None
    evidence: dict[str, object] = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "node": run(["node", "--version"], cwd=source),
        "monitoringCommit": run(["git", "rev-parse", "HEAD"], cwd=monitoring),
        "port": port,
        "result": "failed",
    }
    failure: BaseException | None = None

    try:
        with forced_persistent_angular_cache(angular_json):
            environment = dict(os.environ)
            environment["NG_CLI_ANALYTICS"] = "false"
            with server_log.open("wb") as output:
                process = subprocess.Popen(
                    [
                        "npm", "start", "--",
                        "--host", "127.0.0.1",
                        "--port", str(port),
                    ],
                    cwd=source,
                    env=environment,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            wait_for_server(process, port, ready_timeout_seconds)
            evidence["developmentServerPid"] = process.pid
            evidence["developmentServerHealthyBeforeBuild"] = True
            cache_before = stable_tree_snapshot(
                cache, process, timeout_seconds=ready_timeout_seconds,
            )
            evidence["liveCacheBeforeBuild"] = cache_before

            build_environment = dict(os.environ)
            build_environment.update({
                "CEDAR_HOME": str(workspace),
                "CEDAR_DEV_BUILD_FRONTENDS": "true",
                "NG_CLI_ANALYTICS": "false",
                "PYTHONUNBUFFERED": "1",
            })
            with build_log.open("wb") as output:
                build = subprocess.run(
                    ["bash", str(cli), "build", "this"],
                    cwd=source,
                    env=build_environment,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    timeout=build_timeout_seconds,
                    check=False,
                )
            evidence["buildReturnCode"] = build.returncode
            build_output = build_log.read_text(encoding="utf-8", errors="replace")
            runtime_detected = (
                "Active frontend runtime(s)" in build_output
                and "isolated from their checkout and Angular cache" in build_output
            )
            evidence["liveRuntimeDetectedByCli"] = runtime_detected
            if build.returncode != 0:
                raise CanaryFailure(
                    f"isolated cedarcli build failed with code {build.returncode}:\n{tail(build_log)}"
                )
            if not runtime_detected:
                raise CanaryFailure("cedarcli did not report the live frontend runtime")
            if process.poll() is not None:
                raise CanaryFailure(
                    f"development server exited during the isolated build with code {process.returncode}"
                )
            if not server_is_healthy(port):
                raise CanaryFailure("development server was unhealthy after the isolated build")
            evidence["developmentServerHealthyAfterBuild"] = True

            cache_after = stable_tree_snapshot(
                cache, process, timeout_seconds=ready_timeout_seconds,
            )
            evidence["liveCacheAfterBuild"] = cache_after
            evidence["liveCacheUnchanged"] = cache_after == cache_before
            if cache_after != cache_before:
                raise CanaryFailure("the live checkout's Angular disk cache changed during the build")

            if tree_snapshot(source_dist) != initial_source_dist:
                raise CanaryFailure("the live checkout's source distribution changed during the build")
            if tree_snapshot(tracked_dist) != initial_tracked_dist:
                raise CanaryFailure("cedar-monitoring-dist changed during the build")
    except BaseException as error:
        failure = error
    finally:
        stop_process_group(process)

    final_git = git_state(monitoring)
    evidence["monitoringGitStateUnchanged"] = final_git == initial_git
    if final_git != initial_git:
        state_error = CanaryFailure("the Monitoring repository did not return to its initial git state")
        failure = state_error if failure is None else CanaryFailure(f"{failure}; {state_error}")

    if failure is not None:
        evidence["error"] = str(failure)
        evidence["developmentServerLogTail"] = tail(server_log)
        (evidence_directory / "evidence.json").write_text(
            json.dumps(evidence, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        raise CanaryFailure(str(failure))
    evidence["result"] = "passed"
    return evidence


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--ready-timeout-seconds", type=float, default=180)
    parser.add_argument("--build-timeout-seconds", type=float, default=900)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    evidence: dict[str, object] = {"result": "failed"}
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    try:
        evidence = execute_canary(
            args.workspace.resolve(),
            args.evidence_dir.resolve(),
            ready_timeout_seconds=args.ready_timeout_seconds,
            build_timeout_seconds=args.build_timeout_seconds,
        )
    except (CanaryFailure, OSError, subprocess.SubprocessError, ValueError) as error:
        evidence_path = args.evidence_dir / "evidence.json"
        if evidence_path.is_file():
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        evidence["error"] = str(error)
        print(f"ERROR: {error}", file=sys.stderr)
        status = 1
    else:
        print("PASS: live Angular server, cache, checkout, and distributions remained isolated")
        status = 0
    (args.evidence_dir / "evidence.json").write_text(
        json.dumps(evidence, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return status


if __name__ == "__main__":
    raise SystemExit(main())
