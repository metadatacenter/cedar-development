#!/usr/bin/env python3
"""Propose the acronym each unusable constraint acronym meant, and check it against BioPortal.

An `acronym` names the ontology serving a constraint's terms, and paired with a system it is what
addresses a source. Production holds help text there, and a pasted BioPortal browse URL. Neither
addresses anything, and the meta-schema asks only for a string, so nothing refused them on write.

A wrong acronym is worse than an unusable one: a lookup then succeeds against the wrong vocabulary,
and nothing reports it. So nothing here is written from resemblance. Each proposal comes from one of
two places in the artifact itself, and is kept only when BioPortal confirms the acronym exists:

- the stored value's own first token, which is what a pasted browse URL leaves in front of its query
- the entry's `source`, the legacy display string that carries the acronym in parentheses

Where the entry also names a term, the proposal is confirmed a second time by asking BioPortal for
that term within the proposed ontology. An entry whose term does not resolve there is reported
rather than proposed, because the acronym and the term have to address the same thing.

Reports by default and writes only the sheet, never an artifact. Its output is the confirmed file
`cedar_artifact_repair.py --repair resolve-constraint-source --acronyms` takes, and an owner is
meant to read it before that runs.

    python3 acronym_sheet.py --offences ~/cedar-constraint-offences.jsonl --out acronyms.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as audit  # noqa: E402

BIOPORTAL = "https://data.bioontology.org"
ACRONYM_SHAPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# A pasted browse URL leaves the acronym in front of its query; a sentence leaves nothing usable.
FIRST_TOKEN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)")
SOURCE_ACRONYM = re.compile(r"\(([^()]+)\)\s*$")
CONSTRAINT_GROUPS = ("ontologies", "valueSets", "classes", "branches")


def candidates(stored: str, source: Optional[str]) -> list[tuple[str, str]]:
    """The acronyms this entry itself suggests, each with where it came from."""
    found: list[tuple[str, str]] = []
    token = FIRST_TOKEN.match(stored or "")
    if token and ACRONYM_SHAPE.match(token.group(1)) and token.group(1) != stored:
        found.append((token.group(1), "the stored value's first token"))
    if isinstance(source, str):
        parenthesised = SOURCE_ACRONYM.search(source)
        if parenthesised and ACRONYM_SHAPE.match(parenthesised.group(1).strip()):
            found.append((parenthesised.group(1).strip(), "the entry's source string"))
        elif ACRONYM_SHAPE.match(source.strip()):
            found.append((source.strip(), "the entry's source string"))
    ordered: list[tuple[str, str]] = []
    for acronym, where in found:
        if acronym not in {a for a, _ in ordered}:
            ordered.append((acronym, where))
    return ordered


class BioPortal:
    """Read-only BioPortal lookups, with what has been asked kept so a value is asked once."""

    def __init__(self, api_key: str, timeout: float = 30.0):
        self._key = api_key
        self._timeout = timeout
        self._ontologies: dict[str, Optional[dict[str, str]]] = {}

    def _get(self, path: str) -> Optional[Any]:
        request = urllib.request.Request(
            f"{BIOPORTAL}{path}", headers={"Authorization": f"apikey token={self._key}",
                                           "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return json.load(response)
        except (urllib.error.URLError, ValueError, OSError):
            return None

    def ontology(self, acronym: str) -> Optional[dict[str, str]]:
        """The ontology's name and canonical IRI, or None where BioPortal serves no such acronym."""
        if acronym not in self._ontologies:
            body = self._get(f"/ontologies/{urllib.parse.quote(acronym, safe='')}")
            self._ontologies[acronym] = (
                {"name": body["name"], "uri": body.get("@id") or f"{BIOPORTAL}/ontologies/{acronym}"}
                if isinstance(body, dict) and body.get("name") else None)
        return self._ontologies[acronym]

    def serves_term(self, acronym: str, term_iri: str) -> bool:
        """Whether that ontology serves that term, which is the second confirmation."""
        body = self._get(f"/ontologies/{urllib.parse.quote(acronym, safe='')}"
                         f"/classes/{urllib.parse.quote(term_iri, safe='')}")
        return isinstance(body, dict) and "@id" in body


CONCEPT_ID = re.compile(r"[?&]conceptid=([^&]+)")


def intended_term(stored: str, entry: dict) -> Optional[str]:
    """The term this entry meant, where anything in it still says.

    A pasted browse URL carries it as the `conceptid` parameter, which survives the paste even
    though every other part of the address was overwritten by it. Failing that, the entry's own
    term IRI counts, unless it is the pasted value as well.
    """
    found = CONCEPT_ID.search(stored or "")
    if found:
        return urllib.parse.unquote(found.group(1))
    for key in ("uri", "termUri"):
        value = entry.get(key)
        if isinstance(value, str) and value != stored and value.startswith(("http://", "https://")):
            return value
    return None


