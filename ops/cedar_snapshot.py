#!/usr/bin/env python3
"""Download every artifact a CEDAR deployment serves, and keep it as one compressed snapshot.

Tests that read production data have each fetched it themselves, into caches of their own shape, and
none of those caches kept the bytes the deployment served. Re-encoding a body as JSON loses a
duplicated key and the spelling of a number, which are among the defects such tests look for. A
snapshot keeps every response body exactly as served, so a later test can read the same corpus
offline, and two snapshots taken weeks apart can be compared.

Three commands make and check a snapshot:

- ``download`` enumerates every template, element, field and instance through ``/search-deep``,
  reads each through its typed endpoint, and keeps the bodies in a staging database that survives
  an interruption. ``--resume`` continues an interrupted download. Once every artifact has been
  read, the snapshot is packed.
- ``pack`` writes a staging database as one tar archive compressed with zstd, verifies the archive,
  and then removes the staging database.
- ``verify`` reads an archive back and checks every body against the index the archive carries.

Every request is a GET, and the API key travels only in the Authorization header of requests to the
configured origin. Snapshots are written under ``$CEDAR_HOME/.cedar/snapshots/<deployment>/`` with
owner-only permissions, one archive per run, and ``latest.tar.zst`` links to the newest:

    python3 ops/cedar_snapshot.py download
    python3 ops/cedar_snapshot.py verify
    python3 ops/cedar_snapshot.py list

An archive holds ``manifest.json``, then ``index.jsonl`` with one line per enumerated artifact, then
one member per body. Instances are grouped by the template they are based on, which puts documents
of the same shape next to each other and is most of what the compression gains. A test reads an
archive without extracting it:

    from cedar_snapshot import Snapshot
    for entry, body in Snapshot.latest("production").artifacts():
        ...

Enumeration is permission-scoped, so a snapshot is complete only for what the key can read. An
artifact the search index lists but the store no longer holds is recorded in the index with the
status the server answered, and has no body.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.parse
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor
from concurrent.futures import wait as futures_wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

OPS = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("cedar_artifact_rest_audit", OPS / "cedar_artifact_rest_audit.py")
rest = importlib.util.module_from_spec(_spec)
sys.modules["cedar_artifact_rest_audit"] = rest
_spec.loader.exec_module(rest)

FORMAT_VERSION = 1
TYPES = rest.TYPE_ORDER
DEFAULT_WORKERS = 16
DEFAULT_PAGE_SIZE = 500
DEFAULT_REREADS = 2
DEFAULT_LEVEL = 19
# 2^27 bytes is the largest window a zstd decoder accepts without being told to allow more, so an
# archive made with it opens with a plain `zstd -d` and with Python's compression.zstd.
DEFAULT_WINDOW_LOG = 27
DEFAULT_KEY_FILE = Path.home() / ".cedar-admin-key"
PROGRESS_EVERY = 5000
COMMIT_EVERY = 500
MANIFEST_MEMBER = "manifest.json"
INDEX_MEMBER = "index.jsonl"
ARCHIVE_SUFFIX = ".tar.zst"
LATEST = "latest"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def snapshots_root(root: Optional[str]) -> Path:
    if root:
        return Path(root)
    home = os.environ.get("CEDAR_HOME") or str(Path.home() / "CEDAR")
    return Path(home) / ".cedar" / "snapshots"


def deployment_name(server: str) -> str:
    """``production`` for the default server, and the server's host for any other."""
    server = server.rstrip("/")
    return "production" if server == rest.DEFAULT_SERVER else urllib.parse.urlsplit(server).netloc


def member_name(artifact_type: str, artifact_id: str) -> str:
    """The archive member that holds one artifact's body.

    The identifier is kept readable and reversible, with its scheme dropped and every character
    outside a plain path percent-encoded. An identifier is opaque, so one with an empty, ``.`` or
    ``..`` segment is encoded whole rather than allowed to name a path outside its directory.
    """
    rest_of_id = artifact_id.split("://", 1)[-1]
    segments = rest_of_id.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        return f"{artifact_type}/{urllib.parse.quote(artifact_id, safe='')}.json"
    return f"{artifact_type}/{urllib.parse.quote(rest_of_id, safe='/-._~')}.json"


