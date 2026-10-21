#!/usr/bin/env python3
"""Grant a group a role on every instance of a template.

Production runs this every ten minutes from ``share-instances.sh``, once per sharing rule, so each
pass gives the group access to the instances created since the last one. An instance whose
permissions already name the group is left as it is, whatever role they give it.

    python3 ops/cron/cedar_share_instances.py TEMPLATE_ID GROUP_ID {viewer,editor,manager}

The resource server is ``https://resource.$CEDAR_HOST``, and the requests authenticate with
``CEDAR_ADMIN_USER_API_KEY``. The cron entry sources the profile that sets both. TLS is verified
against the default trust store; ``SSL_CERT_FILE`` points Python at another one.

Each grant reads the instance's permissions and writes them back under the ETag that read returned,
as the server requires. An instance whose permissions changed in between is refused with 412, and
the next pass grants it. A failure on one instance is reported and the pass continues; the exit
status is 1 if any instance failed. No third-party packages are required.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator, Optional

ROLES = ("viewer", "editor", "manager")
# The resource server refuses a search page of 500 or more.
PAGE_SIZE = 100
TIMEOUT_SECONDS = 60


def call(method: str, url: str, api_key: str, body: Optional[dict] = None,
         if_match: Optional[str] = None) -> tuple[Any, Optional[str]]:
    """Sends one request and returns its JSON body with the ETag it carried."""
    headers = {"Authorization": "apiKey " + api_key, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if if_match is not None:
        headers["If-Match"] = if_match
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        payload = response.read()
        return (json.loads(payload) if payload else None), response.headers.get("ETag")


def instance_ids(server: str, api_key: str, template_id: str) -> Iterator[str]:
    """The identifiers of the template's instances, read page by page.

    A query by template carries no continuation, so the pages are asked for by offset.
    """
    offset = 0
    while True:
        query = urllib.parse.urlencode({"is_based_on": template_id, "offset": offset, "limit": PAGE_SIZE})
        page, _ = call("GET", f"{server}/search-deep?{query}", api_key)
        resources = page.get("resources") or []
        for resource in resources:
            yield resource["@id"]
        offset += len(resources)
        if not resources or offset >= page.get("totalCount", 0):
            return


def permissions_request(permissions: dict) -> dict:
    """The writable part of a permissions read, which is all the server accepts back.

    A read also names the owner and each group, and the server refuses a write that carries those.
    """
    return {
        "owner": {"@id": permissions["owner"]["@id"]},
        "userPermissions": [{"user": {"@id": entry["user"]["@id"]}, "role": entry["role"]}
                            for entry in permissions.get("userPermissions") or []],
        "groupPermissions": [{"group": {"@id": entry["group"]["@id"]}, "role": entry["role"]}
                             for entry in permissions.get("groupPermissions") or []],
    }


def grant(server: str, api_key: str, instance_id: str, group_id: str, role: str) -> bool:
    """Gives the group the role on one instance, and reports whether anything changed."""
    url = f"{server}/template-instances/{urllib.parse.quote(instance_id, safe='')}/permissions"
    permissions, etag = call("GET", url, api_key)
    request = permissions_request(permissions)
    if any(entry["group"]["@id"] == group_id for entry in request["groupPermissions"]):
        return False
    request["groupPermissions"].append({"group": {"@id": group_id}, "role": role})
    call("PUT", url, api_key, body=request, if_match=etag)
    return True


def share(server: str, api_key: str, template_id: str, group_id: str, role: str) -> int:
    """Grants the role on every instance of the template, and returns how many grants failed."""
    failures = 0
    for instance_id in instance_ids(server, api_key, template_id):
        try:
            if grant(server, api_key, instance_id, group_id, role):
                print(f"Granted {role} on {instance_id} to {group_id}")
        except urllib.error.HTTPError as error:
            failures += 1
            print(f"Could not share {instance_id} with {group_id}: HTTP {error.code}", file=sys.stderr)
    return failures


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Grant a group a role on every instance of a template.")
    parser.add_argument("template_id")
    parser.add_argument("group_id")
    parser.add_argument("role", choices=ROLES)
    args = parser.parse_args(argv)
    server = "https://resource." + os.environ["CEDAR_HOST"]
    failures = share(server, os.environ["CEDAR_ADMIN_USER_API_KEY"], args.template_id, args.group_id, args.role)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
