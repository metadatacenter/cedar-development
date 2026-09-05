#!/usr/bin/env python3
"""Read-only inventory of the grants a legacy WRITE migration has to decide about.

The permission model proposal replaces the current two enforced levels with Viewer, Editor and
Manager, and the expensive part of adopting it is what to do with the WRITE grants already stored.
Today WRITE also confers re-sharing, movement and OpenView control, so mapping it to Editor removes
authority people hold, and mapping it to Manager grants more than most sharers intended. Which of
those risks is real depends on a number nobody has counted: how many WRITE grants are held by
someone other than the owner. This produces that number, along with the other counts the migration
needs before it can be planned.

Two passes, of very different cost. Enumerating resources through ``/search-deep`` is cheap, and
each row already carries the owner, the ``everybodyPermission`` and the OpenView flags, so the
Everyone and OpenView inventories need no further request. Reading direct user and group grants
costs one request per resource, and it is the only pass that answers the question the migration rule
turns on. ``--no-grants`` runs the cheap pass alone, and ``--sample`` runs the expensive one over a
random subset to size the full run first.

Groups are enumerated separately, which reports the groups holding no administrator and expands each
group WRITE grant to the members it actually reaches.

Enumeration is permission-scoped. "Complete" means complete for what the supplied key can read. A key
without administrative reach reports a floor, not a total, and the summary records which it is.

Findings stream as JSONL, the summary is checkpointed as it goes, and an interrupted run continues
with ``--resume``. Every request is a GET.

Each pass reports as it runs, against the total the server itself declares, so a long run says how
much is left rather than only how much is done. On a terminal one line is rewritten in place; when
output is redirected a fresh line is written every few seconds instead, because carriage returns
turn a log into a single unreadable row. ``--quiet`` drops the running lines and keeps the summary.

Keep credentials out of shell history and the process list:

    export CEDAR_API_KEY=...
    python3 ops/cedar_permission_inventory.py \
      --server https://resource.metadatacenter.org \
      --group-server https://group.metadatacenter.org \
      --out production-permission-findings.jsonl

Pages are read by offset against one moving index, so a resource created or deleted mid-pass can be
seen twice or missed. That is immaterial to a proportion and worth knowing before quoting an exact
total.

No third-party packages are required.
"""

from __future__ import annotations

import argparse
import collections
import getpass
import json
import os
import random
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

DEFAULT_SERVER = "https://resource.metadatacenter.org"
DEFAULT_GROUP_SERVER = "https://group.metadatacenter.org"
DEFAULT_PAGE_SIZE = 500
DEFAULT_WORKERS = 4
DEFAULT_PROGRESS_EVERY = 300

# The search parameter name for each kind, and the path its permissions hang off.
RESOURCE_TYPES = {
    "folder": "folders",
    "template": "templates",
    "element": "template-elements",
    "field": "template-fields",
    "instance": "template-instances",
}
DEFAULT_TYPES = ("folder", "template", "element", "instance")

WRITE = "write"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def encode(identifier: str) -> str:
    return urllib.parse.quote(identifier, safe="")


class KeyRejected(Exception):
    """The server refused the key. Raised so the run reports it rather than unwinding.

    The server's own ``errorKey`` is carried through, because it distinguishes two very
    different failures that both surface as 401: ``authorizationNotFound`` means no
    credential reached the server at all, and anything else means the key arrived and was
    rejected on its merits.
    """

    def __init__(self, url: str, error_key: str = "", message: str = "") -> None:
        super().__init__(url)
        self.url = url
        self.error_key = error_key
        self.message = message