def tool_identity() -> dict[str, Any]:
    script = Path(__file__).resolve()
    identity: dict[str, Any] = {"script": script.name,
                                "sha256": hashlib.sha256(script.read_bytes()).hexdigest()}
    try:
        commit = subprocess.run(["git", "-C", str(OPS), "rev-parse", "HEAD"], capture_output=True,
                                text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(OPS), "status", "--porcelain", "--", script.name],
                               capture_output=True, text=True, check=True).stdout.strip()
        identity["commit"] = commit
        identity["modified"] = bool(dirty)
    except (OSError, subprocess.CalledProcessError):
        pass
    return identity


# --- staging ----------------------------------------------------------------------------------

STAGING_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refs (
  type TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (type, id));
CREATE TABLE IF NOT EXISTS reads (
  type TEXT NOT NULL, id TEXT NOT NULL,
  status INTEGER,          -- the HTTP status answered, or NULL when no answer arrived
  error TEXT, fetched_at TEXT NOT NULL, etag TEXT, content_type TEXT,
  template TEXT,           -- an instance's schema:isBasedOn, which orders the archive
  body_id TEXT, sha256 TEXT, size INTEGER, body BLOB,
  PRIMARY KEY (type, id));
"""


def open_staging(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path / "staging.sqlite")
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(STAGING_SCHEMA)
    return db


def get_meta(db: sqlite3.Connection, key: str) -> Any:
    row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(row[0]) if row else None


def set_meta(db: sqlite3.Connection, key: str, value: Any) -> None:
    db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, json.dumps(value)))


def is_final(status: Optional[int]) -> bool:
    """Whether a read has its answer. A server error or no answer at all is asked again."""
    return status is not None and status < 500


def enumerate_type(client: Any, db: sqlite3.Connection, artifact_type: str, page_size: int,
                   limit: Optional[int] = None) -> None:
    state = rest.AuditState()
    rest.preflight_expected_counts(client, [artifact_type], state)
    expected = state.expected_by_type.get(artifact_type)
    print(f"[enumerate] {artifact_type}: {expected} listed", flush=True)
    started = time.monotonic()
    rows: list[tuple[str, str, int]] = []
    for position, ref in enumerate(rest.iter_artifact_refs(client, artifact_type, page_size, state, limit)):
        rows.append((artifact_type, ref.artifact_id, position))
        if len(rows) % 25000 == 0:
            print(f"[enumerate] {artifact_type}: {len(rows)}/{expected} "
                  f"({time.monotonic() - started:.0f}s)", flush=True)
    db.execute("DELETE FROM refs WHERE type = ?", (artifact_type,))
    db.executemany("INSERT INTO refs (type, id, position) VALUES (?, ?, ?)", rows)
    set_meta(db, f"enumerated:{artifact_type}", {
        "expected": state.expected_by_type.get(artifact_type),
        "enumerated": len(rows),
        "limit": limit,
        "pagination": state.pagination_by_type.get(artifact_type),
        "duplicates": state.duplicates,
        "listingErrors": state.listing_errors,
        "totalCountChanges": state.total_count_changes,
        "finishedAt": utc_now(),
    })
    db.commit()
    print(f"[enumerate] {artifact_type}: {len(rows)} enumerated in {time.monotonic() - started:.0f}s",
          flush=True)


def read_raw(client: Any, ref: Any) -> tuple[Optional[tuple[int, Optional[bytes], dict[str, str]]],
                                             Optional[Exception]]:
    """One artifact's body as served, or the status of a definite refusal, or the failure."""
    try:
        body, headers = client.get_bytes(rest.typed_artifact_path(ref))
        return (200, body, headers), None
    except rest.ResponseError as error:
        if is_final(error.status):
            return (error.status, None, {}), error
        return None, error
    except Exception as error:  # noqa: BLE001 - recorded as unread and asked again later
        return None, error