def entry_at(artifact: Any, path: str) -> Optional[dict]:
    """The constraint entry an offence's path points into, or None where the path does not lead."""
    node: Any = artifact
    for step in [p for p in path.split("/") if p][:-1]:
        step = step.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            if not step.isdigit() or int(step) >= len(node):
                return None
            node = node[int(step)]
        elif isinstance(node, dict):
            if step not in node:
                return None
            node = node[step]
        else:
            return None
    return node if isinstance(node, dict) else None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offences", required=True,
                        help="the survey's offences JSONL, filtered to the acronym property")
    parser.add_argument("--server", default=rest.DEFAULT_SERVER)
    parser.add_argument("--api-key-file")
    parser.add_argument("--bioportal-key", help="defaults to $CEDAR_BIOPORTAL_API_KEY")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--out",
                        help="write the confirmed {storedValue: {acronym, name, uri}} JSON here")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    bioportal_key = arguments.bioportal_key or os.environ.get("CEDAR_BIOPORTAL_API_KEY")
    if not bioportal_key:
        parser.error("set CEDAR_BIOPORTAL_API_KEY or pass --bioportal-key")
    api_key = rest.resolve_api_key(arguments, parser)
    client = rest.GetOnlyClient(arguments.server, api_key, timeout=arguments.timeout)
    bioportal = BioPortal(bioportal_key)

    offences = []
    for line in Path(arguments.offences).expanduser().read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("property") == "acronym":
            offences.append(record)
    print(f"{len(offences)} acronym occurrences to account for, "
          f"{len({o['value'] for o in offences})} distinct values\n")

    confirmed: dict[str, dict[str, str]] = {}
    unresolved: dict[str, list[str]] = {}
    bodies: dict[str, Any] = {}
    for offence in offences:
        stored = offence["value"]
        if stored in confirmed:
            continue
        artifact_id = offence["artifactId"]
        if artifact_id not in bodies:
            ref = rest.ArtifactRef(offence["artifactType"], artifact_id,
                                   offence.get("artifactName", ""))
            body, error = audit.fetch_artifact(client, ref)
            if body is None:
                unresolved.setdefault(stored, []).append(f"could not read {artifact_id}: {error}")
                continue
            bodies[artifact_id] = body
        entry = entry_at(bodies[artifact_id], offence["path"])
        if entry is None:
            unresolved.setdefault(stored, []).append(f"no entry at {offence['path']}")
            continue
        term = intended_term(stored, entry)
        notes: list[str] = []
        for acronym, where in candidates(stored, entry.get("source")):
            ontology = bioportal.ontology(acronym)
            if ontology is None:
                notes.append(f"{acronym!r} from {where}: BioPortal serves no such acronym")
                continue
            if isinstance(term, str) and not bioportal.serves_term(acronym, term):
                notes.append(f"{acronym!r} from {where}: {ontology['name']}, "
                             f"but it does not serve {term}")
                continue
            # Every spelling of the paste this entry holds, so the repair overwrites exactly
            # those and nothing that merely looks like them.
            replaces = [stored]
            for key in ("uri", "name"):
                held = entry.get(key)
                if isinstance(held, str) and held not in replaces and (
                        held == stored or held.endswith(stored)):
                    replaces.append(held)
            confirmed[stored] = {"acronym": acronym, "name": ontology["name"],
                                 "uri": ontology["uri"], "replaces": replaces}
            print(f"  {stored[:58]!r}\n      acronym -> {acronym}   ({where})")
            print(f"      name    -> {ontology['name']}")
            print(f"      uri     -> {ontology['uri']}")
            if isinstance(term, str):
                print(f"      confirmed against the term it names: {term}")
            for held in replaces[1:]:
                print(f"      also overwriting: {held[:70]!r}")
            break
        else:
            unresolved.setdefault(stored, []).extend(notes or ["nothing in the entry suggests one"])

    if unresolved:
        print(f"\n{len(unresolved)} values nothing confirms; each needs an owner:")
        for stored, notes in unresolved.items():
            print(f"  {stored[:70]!r}")
            for note in dict.fromkeys(notes):
                print(f"      {note}")
    if arguments.out:
        Path(arguments.out).expanduser().write_text(json.dumps(confirmed, indent=2) + "\n",
                                                    encoding="utf-8")
        print(f"\n{len(confirmed)} confirmed addresses written to {arguments.out}")
        print("Read them before passing the file to --acronyms; nothing is rewritten without it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