class GetOnlyClient:
    """A GET-only HTTP client that never logs, stores or echoes the key it carries."""

    def __init__(self, api_key: str, insecure: bool = False, timeout: int = 60,
                 retries: int = 3) -> None:
        self._auth = f"apiKey {api_key}"
        self.timeout = timeout
        self.retries = retries
        self.context = ssl.create_default_context()
        if insecure:
            self.context.check_hostname = False
            self.context.verify_mode = ssl.CERT_NONE
        self.requests = 0
        self._lock = threading.Lock()

    def get(self, url: str) -> Any:
        last: Optional[Exception] = None
        for attempt in range(self.retries):
            try:
                request = urllib.request.Request(url, headers={
                    "Authorization": self._auth,
                    "Accept": "application/json",
                })
                with urllib.request.urlopen(request, timeout=self.timeout,
                                            context=self.context) as response:
                    with self._lock:
                        self.requests += 1
                    return json.load(response)
            except urllib.error.HTTPError as error:
                # A refusal is an answer about this key's reach, not a transport failure.
                if error.code in (401, 403, 404):
                    with self._lock:
                        self.requests += 1
                    if error.code == 401:
                        error_key, detail = "", ""
                        try:
                            body = json.loads(error.read().decode("utf-8", "replace"))
                            error_key = str(body.get("errorKey", ""))
                            detail = str(body.get("message", ""))
                        except (ValueError, OSError):
                            pass
                        raise KeyRejected(url, error_key, detail) from error
                    raise
                last = error
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                last = error
            time.sleep(2 ** attempt)
        raise RuntimeError(f"GET failed after {self.retries} attempts: {url}") from last


def search_page(client: GetOnlyClient, server: str, types: tuple[str, ...],
                offset: int, limit: int) -> dict[str, Any]:
    # An inventory has to see every stored resource, not the default view: without
    # version=all and publication_status=all the search answers with latest-published
    # only, which silently omits drafts and superseded versions. The sort makes offset
    # paging walk a stable order rather than whatever the index returns first.
    query = urllib.parse.urlencode({
        "resource_types": ",".join(types),
        "version": "all",
        "publication_status": "all",
        "sort": "createdOnTS,name",
        "offset": offset,
        "limit": limit,
    })
    return client.get(f"{server}/search-deep?{query}")


def iterate_resources(client: GetOnlyClient, server: str, types: tuple[str, ...],
                      limit: int, cap: Optional[int],
                      progress: Optional["Progress"] = None) -> Iterator[dict[str, Any]]:
    """Walk the search index by offset, stopping at the total the first page reports."""
    offset = 0
    total: Optional[int] = None
    seen = 0
    while True:
        page = search_page(client, server, types, offset, limit)
        if total is None:
            total = page.get("totalCount")
            if not isinstance(total, int):
                raise RuntimeError("search-deep did not report a totalCount")
            if progress is not None:
                progress.set_total(min(total, cap) if cap is not None else total)
        rows = page.get("resources") or []
        if not rows:
            return
        for row in rows:
            yield row
            seen += 1
            if progress is not None:
                progress.advance()
            if cap is not None and seen >= cap:
                return
        offset += len(rows)
        if offset >= total:
            return