def record_read(db: sqlite3.Connection, ref: Any, answer: Any, error: Optional[Exception]) -> str:
    fetched_at = utc_now()
    if answer is None:
        db.execute("INSERT OR REPLACE INTO reads (type, id, status, error, fetched_at) VALUES (?, ?, NULL, ?, ?)",
                   (ref.artifact_type, ref.artifact_id, f"{type(error).__name__}: {error}"[:1000], fetched_at))
        return "unread"
    status, body, headers = answer
    if status != 200:
        db.execute("INSERT OR REPLACE INTO reads (type, id, status, error, fetched_at) VALUES (?, ?, ?, ?, ?)",
                   (ref.artifact_type, ref.artifact_id, status, str(error)[:1000], fetched_at))
        return f"http-{status}"
    problem = template = body_id = None
    try:
        document = json.loads(body)
    except ValueError as invalid:
        problem = f"not JSON: {invalid}"
    else:
        if isinstance(document, dict):
            body_id = document.get("@id") if isinstance(document.get("@id"), str) else None
            based_on = document.get("schema:isBasedOn")
            template = based_on if isinstance(based_on, str) else None
        else:
            problem = "not a JSON object"
    db.execute(
        "INSERT OR REPLACE INTO reads (type, id, status, error, fetched_at, etag, content_type, template, "
        "body_id, sha256, size, body) VALUES (?, ?, 200, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (ref.artifact_type, ref.artifact_id, problem, fetched_at, headers.get("etag"),
         headers.get("content-type"), template, body_id, hashlib.sha256(body).hexdigest(), len(body), body))
    return "served" if problem is None else "served-not-an-object"


def pending_refs(db: sqlite3.Connection) -> list[Any]:
    order = " ".join(f"WHEN '{name}' THEN {rank}" for rank, name in enumerate(TYPES))
    rows = db.execute(
        "SELECT r.type, r.id FROM refs r LEFT JOIN reads d ON d.type = r.type AND d.id = r.id "
        "WHERE d.id IS NULL OR d.status IS NULL OR d.status >= 500 "
        f"ORDER BY CASE r.type {order} END, r.position").fetchall()
    return [rest.ArtifactRef(artifact_type, artifact_id) for artifact_type, artifact_id in rows]


def fetch_unordered(client: Any, refs: list[Any], workers: int,
                    worker_timeout: float = rest.DEFAULT_WORKER_TIMEOUT) -> Iterator[tuple[Any, Any, Any]]:
    """Each read as soon as it is answered, in whatever order the answers arrive.

    The REST audit's pool hands reads over in enumeration order, which its resume file needs, and so
    stops reading ahead while one slow read holds the head of the queue; one read waiting out its
    retries stalled the whole pool. A snapshot is keyed by identifier and needs no order. A read that
    stays unanswered for ``worker_timeout`` is handed over as unread and asked again in a later pass.
    """
    executor = ThreadPoolExecutor(max_workers=max(1, workers))
    remaining = iter(refs)
    running: dict[Future, tuple[Any, float]] = {}

    def submit() -> None:
        ref = next(remaining, None)
        if ref is not None:
            running[executor.submit(read_raw, client, ref)] = (ref, time.monotonic())

    try:
        for _ in range(2 * max(1, workers)):
            submit()
        while running:
            done, _ = futures_wait(running, timeout=30, return_when=FIRST_COMPLETED)
            for future in done:
                ref, _submitted = running.pop(future)
                answer, error = future.result()
                yield ref, answer, error
                submit()
            now = time.monotonic()
            for future, (ref, submitted) in list(running.items()):
                if now - submitted > worker_timeout:
                    running.pop(future)
                    yield ref, None, TimeoutError(f"no answer within {worker_timeout:.0f}s")
                    submit()
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def fetch_pending(client: Any, db: sqlite3.Connection, workers: int, label: str) -> collections.Counter:
    refs = pending_refs(db)
    outcomes: collections.Counter = collections.Counter()
    if not refs:
        return outcomes
    print(f"[{label}] reading {len(refs)} artifact(s) with {workers} worker(s)", flush=True)
    started = time.monotonic()
    for count, (ref, answer, error) in enumerate(fetch_unordered(client, refs, workers), 1):
        outcomes[record_read(db, ref, answer, error)] += 1
        if count % COMMIT_EVERY == 0:
            db.commit()
        if count % PROGRESS_EVERY == 0 or count == len(refs):
            elapsed = time.monotonic() - started
            rate = count / elapsed if elapsed else 0.0
            remaining = (len(refs) - count) / rate if rate else 0.0
            print(f"[{label}] {count}/{len(refs)} ({100 * count / len(refs):.1f}%) {rate:.0f}/s, "
                  f"about {remaining / 60:.0f} min left; {dict(outcomes)}", flush=True)
    db.commit()
    return outcomes