class Progress:
    """Reports how far a pass has got, on a terminal and in a log alike.

    A pass over a production deployment runs for minutes with nothing to show, which reads
    as a hang. This reports against the total the server itself declares, so the line says
    how much is left rather than only how much is done.

    Attached to a terminal it rewrites one line. Redirected to a file it writes a fresh line
    at an interval instead, because carriage returns turn a log into one unreadable row.
    """

    def __init__(self, label: str, total: Optional[int] = None, every: int = 250,
                 interval: float = 5.0, quiet: bool = False) -> None:
        self.label = label
        self.total = total
        self.every = max(1, every)
        self.interval = interval
        self.quiet = quiet
        self.count = 0
        self.started = time.monotonic()
        self.last_emit = 0.0
        self.last_count = -1
        self.tty = sys.stderr.isatty()
        self._lock = threading.Lock()

    def set_total(self, total: Optional[int]) -> None:
        with self._lock:
            self.total = total

    @staticmethod
    def _duration(seconds: float) -> str:
        seconds = int(max(0, seconds))
        if seconds < 60:
            return f"{seconds}s"
        if seconds < 3600:
            return f"{seconds // 60}m{seconds % 60:02d}s"
        return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}m"

    def _render(self, note: str) -> str:
        elapsed = time.monotonic() - self.started
        rate = self.count / elapsed if elapsed > 0 else 0.0
        parts = [f"{self.label}: {self.count}"]
        if self.total:
            parts[0] += f"/{self.total} ({100 * self.count / self.total:.0f}%)"
            if rate > 0 and self.count < self.total:
                parts.append(f"eta {self._duration((self.total - self.count) / rate)}")
        parts.append(f"{rate:.0f}/s")
        parts.append(self._duration(elapsed))
        if note:
            parts.append(note)
        return "  " + "  ".join(parts)

    def advance(self, step: int = 1, note: str = "") -> None:
        """Count progress, and emit when enough items or enough time has passed."""
        with self._lock:
            self.count += step
            now = time.monotonic()
            due = (self.count % self.every < step) or (now - self.last_emit >= self.interval)
            if self.quiet or not due:
                return
            self.last_emit = now
            self.last_count = self.count
            line = self._render(note)
            if self.tty:
                print(f"\r{line:<100}", end="", file=sys.stderr, flush=True)
            else:
                print(line, file=sys.stderr, flush=True)

    def finish(self, note: str = "") -> None:
        """Close the line. On a terminal that means ending the one being rewritten in
        place; in a log it means adding a final line only when the last one is stale."""
        if self.quiet:
            return
        if self.tty:
            print(f"\r{self._render(note):<100}", file=sys.stderr, flush=True)
        elif self.count != self.last_count:
            print(self._render(note), file=sys.stderr, flush=True)


def permissions_url(server: str, resource_type: str, identifier: str) -> Optional[str]:
    path = RESOURCE_TYPES.get(resource_type)
    if path is None:
        return None
    return f"{server}/{path}/{encode(identifier)}/permissions"


class Inventory:
    """Counts, and the findings worth naming individually."""

    def __init__(self) -> None:
        self.by_type: collections.Counter = collections.Counter()
        self.everybody: collections.Counter = collections.Counter()
        # An Everyone grant on a folder reaches everything inside it, so which kind
        # carries the grant decides how much it is worth. The flat count cannot say.
        self.everybody_by_type: collections.Counter = collections.Counter()
        self.open_resources = 0
        self.open_implicitly = 0
        self.owners: set[str] = set()
        self.status: collections.Counter = collections.Counter()
        self.superseded = 0
        self.user_grants: collections.Counter = collections.Counter()
        self.group_grants: collections.Counter = collections.Counter()
        self.non_owner_write = 0
        self.resources_with_write_grant = 0
        self.owner_appears_as_grantee = 0
        self.users_holding_write: set[str] = set()
        self.groups_holding_write: set[str] = set()
        self.owners_affected: collections.Counter = collections.Counter()
        self.owner_names: dict[str, str] = {}
        self.unreadable_permissions = 0
        self.resources_read = 0
        self.permissions_read = 0
        self.lock = threading.Lock()

    def note_row(self, row: dict[str, Any]) -> None:
        with self.lock:
            self.resources_read += 1
            self.by_type[row.get("resourceType") or "unknown"] += 1
            everybody = (row.get("everybodyPermission") or "none").lower()
            self.everybody[everybody] += 1
            if everybody != "none":
                self.everybody_by_type[f"{row.get('resourceType')}/{everybody}"] += 1
            self.status[str(row.get("bibo:status", "")).rsplit("#", 1)[-1] or "none"] += 1
            # The pass asks for every version, so some rows are superseded. A migration
            # over stored grants touches those too, and their share is worth knowing.
            if row.get("isLatestVersion") is False:
                self.superseded += 1
            if row.get("isOpen"):
                self.open_resources += 1
            if row.get("isOpenImplicitly"):
                self.open_implicitly += 1
            owner = row.get("ownedBy")
            if owner:
                self.owners.add(owner)
                if row.get("ownedByUserName"):
                    self.owner_names.setdefault(owner, row["ownedByUserName"])

    # A resumed run continues one inventory rather than starting a second, so the counters
    # are carried across the interruption in a sidecar. Without it a resumed pass reports
    # only what it happened to read after the restart, which reads as a much smaller estate.
    def to_state(self) -> dict[str, Any]:
        with self.lock:
            return {
                "by_type": dict(self.by_type),
                "everybody": dict(self.everybody),
                "open_resources": self.open_resources,
                "open_implicitly": self.open_implicitly,
                "user_grants": dict(self.user_grants),
                "group_grants": dict(self.group_grants),
                "non_owner_write": self.non_owner_write,
                "resources_with_write_grant": self.resources_with_write_grant,
                "owner_appears_as_grantee": self.owner_appears_as_grantee,
                "users_holding_write": sorted(self.users_holding_write),
                "groups_holding_write": sorted(self.groups_holding_write),
                "owners_affected": dict(self.owners_affected),
                "owner_names": dict(self.owner_names),
                "unreadable_permissions": self.unreadable_permissions,
                "permissions_read": self.permissions_read,
            }

    def load_state(self, state: dict[str, Any]) -> None:
        """Restore the grant counters only. Resource counts come from re-enumerating."""
        with self.lock:
            self.user_grants = collections.Counter(state.get("user_grants", {}))
            self.group_grants = collections.Counter(state.get("group_grants", {}))
            self.non_owner_write = state.get("non_owner_write", 0)
            self.resources_with_write_grant = state.get("resources_with_write_grant", 0)
            self.owner_appears_as_grantee = state.get("owner_appears_as_grantee", 0)
            self.users_holding_write = set(state.get("users_holding_write", []))
            self.groups_holding_write = set(state.get("groups_holding_write", []))
            self.owners_affected = collections.Counter(state.get("owners_affected", {}))
            self.owner_names.update(state.get("owner_names", {}))
            self.unreadable_permissions = state.get("unreadable_permissions", 0)
            self.permissions_read = state.get("permissions_read", 0)


def summarize(inventory: Inventory, groups: dict[str, Any], scope: str,
              types: tuple[str, ...], grants_pass: str, requests: int,
              started: str) -> dict[str, Any]:
    top_owners = [
        {"owner": owner, "name": inventory.owner_names.get(owner, ""), "resources": count}
        for owner, count in inventory.owners_affected.most_common(25)
    ]
    return {
        "generated": utc_now(),
        "started": started,
        "scope": scope,
        "types": list(types),
        "grants_pass": grants_pass,
        "requests": requests,
        "resources": {
            "read": inventory.resources_read,
            "by_type": dict(inventory.by_type),
            "distinct_owners": len(inventory.owners),
            "by_status": dict(inventory.status),
            "superseded_versions": inventory.superseded,
        },
        "everyone": {
            "by_permission": dict(inventory.everybody),
            "by_resource_type": dict(inventory.everybody_by_type),
            "write": inventory.everybody.get(WRITE, 0),
        },
        "openview": {
            "explicit": inventory.open_resources,
            "implicit": inventory.open_implicitly,
        },
        "direct_grants": {
            "permissions_read": inventory.permissions_read,
            "unreadable": inventory.unreadable_permissions,
            "user": dict(inventory.user_grants),
            "group": dict(inventory.group_grants),
            "non_owner_write": inventory.non_owner_write,
            "resources_with_write_grant": inventory.resources_with_write_grant,
            "owner_appears_as_grantee": inventory.owner_appears_as_grantee,
            "distinct_users_holding_write": len(inventory.users_holding_write),
            "distinct_groups_holding_write": len(inventory.groups_holding_write),
        },
        "owners_affected": {
            "count": len(inventory.owners_affected),
            "top": top_owners,
        },
        "groups": groups,
    }