def make_client(arguments: argparse.Namespace, parser: argparse.ArgumentParser) -> Any:
    if not arguments.api_key_file and not os.environ.get("CEDAR_API_KEY") and DEFAULT_KEY_FILE.exists():
        arguments.api_key_file = str(DEFAULT_KEY_FILE)
    key = rest.resolve_api_key(arguments, parser)
    return rest.GetOnlyClient(arguments.server, key, timeout=arguments.timeout, retries=arguments.retries)


def command_download(arguments: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    os.umask(0o077)
    client = make_client(arguments, parser)
    if arguments.resume:
        staging = Path(arguments.resume)
        db = open_staging(staging)
        server = get_meta(db, "server")
        if server != arguments.server.rstrip("/"):
            parser.error(f"{staging} was started against {server}, not {arguments.server}")
        print(f"[download] resuming {staging}", flush=True)
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%MZ")
        directory = snapshots_root(arguments.root) / deployment_name(arguments.server)
        staging = directory / f"staging-{stamp}"
        staging.mkdir(parents=True, exist_ok=False)
        db = open_staging(staging)
        set_meta(db, "formatVersion", FORMAT_VERSION)
        set_meta(db, "stamp", stamp)
        set_meta(db, "server", arguments.server.rstrip("/"))
        set_meta(db, "deployment", deployment_name(arguments.server))
        set_meta(db, "startedAt", utc_now())
        db.commit()
        print(f"[download] staging in {staging}", flush=True)

    for artifact_type in TYPES:
        if get_meta(db, f"enumerated:{artifact_type}") is None:
            enumerate_type(client, db, artifact_type, arguments.page_size, arguments.limit)

    fetch_pending(client, db, arguments.workers, "read")
    for attempt in range(1, arguments.rereads + 1):
        if not fetch_pending(client, db, max(1, arguments.workers // 4), f"reread {attempt}"):
            break
    set_meta(db, "fetchedAt", utc_now())
    db.commit()

    unread = len(pending_refs(db))
    if unread and not arguments.allow_unread:
        print(f"[download] {unread} artifact(s) still unread; continue with --resume {staging}, "
              "or pack with --allow-unread to record them as unread", file=sys.stderr)
        return 1
    db.close()
    return pack(staging, arguments.level, arguments.window_log, arguments.keep_staging)


# --- packing ----------------------------------------------------------------------------------

def tar_member(name: str, data: bytes, mtime: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = mtime
    info.mode = 0o600
    info.uname = info.gname = ""
    return info


def index_entries(db: sqlite3.Connection) -> list[dict[str, Any]]:
    """Every enumerated artifact in archive order, with what reading it produced."""
    order = " ".join(f"WHEN '{name}' THEN {rank}" for rank, name in enumerate(TYPES))
    rows = db.execute(
        "SELECT r.type, r.id, d.status, d.error, d.fetched_at, d.etag, d.content_type, d.template, d.body_id, "
        "d.sha256, d.size FROM refs r LEFT JOIN reads d ON d.type = r.type AND d.id = r.id "
        f"ORDER BY CASE r.type {order} END, COALESCE(d.template, ''), r.id").fetchall()
    entries = []
    for (artifact_type, artifact_id, status, error, fetched_at, etag, content_type, template, body_id,
         sha256, size) in rows:
        entry: dict[str, Any] = {"type": artifact_type, "id": artifact_id, "status": status}
        if status == 200:
            entry.update({"member": member_name(artifact_type, artifact_id), "sha256": sha256, "size": size,
                          "etag": etag, "contentType": content_type})
            if template:
                entry["template"] = template
            if body_id != artifact_id:
                entry["bodyId"] = body_id
        if error:
            entry["error"] = error
        entry["fetchedAt"] = fetched_at
        entries.append(entry)
    return entries


def summarize(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, collections.Counter] = {name: collections.Counter() for name in TYPES}
    body_bytes = 0
    for entry in entries:
        status = entry["status"]
        if status == 200:
            outcome = "served" if "error" not in entry else "servedNotAnObject"
            body_bytes += entry["size"]
            if "bodyId" in entry:
                counts[entry["type"]]["bodyIdDiffers"] += 1
        elif status is None:
            outcome = "unread"
        else:
            outcome = f"status{status}"
        counts[entry["type"]][outcome] += 1
        counts[entry["type"]]["enumerated"] += 1
    return {"byType": {name: dict(counter) for name, counter in counts.items()}, "bodyBytes": body_bytes}


def pack(staging: Path, level: int, window_log: int, keep_staging: bool) -> int:
    os.umask(0o077)
    db = open_staging(staging)
    stamp = get_meta(db, "stamp")
    directory = staging.parent
    archive = directory / f"{stamp}{ARCHIVE_SUFFIX}"
    partial = directory / f".{stamp}{ARCHIVE_SUFFIX}.partial"
    entries = index_entries(db)
    manifest = {
        "formatVersion": FORMAT_VERSION,
        "deployment": get_meta(db, "deployment"),
        "server": get_meta(db, "server"),
        "startedAt": get_meta(db, "startedAt"),
        "fetchedAt": get_meta(db, "fetchedAt"),
        "packedAt": utc_now(),
        "enumeration": {name: get_meta(db, f"enumerated:{name}") for name in TYPES},
        "counts": summarize(entries),
        "compression": {"format": "zstd", "level": level, "windowLog": window_log},
        "tool": tool_identity(),
    }
    mtime = int(datetime.fromisoformat(manifest["startedAt"].replace("Z", "+00:00")).timestamp())
    command = ["zstd", f"-{level}", f"--long={window_log}", "-T0", "-q", "-f", "-o", str(partial)]
    if level > 19:
        command.insert(1, "--ultra")
    print(f"[pack] writing {archive.name}: {len(entries)} entries, "
          f"{manifest['counts']['bodyBytes'] / 1e9:.2f} GB of bodies, zstd -{level} --long={window_log}",
          flush=True)
    started = time.monotonic()
    compressor = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert compressor.stdin is not None
    with tarfile.open(fileobj=compressor.stdin, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        for name, data in ((MANIFEST_MEMBER, json.dumps(manifest, indent=2).encode() + b"\n"),
                           (INDEX_MEMBER, b"".join(json.dumps(entry, separators=(",", ":")).encode() + b"\n"
                                                   for entry in entries))):
            tar.addfile(tar_member(name, data, mtime), io.BytesIO(data))
        for count, entry in enumerate((e for e in entries if e["status"] == 200), 1):
            (body,) = db.execute("SELECT body FROM reads WHERE type = ? AND id = ?",
                                 (entry["type"], entry["id"])).fetchone()
            tar.addfile(tar_member(entry["member"], body, mtime), io.BytesIO(body))
            if count % 50000 == 0:
                print(f"[pack] {count} bodies written ({time.monotonic() - started:.0f}s)", flush=True)
    compressor.stdin.close()
    if compressor.wait() != 0:
        print(f"[pack] zstd exited with {compressor.returncode}; {partial} left for inspection", file=sys.stderr)
        return 1
    os.replace(partial, archive)
    db.close()
    print(f"[pack] {archive.stat().st_size / 1e6:.1f} MB in {time.monotonic() - started:.0f}s, "
          f"{manifest['counts']['bodyBytes'] / max(1, archive.stat().st_size):.0f}x; verifying", flush=True)

    report = verify(archive)
    if not report["ok"]:
        print(f"[pack] verification failed: {report['problems'][:10]}", file=sys.stderr)
        return 1
    sidecar = dict(manifest, archive={"name": archive.name, "bytes": archive.stat().st_size,
                                      "sha256": file_sha256(archive)})
    sidecar_path = directory / f"{stamp}.json"
    sidecar_path.write_text(json.dumps(sidecar, indent=2) + "\n")
    for name, target in ((f"{LATEST}{ARCHIVE_SUFFIX}", archive.name), (f"{LATEST}.json", sidecar_path.name)):
        link = directory / name
        temporary = directory / f".{name}.new"
        if temporary.is_symlink() or temporary.exists():
            temporary.unlink()
        temporary.symlink_to(target)
        os.replace(temporary, link)
    if not keep_staging:
        shutil.rmtree(staging)
    print(f"[pack] {archive}", flush=True)
    print(json.dumps(manifest["counts"], indent=2), flush=True)
    return 0


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# --- reading ----------------------------------------------------------------------------------

class Snapshot:
    """One archive, read as a stream. Nothing is extracted to disk."""

    def __init__(self, path: Path | str):
        # Resolved, because the zstd command skips a symbolic link such as `latest.tar.zst`.
        self.path = Path(path).resolve()

    @classmethod
    def latest(cls, deployment: str = "production", root: Optional[str] = None) -> "Snapshot":
        link = snapshots_root(root) / deployment / f"{LATEST}{ARCHIVE_SUFFIX}"
        if not link.exists():
            raise FileNotFoundError(f"no snapshot of {deployment} under {link.parent}")
        return cls(link)

    def _members(self) -> Iterator[tuple[tarfile.TarInfo, bytes]]:
        # The zstd command rather than tarfile's own support, which only Python 3.14 has.
        decompressor = subprocess.Popen(["zstd", "-dcq", f"--long={DEFAULT_WINDOW_LOG}", str(self.path)],
                                        stdout=subprocess.PIPE)
        assert decompressor.stdout is not None
        try:
            with tarfile.open(fileobj=decompressor.stdout, mode="r|") as tar:
                for member in tar:
                    handle = tar.extractfile(member)
                    yield member, handle.read() if handle else b""
            # The archive can end before the stream does, in the padding after the last member.
            while decompressor.stdout.read(1 << 16):
                pass
            if decompressor.wait() != 0:
                raise ValueError(f"zstd could not decompress {self.path} (exit {decompressor.returncode})")
        finally:
            decompressor.stdout.close()
            if decompressor.poll() is None:
                decompressor.kill()
                decompressor.wait()

    def header(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """The manifest and the index, which are the first two members."""
        members = self._members()
        manifest = index = None
        for member, data in members:
            if member.name == MANIFEST_MEMBER:
                manifest = json.loads(data)
            elif member.name == INDEX_MEMBER:
                index = [json.loads(line) for line in data.splitlines() if line]
                break
        members.close()
        if manifest is None or index is None:
            raise ValueError(f"{self.path} does not begin with {MANIFEST_MEMBER} and {INDEX_MEMBER}")
        return manifest, index

    def artifacts(self, types: Optional[Iterable[str]] = None) -> Iterator[tuple[dict[str, Any], bytes]]:
        """Each served artifact's index entry and body, in archive order."""
        wanted = set(types) if types is not None else None
        by_member: dict[str, dict[str, Any]] = {}
        for member, data in self._members():
            if member.name == MANIFEST_MEMBER:
                continue
            if member.name == INDEX_MEMBER:
                for line in data.splitlines():
                    entry = json.loads(line)
                    if "member" in entry:
                        by_member[entry["member"]] = entry
                continue
            entry = by_member.get(member.name)
            if entry is None:
                raise ValueError(f"{self.path}: {member.name} is not in the index")
            if wanted is None or entry["type"] in wanted:
                yield entry, data


def verify(archive: Path) -> dict[str, Any]:
    """Whether every body the index lists is present once, with the size and digest it records."""
    snapshot = Snapshot(archive)
    problems: list[str] = []
    seen: set[str] = set()
    expected: dict[str, dict[str, Any]] = {}
    manifest: dict[str, Any] = {}
    for member, data in snapshot._members():
        if member.name == MANIFEST_MEMBER:
            manifest = json.loads(data)
            continue
        if member.name == INDEX_MEMBER:
            for line in data.splitlines():
                entry = json.loads(line)
                if "member" in entry:
                    expected[entry["member"]] = entry
            continue
        entry = expected.get(member.name)
        if entry is None:
            problems.append(f"unlisted member {member.name}")
            continue
        if member.name in seen:
            problems.append(f"duplicate member {member.name}")
        seen.add(member.name)
        if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            problems.append(f"{member.name} differs from its index entry")
    missing = set(expected) - seen
    problems.extend(f"missing member {name}" for name in sorted(missing)[:20])
    if not manifest:
        problems.append(f"no {MANIFEST_MEMBER}")
    return {"ok": not problems, "bodies": len(seen), "listed": len(expected),
            "problems": problems, "counts": manifest.get("counts")}


def command_verify(arguments: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    archive = Path(arguments.archive) if arguments.archive else Snapshot.latest(arguments.deployment,
                                                                                arguments.root).path
    started = time.monotonic()
    report = verify(archive)
    print(json.dumps(dict(report, archive=str(archive), seconds=round(time.monotonic() - started)), indent=2))
    return 0 if report["ok"] else 1


def command_list(arguments: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    root = snapshots_root(arguments.root)
    for sidecar in sorted(root.glob(f"*/*.json")):
        if sidecar.is_symlink():
            continue
        manifest = json.loads(sidecar.read_text())
        served = sum(counts.get("served", 0) for counts in manifest["counts"]["byType"].values())
        print(f"{manifest['deployment']:<12} {sidecar.stem:<17} {served:>8} served "
              f"{manifest['archive']['bytes'] / 1e6:>9.1f} MB  {sidecar.parent / manifest['archive']['name']}")
    for staging in sorted(root.glob("*/staging-*")):
        print(f"unpacked staging: {staging}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", help="snapshot directory (default: $CEDAR_HOME/.cedar/snapshots)")
    commands = parser.add_subparsers(dest="command", required=True)

    download = commands.add_parser("download", help="enumerate, read and pack every artifact")
    download.add_argument("--server", default=rest.DEFAULT_SERVER,
                          help=f"resource-server origin (default: {rest.DEFAULT_SERVER})")
    download.add_argument("--api-key-file",
                          help=f"file holding the API key (default: $CEDAR_API_KEY, else {DEFAULT_KEY_FILE})")
    download.add_argument("--resume", metavar="STAGING", help="continue an interrupted download")
    download.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                          help=f"concurrent reads (default: {DEFAULT_WORKERS})")
    download.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE,
                          help=f"search-deep page size (default: {DEFAULT_PAGE_SIZE})")
    download.add_argument("--timeout", type=float, default=90, help="per-request timeout in seconds")
    download.add_argument("--retries", type=int, default=5, help="attempts per request")
    download.add_argument("--rereads", type=int, default=DEFAULT_REREADS,
                          help=f"passes over the reads that got no answer (default: {DEFAULT_REREADS})")
    download.add_argument("--limit", type=int,
                          help="enumerate at most this many artifacts of each type, for a sample")
    download.add_argument("--allow-unread", action="store_true",
                          help="pack even if some artifacts got no answer, recording them as unread")

    pack_command = commands.add_parser("pack", help="pack a staging directory into an archive")
    pack_command.add_argument("staging", help="the staging directory a download left")
    for command in (download, pack_command):
        command.add_argument("--level", type=int, default=DEFAULT_LEVEL,
                             help=f"zstd level (default: {DEFAULT_LEVEL})")
        command.add_argument("--window-log", type=int, default=DEFAULT_WINDOW_LOG,
                             help=f"zstd long-distance window, as a power of two (default: {DEFAULT_WINDOW_LOG})")
        command.add_argument("--keep-staging", action="store_true",
                             help="keep the staging database after a verified pack")

    verify_command = commands.add_parser("verify", help="check an archive against its index")
    verify_command.add_argument("archive", nargs="?", help="the archive (default: the latest)")
    verify_command.add_argument("--deployment", default="production")

    commands.add_parser("list", help="list snapshots")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    if arguments.command == "download":
        return command_download(arguments, parser)
    if arguments.command == "pack":
        return pack(Path(arguments.staging), arguments.level, arguments.window_log, arguments.keep_staging)
    if arguments.command == "verify":
        return command_verify(arguments, parser)
    return command_list(arguments, parser)


if __name__ == "__main__":
    sys.exit(main())