def preflight(client: GetOnlyClient, server: str) -> None:
    """Prove the key is accepted before a pass that may run for hours."""
    search_page(client, server, ("template",), 0, 1)


def inspect_groups(client: GetOnlyClient, group_server: str, emit,
                   quiet: bool = False) -> dict[str, Any]:
    """Enumerate groups, their membership, and the ones holding no administrator."""
    try:
        listing = client.get(f"{group_server}/groups")
    except urllib.error.HTTPError as error:
        if error.code == 403:
            # Reading a group is gated by the global GROUP_READ permission rather than by
            # membership, so a key that reads every resource it owns can still be refused
            # the group listing outright. Only an account holding that role can supply the
            # group half of this inventory.
            return {"error": "the key lacks the global GROUP_READ permission (403), so no "
                             "group can be listed or its membership read"}
        return {"error": f"group listing unavailable: {error}"}
    except RuntimeError as error:
        return {"error": f"group listing unavailable: {error}"}
    entries = listing.get("groups", listing) if isinstance(listing, dict) else listing
    if not isinstance(entries, list):
        return {"error": "group listing had an unexpected shape"}

    membership: dict[str, int] = {}
    without_administrator: list[dict[str, str]] = []
    unreadable = 0
    walking = Progress("groups", total=len(entries), every=10, quiet=quiet)
    for entry in entries:
        identifier = entry.get("@id")
        if not identifier:
            continue
        name = entry.get("schema:name", "")
        try:
            members = client.get(f"{group_server}/groups/{encode(identifier)}/users")
        except (urllib.error.HTTPError, RuntimeError):
            unreadable += 1
            continue
        walking.advance()
        users = members.get("users", []) if isinstance(members, dict) else []
        membership[identifier] = sum(1 for u in users if u.get("member"))
        if not any(u.get("administrator") for u in users):
            without_administrator.append({"group": identifier, "name": name})
            emit({
                "kind": "group_without_administrator",
                "group": identifier,
                "name": name,
                "members": membership[identifier],
                "special": entry.get("specialGroup"),
            })
    walking.finish()
    return {
        "count": len(entries),
        "membership": membership,
        "without_administrator": without_administrator,
        "unreadable": unreadable,
        "special": {e.get("@id"): e.get("specialGroup") for e in entries if e.get("specialGroup")},
    }


def read_grants(client: GetOnlyClient, server: str, row: dict[str, Any],
                inventory: Inventory, group_members: dict[str, int], emit) -> None:
    """Read one resource's direct grants and record what the migration would have to decide."""
    identifier = row.get("@id")
    resource_type = row.get("resourceType")
    url = permissions_url(server, resource_type, identifier or "")
    if url is None or identifier is None:
        return
    try:
        payload = client.get(url)
    except (urllib.error.HTTPError, RuntimeError):
        with inventory.lock:
            inventory.unreadable_permissions += 1
        return

    owner = (payload.get("owner") or {}).get("@id") or row.get("ownedBy")
    owner_name = row.get("ownedByUserName") or ""
    resource_write_grants: list[dict[str, str]] = []

    for grant in payload.get("userPermissions") or []:
        level = (grant.get("permission") or "").lower()
        grantee = (grant.get("user") or {}).get("@id")
        with inventory.lock:
            inventory.user_grants[level or "unknown"] += 1
            if grantee and owner and grantee == owner:
                inventory.owner_appears_as_grantee += 1
        if level == WRITE and grantee:
            resource_write_grants.append({
                "principal": "user",
                "id": grantee,
                "email": (grant.get("user") or {}).get("email", ""),
            })

    for grant in payload.get("groupPermissions") or []:
        level = (grant.get("permission") or "").lower()
        group = (grant.get("group") or {}).get("@id")
        with inventory.lock:
            inventory.group_grants[level or "unknown"] += 1
        if level == WRITE and group:
            resource_write_grants.append({
                "principal": "group",
                "id": group,
                "name": (grant.get("group") or {}).get("schema:name", ""),
                # None, not 0: an unread group listing means the reach is unknown
                # rather than empty, and a number here would be read as a count.
                "members": group_members.get(group),
            })

    with inventory.lock:
        inventory.permissions_read += 1
        for grant in resource_write_grants:
            if grant["principal"] == "user" and grant["id"] != owner:
                inventory.non_owner_write += 1
                inventory.users_holding_write.add(grant["id"])
            elif grant["principal"] == "group":
                inventory.groups_holding_write.add(grant["id"])
        if resource_write_grants:
            inventory.resources_with_write_grant += 1
            if owner:
                inventory.owners_affected[owner] += 1

    if resource_write_grants:
        emit({
            "kind": "write_grant",
            "resource": identifier,
            "resource_type": resource_type,
            "name": row.get("schema:name", ""),
            "owner": owner,
            "owner_name": owner_name,
            "everybody": (row.get("everybodyPermission") or "none").lower(),
            "is_open": bool(row.get("isOpen")),
            "grants": resource_write_grants,
        })


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="GET-only inventory of stored permissions, for planning the WRITE migration.")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="Resource server base URL.")
    parser.add_argument("--group-server", default=DEFAULT_GROUP_SERVER,
                        help="Group server base URL.")
    parser.add_argument("--types", default=",".join(DEFAULT_TYPES),
                        help=f"Comma-separated resource types. Known: {', '.join(RESOURCE_TYPES)}.")
    parser.add_argument("--out", default="permission-inventory-findings.jsonl",
                        help="JSONL findings stream.")
    parser.add_argument("--summary", default=None,
                        help="Summary JSON path (defaults to the findings path with -summary.json).")
    parser.add_argument("--refs", default=None,
                        help="Completion log used by --resume (defaults alongside the findings).")
    parser.add_argument("--resume", action="store_true",
                        help="Skip resources already recorded in the completion log.")
    parser.add_argument("--limit", type=int, default=DEFAULT_PAGE_SIZE, help="Search page size.")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                        help="Concurrent permission reads. Use 1 against a busy deployment.")
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY,
                        help="Resources between progress lines and summary checkpoints.")
    parser.add_argument("--max-resources", type=int, default=None,
                        help="Stop after this many resources, for a trial run.")
    parser.add_argument("--sample", type=int, default=None,
                        help="Read grants for a random sample of this many resources only.")
    parser.add_argument("--no-grants", action="store_true",
                        help="Run the cheap pass alone: owners, Everyone and OpenView.")
    parser.add_argument("--no-groups", action="store_true", help="Skip the group pass.")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress the running progress lines; keep the final summary.")
    parser.add_argument("--insecure", action="store_true",
                        help="Do not verify TLS, for a local .orgx stack.")
    parser.add_argument("--seed", type=int, default=None, help="Seed for --sample.")
    args = parser.parse_args(argv)

    types = tuple(t.strip() for t in args.types.split(",") if t.strip())
    unknown = [t for t in types if t not in RESOURCE_TYPES]
    if unknown:
        parser.error(f"unknown resource type(s): {', '.join(unknown)}")

    api_key = (os.environ.get("CEDAR_API_KEY") or getpass.getpass("CEDAR API key: ")).strip()
    # The key is often copied out of a profile page or a curl line with the scheme
    # attached, and the prompt hides the result, so a pasted prefix is invisible.
    if api_key.lower().startswith("apikey "):
        api_key = api_key[len("apikey "):].strip()
    if not api_key:
        parser.error("no API key supplied")

    out_path = Path(args.out)
    summary_path = Path(args.summary) if args.summary else out_path.with_name(
        out_path.stem + "-summary.json")
    refs_path = Path(args.refs) if args.refs else out_path.with_name(out_path.stem + "-refs.jsonl")
    state_path = out_path.with_name(out_path.stem + "-state.json")
    # Four files are written alongside the findings; create the directory rather than
    # failing after a long command has already been typed.
    if out_path.parent and not out_path.parent.exists():
        out_path.parent.mkdir(parents=True, exist_ok=True)

    done: set[str] = set()
    if args.resume and refs_path.exists():
        with refs_path.open() as handle:
            for line in handle:
                line = line.strip()
                if line:
                    done.add(line)
        print(f"resuming: {len(done)} resource(s) already read", file=sys.stderr)

    client = GetOnlyClient(api_key.strip(), insecure=args.insecure)
    inventory = Inventory()
    if args.resume and state_path.exists():
        inventory.load_state(json.loads(state_path.read_text()))
        print(f"resuming: {inventory.non_owner_write} non-owner write grant(s) carried forward",
              file=sys.stderr)
    started = utc_now()
    write_lock = threading.Lock()

    findings = out_path.open("a" if args.resume else "w")
    refs = refs_path.open("a" if args.resume else "w")

    def emit(record: dict[str, Any]) -> None:
        with write_lock:
            findings.write(json.dumps(record, sort_keys=True) + "\n")
            findings.flush()

    def checkpoint(groups: dict[str, Any], grants_pass: str) -> None:
        summary = summarize(inventory, groups, "key-scoped", types, grants_pass,
                            client.requests, started)
        summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
        state_path.write_text(json.dumps(inventory.to_state(), sort_keys=True) + "\n")

    groups: dict[str, Any] = {}
    group_members: dict[str, int] = {}
    try:
        try:
            preflight(client, args.server.rstrip("/"))
        except KeyRejected as rejected:
            findings.close()
            refs.close()
            print(f"{args.server} answered 401.", file=sys.stderr)
            if rejected.error_key:
                print(f"  server errorKey: {rejected.error_key}", file=sys.stderr)
            if rejected.message:
                print(f"  server message:  {rejected.message}", file=sys.stderr)
            if rejected.error_key == "authorizationNotFound":
                print("  That is the answer for a request carrying no credential at all, so the\n"
                      "  key never reached the server. An empty CEDAR_API_KEY, or a shell that\n"
                      "  expanded it to nothing, produces exactly this.", file=sys.stderr)
            else:
                print("  The credential arrived and was refused on its merits. It is sent with the\n"
                      "  CEDAR apiKey scheme, so what is wrong is the value: check it is the API key\n"
                      "  from the CEDAR profile page rather than a password or an admin token, and\n"
                      "  that it belongs to this deployment.", file=sys.stderr)
            print("  export CEDAR_API_KEY=... avoids a mistyped paste the prompt cannot show you.",
                  file=sys.stderr)
            return 2
        if not args.no_groups:
            print(f"reading groups from {args.group_server}", file=sys.stderr)
            groups = inspect_groups(client, args.group_server.rstrip("/"), emit, args.quiet)
            if groups.get("error"):
                # Reporting "0 groups" for a listing that could not be read states a
                # finding the run never established, so say which it was.
                print(f"groups: NOT READ — {groups['error']}", file=sys.stderr)
                print(f"  the group counts are absent from this run, not zero. Check "
                      f"--group-server (currently {args.group_server}).", file=sys.stderr)
            else:
                group_members = groups.get("membership", {}) or {}
                without = groups.get("without_administrator") or []
                print(f"groups: {groups.get('count', 0)}, "
                      f"without an administrator: {len(without)}", file=sys.stderr)

        server = args.server.rstrip("/")
        print(f"enumerating {', '.join(types)} through {server}/search-deep", file=sys.stderr)
        enumeration = Progress("enumerating", every=args.limit, quiet=args.quiet)
        rows = []
        for row in iterate_resources(client, server, types, args.limit, args.max_resources,
                                     enumeration):
            inventory.note_row(row)
            rows.append(row)
            # Everything the migration has to act on that enumeration alone can see is
            # named here, so the cheap pass yields lists rather than counts nobody can act
            # on: the Everyone grants it must decide about, and the public surface the
            # OpenView decision covers. Resumed runs append, so skip what is already logged.
            identifier = row.get("@id") or ""
            if identifier and identifier not in done:
                everybody = (row.get("everybodyPermission") or "none").lower()
                subject = {
                    "resource": identifier,
                    "resource_type": row.get("resourceType"),
                    "name": row.get("schema:name", ""),
                    "owner": row.get("ownedBy"),
                    "owner_name": row.get("ownedByUserName", ""),
                    "is_open": bool(row.get("isOpen")),
                    "status": str(row.get("bibo:status", "")).rsplit("#", 1)[-1],
                    "latest_version": row.get("isLatestVersion"),
                }
                if everybody != "none":
                    emit({"kind": f"everyone_{everybody}", "everybody": everybody, **subject})
                if row.get("isOpen") or row.get("isOpenImplicitly"):
                    emit({"kind": "openview", "implicit": bool(row.get("isOpenImplicitly")),
                          **subject})
        enumeration.finish()
        print(f"enumerated {len(rows)} resource(s) across {', '.join(types)}", file=sys.stderr)

        grants_pass = "skipped"
        if not args.no_grants:
            targets = [r for r in rows if (r.get("@id") or "") not in done]
            if args.sample is not None and args.sample < len(targets):
                random.Random(args.seed).shuffle(targets)
                targets = targets[:args.sample]
                grants_pass = f"sample of {len(targets)}"
            else:
                grants_pass = "complete for the readable set"

            print(f"reading permissions for {len(targets)} resource(s) "
                  f"with {args.workers} worker(s)", file=sys.stderr)
            reading = Progress("permissions", total=len(targets),
                               every=args.progress_every, quiet=args.quiet)
            processed = 0

            def work(row: dict[str, Any]) -> None:
                nonlocal processed
                read_grants(client, server, row, inventory, group_members, emit)
                with write_lock:
                    identifier = row.get("@id")
                    if identifier:
                        refs.write(identifier + "\n")
                        refs.flush()
                    processed += 1
                    due = processed % args.progress_every == 0
                reading.advance(note=f"{inventory.non_owner_write} non-owner write")
                if due:
                    checkpoint(groups, grants_pass)

            if args.workers > 1:
                with ThreadPoolExecutor(max_workers=args.workers) as pool:
                    list(pool.map(work, targets))
            else:
                for row in targets:
                    work(row)
            reading.finish(note=f"{inventory.non_owner_write} non-owner write")

        checkpoint(groups, grants_pass)
    finally:
        findings.close()
        refs.close()

    summary = json.loads(summary_path.read_text())
    direct = summary["direct_grants"]
    print("")
    print(f"resources read              {summary['resources']['read']}")
    print(f"  by type                   {summary['resources']['by_type']}")
    print(f"Everyone by permission      {summary['everyone']['by_permission']}")
    print(f"  Everyone + WRITE          {summary['everyone']['write']}")
    print(f"OpenView explicit/implicit  {summary['openview']['explicit']}/"
          f"{summary['openview']['implicit']}")
    print(f"permissions read            {direct['permissions_read']} "
          f"(unreadable {direct['unreadable']})")
    print(f"user grants                 {direct['user']}")
    print(f"group grants                {direct['group']}")
    print(f"NON-OWNER WRITE GRANTS      {direct['non_owner_write']}")
    print(f"  resources with any write  {direct['resources_with_write_grant']}")
    print(f"  distinct users            {direct['distinct_users_holding_write']}")
    print(f"  distinct groups           {direct['distinct_groups_holding_write']}")
    print(f"owners affected             {summary['owners_affected']['count']}")
    if summary["groups"].get("error"):
        print(f"groups                      NOT READ ({summary['groups']['error']})")
    elif summary["groups"]:
        print(f"groups without an admin     "
              f"{len(summary['groups'].get('without_administrator', []))}")
    print("")
    print(f"findings  {out_path}")
    print(f"summary   {summary_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
