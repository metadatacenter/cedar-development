#!/usr/bin/env python3
"""Repair a defect across a population of stored CEDAR artifacts, one verbatim write at a time.

A repair here is a transform narrow enough to state as an invariant: it changes exactly the thing it
names and provably nothing else. Each artifact is fetched, transformed, checked against that
invariant, validated by ``cedar-model-validation-library``, and only then written back with
``PUT ?verbatim=true``, which stores the body as supplied. The artifact therefore keeps its
identifier, provenance timestamps, version, publication status and every child identifier, and the
unrelated normalization an ordinary update performs never runs.

Two repairs are implemented. ``empty-derived-from`` deletes every ``pav:derivedFrom`` whose value is
the empty string, at the root and at every depth: the key is optional, so absence is how an artifact
that was derived from nothing says so, while the empty string is the same claim in a form the model
cannot read. ``mint-child-ids`` gives every child whose own ``@id`` is missing or not an absolute IRI
a fresh one under the prefix its type requires, which is what the server does on an ordinary write
and cannot do on a verbatim one. Neither touches anything an instance refers to.

Repairs compose, and for some artifacts they must. A child identifier the server would have to mint
makes it refuse the verbatim write outright, so an artifact carrying that defect alongside another
cannot be fixed by either repair alone: one leaves the artifact invalid, the other cannot be written.
Naming both applies them in one write, each stage answering to its own invariant.

Targets come from an earlier ``cedar_artifact_validation_audit.py`` run rather than a fresh walk:
the audit already knows which artifacts carry the condition. ``--condition`` narrows the target set
when a chain's conditions between them name more artifacts than the job needs.

    export CEDAR_API_KEY=...
    python3 ops/cedar_artifact_repair.py --from-records production-validation.jsonl   # dry run
    python3 ops/cedar_artifact_repair.py --from-records production-validation.jsonl --limit 5 --apply
    python3 ops/cedar_artifact_repair.py --from-records production-validation.jsonl --apply
    python3 ops/cedar_artifact_repair.py --from-records production-validation.jsonl \
      --repair mint-child-ids,empty-derived-from --condition child-id-unusable --apply

Dry run is the default and issues no writes. ``--apply`` needs the WRITE_ARTIFACT_VERBATIM
permission, which the ``artifactPrivilegedAdministrator`` role carries. Every artifact's stored body
is saved before it is written, so any write can be undone from the pre-image.

Requires JDK 17 and a built cedar-model-validation-library; ops/cedar_validate.sh resolves both.
"""

from __future__ import annotations

import argparse
import collections
import copy
import hashlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

# The audit and its REST client live one level up, in ops/, and this tool is their consumer.
OPS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(OPS))
import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as audit  # noqa: E402

DERIVED_FROM = "pav:derivedFrom"
AT_ID = "@id"
AT_TYPE = "@type"
AT_VALUE = "@value"
ELEMENT_AT_TYPE = "https://schema.metadatacenter.org/core/TemplateElement"
FIELD_AT_TYPE = "https://schema.metadatacenter.org/core/TemplateField"
# The path segment an identifier carries for each kind of child. A static field is a field here: only
# the element case picks a different prefix, which mirrors ModelUtil.childResourceType.
ELEMENT_SEGMENT = "template-elements/"
FIELD_SEGMENT = "template-fields/"
ROOT_SEGMENTS = ("templates/", "template-elements/", "template-fields/", "template-instances/")
# Where a child's property IRI is minted from. Unlike an artifact identifier this is a CEDAR-wide
# namespace rather than a per-deployment one, so it is the same constant the server holds.
PROPERTY_IRI_PREFIX = "https://schema.metadatacenter.org/properties/"
UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
OUTCOMES = ("repaired", "would-repair", "already-clean", "still-invalid", "invariant-failed",
            "transform-refused", "fetch-failed", "write-failed")
DEFAULT_PROGRESS_EVERY = 100
DEFAULT_PROGRESS_SECONDS = 30
DEFAULT_WORKERS = 4


# --------------------------------------------------------------------------------------------------
# The repairs
# --------------------------------------------------------------------------------------------------


def strip_empty_derived_from(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Delete every empty-string ``pav:derivedFrom``, and say where each one was.

    A value that is present and non-empty is left exactly as stored, even when it is unusable: this
    repair speaks only for the empty case, and a second run over a repaired artifact finds nothing.
    """
    removed: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {}
            for name, value in node.items():
                if name == DERIVED_FROM and value == "":
                    removed.append({"path": f"{path}/{rest.json_pointer_component(name)}",
                                    "replaced": value, "wrote": None})
                    continue
                result[name] = walk(value, f"{path}/{rest.json_pointer_component(name)}")
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    return walk(copy.deepcopy(artifact), ""), removed


def only_removed_empty_derived_from(before: Any, after: Any, path: str = "") -> Optional[str]:
    """The invariant. Returns the path of the first unintended difference, or None when there is none.

    Key order is deliberately not compared: JSON objects are unordered, and the transform rebuilds
    them. Everything else must be identical, including every value the repair did not name.
    """
    if isinstance(before, dict):
        if not isinstance(after, dict):
            return path or "/"
        for name, value in before.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name not in after:
                if not (name == DERIVED_FROM and value == ""):
                    return here
                continue
            difference = only_removed_empty_derived_from(value, after[name], here)
            if difference is not None:
                return difference
        for name in after:
            if name not in before:
                return f"{path}/{rest.json_pointer_component(name)}"
        return None
    if isinstance(before, list):
        if not isinstance(after, list) or len(before) != len(after):
            return path or "/"
        for index, value in enumerate(before):
            difference = only_removed_empty_derived_from(value, after[index], f"{path}/{index}")
            if difference is not None:
                return difference
        return None
    # Types are compared as well as values: Python equates False with 0 and True with 1, while JSON
    # keeps them apart, so equality alone would let one become the other unnoticed.
    return None if type(before) is type(after) and before == after else (path or "/")


STATIC_AT_TYPE = "https://schema.metadatacenter.org/core/StaticTemplateField"
MODEL_VERSION_KEY = "schema:schemaVersion"
ARTIFACT_VERSION_KEY = "pav:version"
# What a container's own title is composed from, by the same rule the artifact server applies on every
# ordinary write. A static field is a field here, as it is everywhere identifiers and titles are formed.
KIND_WORD = {
    "https://schema.metadatacenter.org/core/Template": "template",
    ELEMENT_AT_TYPE: "element",
    FIELD_AT_TYPE: "field",
    STATIC_AT_TYPE: "field",
}


def container_children(container: Any) -> Iterator[tuple[str, dict, bool]]:
    """The children a container declares, with their unwrapped definitions."""
    for name, child, multiple, error in rest.direct_schema_children(container):
        if not error and child is not None:
            yield name, child, multiple


def static_child_names(container: Any) -> set[str]:
    return {name for name, child, _multiple in container_children(container)
            if child.get(AT_TYPE) == STATIC_AT_TYPE}


def drop_static_field_demands(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Stop a container demanding a static field of its instances.

    A static field renders and holds nothing, so it is not a property of an instance and every CEDAR
    editor omits it. A container naming one in ``required``, in ``@context.required`` or in
    ``@context.properties`` describes an instance nothing will build, and no instance of it can
    validate. ``_ui.order`` and ``_ui.propertyLabels`` are where a static field belongs and are not
    touched.
    """
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        statics = static_child_names(result)
        if statics:
            for key, where in (("required", "required"),):
                names = result.get(key)
                if isinstance(names, list):
                    kept = [n for n in names if n not in statics]
                    for n in [n for n in names if n in statics]:
                        changes.append({"path": f"{path}/{key}", "replaced": n, "wrote": None,
                                        "where": where})
                    if kept != names:
                        result[key] = kept
            properties = result.get("properties")
            context = properties.get("@context") if isinstance(properties, dict) else None
            if isinstance(context, dict):
                names = context.get("required")
                if isinstance(names, list):
                    kept = [n for n in names if n not in statics]
                    for n in [n for n in names if n in statics]:
                        changes.append({"path": f"{path}/properties/@context/required",
                                        "replaced": n, "wrote": None, "where": "@context.required"})
                    if kept != names:
                        context["required"] = kept
                mapping = context.get("properties")
                if isinstance(mapping, dict):
                    for n in sorted(statics & set(mapping)):
                        changes.append({
                            "path": f"{path}/properties/@context/properties/"
                                    f"{rest.json_pointer_component(n)}",
                            "replaced": mapping[n], "wrote": None, "where": "@context.properties"})
                        del mapping[n]
        for name, child, multiple in container_children(container):
            declared = rest.child_path(path, name)
            here = f"{declared}/items" if multiple else declared
            repaired = walk(child, here)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_dropped_static_demands(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only differences remove a static child's name from where it was demanded.

    This walks containers the way the transform does rather than the document generically, because
    which names may disappear is decided by the container that declares them, and the three places
    they may be demanded all hang off that container.
    """

    def identical(old: Any, new: Any, path: str) -> Optional[str]:
        return None if type(old) is type(new) and old == new else (path or "/")

    def container(old: Any, new: Any, path: str) -> Optional[str]:
        if not isinstance(old, dict) or not isinstance(new, dict) or set(old) != set(new):
            return path or "/"
        statics = static_child_names(old)
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == "required" and isinstance(old[name], list):
                if [n for n in old[name] if n not in statics] != new[name]:
                    return here
                continue
            if name == "properties" and isinstance(old[name], dict):
                difference = properties(old[name], new[name], statics, here)
                if difference is not None:
                    return difference
                continue
            difference = identical(old[name], new[name], here)
            if difference is not None:
                return difference
        return None

    def properties(old: dict, new: dict, statics: set[str], path: str) -> Optional[str]:
        if not isinstance(new, dict) or set(old) != set(new):
            return path
        children = {name for name, _child, _multiple in container_children({"properties": old})}
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == "@context" and isinstance(old[name], dict):
                difference = context(old[name], new[name], statics, here)
                if difference is not None:
                    return difference
                continue
            if name in children:
                declared_old, declared_new = old[name], new[name]
                if declared_old.get("type") == "array":
                    if not isinstance(declared_new, dict) or set(declared_old) != set(declared_new):
                        return here
                    for key in declared_old:
                        inner = f"{here}/{rest.json_pointer_component(key)}"
                        difference = container(declared_old[key], declared_new[key], inner) \
                            if key == "items" else identical(declared_old[key], declared_new[key], inner)
                        if difference is not None:
                            return difference
                    continue
                difference = container(declared_old, declared_new, here)
                if difference is not None:
                    return difference
                continue
            difference = identical(old[name], new[name], here)
            if difference is not None:
                return difference
        return None

    def context(old: dict, new: dict, statics: set[str], path: str) -> Optional[str]:
        if not isinstance(new, dict) or set(old) != set(new):
            return path
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == "required" and isinstance(old[name], list):
                if [n for n in old[name] if n not in statics] != new[name]:
                    return here
                continue
            if name == "properties" and isinstance(old[name], dict):
                if {k: v for k, v in old[name].items() if k not in statics} != new[name]:
                    return here
                continue
            difference = identical(old[name], new[name], here)
            if difference is not None:
                return difference
        return None

    return container(before, after, "")


INSTANCE_ROOT_MEMBERS = frozenset({
    "schema:isBasedOn", "schema:name", "schema:description", "pav:derivedFrom",
    "pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy",
})


def drop_instance_demands_from_element(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Stop an element declaration demanding the members only an instance root carries.

    An element occurrence inside an instance carries ``@context``, ``@id`` and its own children.
    The provenance block and ``schema:isBasedOn`` belong to the instance itself, and no CEDAR editor
    has ever written them into an occurrence. A template whose element declaration lists them in
    ``required`` therefore describes an occurrence nothing builds, and every instance of it fails.
    The element meta-schema pins only the first two entries of that list, so such a template
    validates while none of its instances can.

    The template's own ``required`` is left alone: those members are exactly what an instance root
    must carry, and demanding them there is correct. Only an element's demands are narrowed, and
    only while ``@context`` and ``@id`` survive the narrowing, since the meta-schema requires both.
    """
    changes: list[dict[str, Any]] = []

    def narrow(element: Any, path: str) -> None:
        names = element.get("required")
        if not isinstance(names, list):
            return
        kept = [n for n in names if n not in INSTANCE_ROOT_MEMBERS]
        if kept == names:
            return
        if "@context" not in kept or "@id" not in kept:
            raise TransformRefused(
                f"{path or '/'} would keep neither @context nor @id, which the meta-schema requires")
        for dropped in [n for n in names if n in INSTANCE_ROOT_MEMBERS]:
            changes.append({"path": f"{path}/required", "replaced": dropped, "wrote": None})
        element["required"] = kept

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        for name, child, multiple in container_children(result):
            declared = rest.child_path(path, name)
            here = f"{declared}/items" if multiple else declared
            repaired = walk(child, here)
            if is_element(repaired):
                narrow(repaired, here)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_dropped_instance_demands(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only differences drop instance-root members from an element's ``required``.

    This walks containers the way the transform does. A name may leave a ``required`` list only where
    that list belongs to an element declaration, so the artifact's own demands are compared
    unchanged while an element's are compared against the narrowing.
    """

    def identical(old: Any, new: Any, path: str) -> Optional[str]:
        return None if type(old) is type(new) and old == new else (path or "/")

    def container(old: Any, new: Any, path: str, is_element_here: bool) -> Optional[str]:
        if not isinstance(old, dict) or not isinstance(new, dict) or set(old) != set(new):
            return path or "/"
        children = {name for name, _child, _multiple in container_children(old)}
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == "required" and is_element_here and isinstance(old[name], list):
                if [n for n in old[name] if n not in INSTANCE_ROOT_MEMBERS] != new[name]:
                    return here
                continue
            if name == "properties" and isinstance(old[name], dict):
                difference = properties(old[name], new[name], children, here)
                if difference is not None:
                    return difference
                continue
            difference = identical(old[name], new[name], here)
            if difference is not None:
                return difference
        return None

    def properties(old: dict, new: dict, children: set[str], path: str) -> Optional[str]:
        if not isinstance(new, dict) or set(old) != set(new):
            return path
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name not in children:
                difference = identical(old[name], new[name], here)
                if difference is not None:
                    return difference
                continue
            declared_old, declared_new = old[name], new[name]
            if isinstance(declared_old, dict) and isinstance(declared_old.get("items"), dict):
                if not isinstance(declared_new, dict) or set(declared_old) != set(declared_new):
                    return here
                for key in declared_old:
                    inner = f"{here}/{rest.json_pointer_component(key)}"
                    difference = (container(declared_old[key], declared_new[key], inner,
                                            is_element(declared_old[key]))
                                  if key == "items"
                                  else identical(declared_old[key], declared_new[key], inner))
                    if difference is not None:
                        return difference
                continue
            difference = container(declared_old, declared_new, here, is_element(declared_old))
            if difference is not None:
                return difference
        return None

    return container(before, after, "", False)

def mapped_serializing_children(container: Any) -> set[str]:
    """Children a container maps to a usable property IRI and whose values an instance carries.

    A non-serializing child, a section break or rich text say, is never a key of an instance, so it is
    not something the instance's ``@context`` can be made to declare.
    """
    mapping = context_properties(container)
    if not isinstance(mapping, dict):
        return set()
    names: set[str] = set()
    for name, child, _multiple in container_children(container):
        ui = child.get("_ui")
        if not isinstance(ui, dict) or ui.get("inputType") in rest.NON_SERIALIZING_INPUT_TYPES:
            continue
        present, value = mapped_property_iri(mapping.get(name))
        if present and rest.is_absolute_iri(value):
            names.add(name)
    return names


def complete_context_required(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """List in ``@context.required`` every child the container already maps to a property IRI.

    The two lists answer different questions. ``@context.properties`` says what an instance's context
    entry for a child must equal if it carries one; ``@context.required`` says it must carry one at
    all. A child in the first and not the second leaves the instance free to omit the entry, and an
    instance that omits it says nothing about what the field means, however well its value validates.

    Nothing is minted here: a child with no mapping stays unmapped and unrequired, because inventing a
    property IRI is a separate decision. Only names the container already maps are added, so the
    change tightens the contract to what the template itself already states.

    Where a container states no ``required`` at all the list is created, which is what an ordinary
    update does: the server synchronizes the two lists whenever ``@context`` is an object and its
    ``required`` is either absent or an array. A ``required`` that is present and is not an array is
    left alone, since the server refuses that shape rather than repairing it.
    """
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        mapped = mapped_serializing_children(result)
        properties = result.get("properties")
        context = properties.get("@context") if isinstance(properties, dict) else None
        stated = context.get("required") if isinstance(context, dict) else None
        if mapped and isinstance(context, dict) and (stated is None or isinstance(stated, list)):
            base = stated if isinstance(stated, list) else []
            listed = [entry for entry in base if isinstance(entry, str)]
            omitted = [name for name in
                       (n for n, _child, _multiple in container_children(result)) if
                       name in mapped and name not in listed]
            if omitted:
                context["required"] = list(base) + omitted
                for name in omitted:
                    changes.append({"path": f"{path}/properties/@context/required",
                                    "replaced": None, "wrote": name})
        for name, child, multiple in container_children(container):
            declared = rest.child_path(path, name)
            here = f"{declared}/items" if multiple else declared
            repaired = walk(child, here)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_completed_context_required(before: Any, after: Any) -> Optional[str]:
    """The invariant: a required list only gained names the container already maps, appended at the end."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            mapped = mapped_serializing_children(old)
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == "properties" and isinstance(old[name], dict):
                    difference = properties_walk(old[name], new[name], mapped, here)
                    if difference is not None:
                        return difference
                    continue
                if type(old[name]) is not type(new[name]) or old[name] != new[name]:
                    return here
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def properties_walk(old: dict, new: dict, mapped: set[str], path: str) -> Optional[str]:
        if not isinstance(new, dict) or set(old) != set(new):
            return path
        children = {name for name, _child, _multiple in container_children({"properties": old})}
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == "@context" and isinstance(old[name], dict):
                difference = context_walk(old[name], new[name], mapped, here)
                if difference is not None:
                    return difference
                continue
            if name in children:
                declared_old, declared_new = old[name], new[name]
                if isinstance(declared_old, dict) and declared_old.get("type") == "array":
                    if not isinstance(declared_new, dict) or set(declared_old) != set(declared_new):
                        return here
                    for key in declared_old:
                        inner = f"{here}/{rest.json_pointer_component(key)}"
                        difference = walk(declared_old[key], declared_new[key], inner) if key == "items" \
                            else (None if declared_old[key] == declared_new[key] else inner)
                        if difference is not None:
                            return difference
                    continue
                difference = walk(declared_old, declared_new, here)
                if difference is not None:
                    return difference
                continue
            if type(old[name]) is not type(new[name]) or old[name] != new[name]:
                return here
        return None

    def context_walk(old: dict, new: dict, mapped: set[str], path: str) -> Optional[str]:
        # The list may be created where none was stated, so it is the one key allowed to appear.
        if not isinstance(new, dict) or set(old) | {"required"} != set(new) | {"required"}:
            return path
        for name in set(old) | set(new):
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == "required":
                stated = old.get(name)
                if stated is not None and not isinstance(stated, list):
                    if new.get(name) != stated:
                        return here
                    continue
                base = stated if isinstance(stated, list) else []
                if not isinstance(new.get(name), list):
                    return here
                kept, appended = new[name][:len(base)], new[name][len(base):]
                if kept != base:
                    return here
                if any(entry not in mapped or entry in base for entry in appended):
                    return here
                if name not in old and not appended:
                    return here
                continue
            if (name in old) != (name in new):
                return here
            if type(old[name]) is not type(new[name]) or old[name] != new[name]:
                return here
        return None

    return walk(before, after, "")


def inherently_multiple(field: Any) -> bool:
    """Whether a field takes several answers because of what it is, not because an author said so.

    A checkbox and an attribute-value field always do; a list does when its constraints say
    multiple choice. Shared by the repairs that turn on that rule, so they cannot come to
    different answers about the same field.
    """
    ui = field.get("_ui") if isinstance(field, dict) else None
    if not isinstance(ui, dict):
        return False
    if ui.get("inputType") in {"checkbox", "attribute-value"}:
        return True
    constraints = field.get("_valueConstraints")
    return ui.get("inputType") == "list" and isinstance(constraints, dict) \
        and constraints.get("multipleChoice") is True


def wrap_inherently_multiple(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Deploy an inherently multiple child as the array it always serializes to.

    Checkbox, attribute-value and multiple-choice list fields emit arrays whenever they are deployed,
    so a container describing one as an object rejects every populated instance of itself. The field's
    own metadata stays on the inner definition and cardinality moves to the array envelope, which is
    the same repair the patch tool makes. A standalone field artifact is excluded: it is the reusable
    inner definition and is correctly object-shaped, so only children under a container are examined.
    """
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        for name, child, multiple in container_children(container):
            declared = rest.child_path(path, name)
            here = f"{declared}/items" if multiple else declared
            repaired = walk(child, here)
            if multiple:
                result["properties"][name]["items"] = repaired
                continue
            if not inherently_multiple(repaired):
                result["properties"][name] = repaired
                continue
            stored = result["properties"][name]
            constraints = repaired.get("_valueConstraints")
            required = isinstance(constraints, dict) and constraints.get("requiredValue") is True
            minimum = stored.get("minItems")
            if not isinstance(minimum, int) or isinstance(minimum, bool):
                minimum = 1 if required else 0
            maximum = stored.get("maxItems")
            bounded = maximum if isinstance(maximum, int) and not isinstance(maximum, bool) \
                and maximum > 0 else None
            if bounded is not None and bounded < minimum:
                raise TransformRefused(
                    f"{name!r} is object-shaped and its bounds contradict each other "
                    f"(maxItems {bounded} below minItems {minimum}); the cardinality needs a decision")
            inner = copy.deepcopy(repaired)
            inner.pop("minItems", None)
            inner.pop("maxItems", None)
            envelope: dict[str, Any] = {"type": "array", "minItems": minimum, "items": inner}
            if bounded is not None:
                envelope["maxItems"] = bounded
            result["properties"][name] = envelope
            changes.append({"path": declared, "replaced": "object", "wrote": "array",
                            "inputType": repaired.get("_ui", {}).get("inputType"),
                            "minItems": minimum, "maxItems": bounded})
        return result

    return walk(copy.deepcopy(artifact), ""), changes


ARRAY_JSON_TYPE = "array"
STRING_JSON_TYPE = "string"


def value_property_json_type(field: Any) -> Any:
    """The JSON type a field gives its ``@value`` property, or None where it gives none.

    Distinct from :func:`declared_value_type` below, which answers the datatype an instance value
    must state in ``@type``.
    """
    properties = field.get("properties") if isinstance(field, dict) else None
    declared = properties.get("@value") if isinstance(properties, dict) else None
    return declared.get("type") if isinstance(declared, dict) else None


def value_type_naming_array(declared: Any) -> bool:
    return declared == ARRAY_JSON_TYPE or (isinstance(declared, list) and ARRAY_JSON_TYPE in declared)


def value_type_without_array(declared: Any) -> Any:
    """The same declaration with the array replaced by the string a single answer is."""
    if declared == ARRAY_JSON_TYPE:
        return STRING_JSON_TYPE
    return [STRING_JSON_TYPE if entry == ARRAY_JSON_TYPE else entry for entry in declared]


def narrow_multi_select_value(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Type one answer of a multi-select as the string it is, not as another array.

    A field that takes several answers is deployed as an array of occurrences, and each occurrence
    holds one of them. Typing the occupant's own ``@value`` as an array as well says each answer is
    itself a list, which the model cannot represent: a literal field's ``@value`` is a string, and
    the several answers are the several occurrences. No editor produces that shape, so every
    populated instance of such a field is invalid against its own template while the template passes
    the meta-schema, which constrains neither side against the other.

    Only a child already deployed as an array and already multiple by nature is touched. A field
    holding an array while deployed as a single object is a different question - whether it should
    become multi-instance - and is left to :func:`wrap_inherently_multiple` and to a decision.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        for name, child, multiple in container_children(container):
            declared = rest.child_path(path, name)
            here = f"{declared}/items" if multiple else declared
            repaired = walk(child, here)
            if multiple and inherently_multiple(repaired):
                stored = value_property_json_type(repaired)
                if value_type_naming_array(stored):
                    narrowed = value_type_without_array(stored)
                    repaired = copy.deepcopy(repaired)
                    repaired["properties"]["@value"]["type"] = narrowed
                    changes.append({"path": f"{here}/properties/@value/type",
                                    "replaced": stored, "wrote": narrowed,
                                    "inputType": (repaired.get(UI_KEY) or {}).get(INPUT_TYPE_KEY)})
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(artifact, ""), changes


def decoded_constraint_iri(stored: Any) -> Optional[str]:
    """The IRI a percent-encoded constraint address means, where decoding once yields one.

    Decoding is the whole derivation, and it is checked rather than trusted: the result has to be
    an absolute IRI and has to re-encode to what was stored, so a value that merely contains a
    percent sign is left alone. Decoded once only - a value needing two passes was encoded twice
    and is a different accident.
    """
    if not isinstance(stored, str) or "%" not in stored or rest.is_absolute_iri(stored):
        return None
    decoded = urllib.parse.unquote(stored)
    if decoded == stored or not rest.is_absolute_iri(decoded):
        return None
    return decoded if urllib.parse.quote(decoded, safe="") == stored else None


def decode_constraint_iri(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write a constraint's address as the IRI it is, not as an escaped copy of one.

    A constraint entry's ``uri`` addresses the ontology, branch, class or value set it names, and a
    terminology lookup resolves it directly. A percent-encoded one resolves to nothing: it reaches
    the server as a literal and matches no term, so the field offers an author no values at all.
    The meta-schema asks for a string with ``format: uri``, which an escaped IRI satisfies as a
    relative reference, so nothing refused it on write.

    Only inside a constraint entry, and only where decoding produces an absolute IRI that
    re-encodes to exactly what was stored. Everything else is left alone: a ``uri`` elsewhere in the
    document is not this repair's business, and a value that decoding does not account for needs a
    reading rather than a rule.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(item, f"{path}/{index}") for index, item in enumerate(node)]
        if not isinstance(node, dict):
            return node
        result = {}
        for name, value in node.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            decoded = decoded_constraint_iri(value) if name == "uri" and in_constraint_entry(path) \
                else None
            if decoded is not None:
                result[name] = decoded
                changes.append({"path": here, "replaced": value, "wrote": decoded})
            else:
                result[name] = walk(value, here)
        return result

    return walk(artifact, ""), changes


def only_decoded_constraint_iri(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is an escaped address becoming the IRI it re-encodes from."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == "uri" and new[name] != old[name]:
                    if not in_constraint_entry(path) or new[name] != decoded_constraint_iri(old[name]):
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


REQUIRED_KEY = "required"
STATIC_FIELD_AT_TYPE = "https://schema.metadatacenter.org/core/StaticTemplateField"
FIELD_AT_TYPES = frozenset({"https://schema.metadatacenter.org/core/TemplateField",
                            STATIC_FIELD_AT_TYPE})
TERM_CONSTRAINT_GROUPS = ("ontologies", "branches", "classes", "valueSets")
# A numeric or temporal field pins its datatype in the instance's `@type`, so both libraries
# demand it alongside the value. Every other literal field demands the value alone.
TYPED_LITERAL_INPUT_TYPES = frozenset({"numeric", "temporal"})


def canonical_required(definition: Any) -> tuple[Optional[list[str]], str]:
    """What both libraries write in a field's ``required``, and the shape that decided it.

    A field carries a value of one of two shapes, and the shape settles most of the question:

    - a literal field declares ``@value``, and both libraries demand it. A numeric or temporal
      field demands ``@type`` with it, because that is where the instance carries its datatype
    - an IRI field - a link, an external identifier, or a term drawn from a vocabulary - declares
      ``@id``, and both libraries emit no ``required`` at all

    The declared properties are what say which of the two, and nothing else does. ``_ui.inputType``
    cannot: a controlled-term field and a plain text field both render as ``textfield``, and only
    their value constraints tell them apart. It is consulted only for the datatype question, where
    ``numeric`` and ``temporal`` are input types of their own.

    A static field carries no value at all - it is a heading, an image, a block of prose - and
    neither library gives one a ``required`` whatever it declares. Production holds static fields
    whose ``properties`` accumulated artifact-level keys, so the shape is taken from the kind here
    rather than read off what such a field happens to declare.
    """
    if not isinstance(definition, dict):
        return None, ""
    at_type = definition.get(AT_TYPE)
    if not isinstance(at_type, str) or at_type not in FIELD_AT_TYPES:
        return None, ""
    if at_type == STATIC_FIELD_AT_TYPE:
        return None, "static"
    properties = definition.get("properties")
    if not isinstance(properties, dict):
        return None, ""
    literal, iri = AT_VALUE in properties, AT_ID in properties
    if literal == iri:  # neither shape, or both: nothing here says which was meant
        return None, ""
    if not literal:
        return None, "IRI"
    ui = definition.get("_ui")
    input_type = ui.get("inputType") if isinstance(ui, dict) else None
    if input_type in TYPED_LITERAL_INPUT_TYPES:
        return [AT_VALUE, AT_TYPE], "typed literal"
    return [AT_VALUE], "literal"


def canonicalise_iri_field_required(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove legacy IRI-field required lists, as the Java model renders them.

    This only relaxes JSON Schema presence requirements. It does not change the field's
    properties, entered values, vocabulary constraints or requiredValue authoring constraint.
    Select targets only after checking their Java-rendered counterparts have the same IRI
    value shape and no required list; a literal/IRI disagreement is a separate repair.
    """
    changes = []
    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        if not isinstance(node, dict):
            return node
        wanted, shape = canonical_required(node)
        result = {}
        for name, value in node.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == REQUIRED_KEY and shape == "IRI" and isinstance(value, list) and value:
                changes.append({"path": here, "replaced": value, "wrote": None})
            else:
                result[name] = walk(value, here)
        return result
    return walk(artifact, ""), changes


def only_canonicalised_iri_field_required(before: Any, after: Any) -> Optional[str]:
    """Every difference must remove a required list from an unambiguous IRI field."""
    for path, old, new in differences(before, after):
        if not path.endswith("/required") or new is not ABSENT or not isinstance(old, list) or not old:
            return path or "/"
        parent = value_at(before, path.rsplit("/", 1)[0])
        if not isinstance(parent, dict):
            return path
        kind = parent.get(AT_TYPE)
        properties = parent.get("properties")
        if not isinstance(kind, str) or kind not in FIELD_AT_TYPES or kind == STATIC_FIELD_AT_TYPE \
                or not isinstance(properties, dict) or AT_ID not in properties or AT_VALUE in properties:
            return path
    return None


def term_constrained(definition: Any) -> bool:
    """Whether the field draws its value from a vocabulary, which only an IRI field can."""
    constraints = definition.get("_valueConstraints") if isinstance(definition, dict) else None
    if not isinstance(constraints, dict):
        return False
    return any(constraints.get(group) for group in TERM_CONSTRAINT_GROUPS)


def noncanonical_context_demands(container: Any) -> set[str]:
    """Only orphan child names and attribute-group names; preserve namespace requirements."""
    if not isinstance(container, dict):
        return set()
    children = {name: child for name, child, _ in container_children(container)}
    required = container.get('properties', {}).get('@context', {}).get('required', [])
    namespaces = {'xsd', 'rdfs', 'pav', 'schema', 'oslc', 'skos', 'bibo'}
    return {name for name in required if isinstance(name, str) and not name.startswith('@')
            and ':' not in name and name not in namespaces
            and (name not in children or children[name].get('_ui', {}).get('inputType') == 'attribute-value')}


def drop_noncanonical_context_demands(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Relax context requirements for absent children and attribute-value groups.

    Apply only to targets compared with the Java-rendered schema. Keep all mappings and
    instance values; only the obligation to repeat these mappings is removed.
    """
    changes = []
    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(value, f'{path}/{index}') for index, value in enumerate(node)]
        if not isinstance(node, dict):
            return node
        result = {key: walk(value, f'{path}/{rest.json_pointer_component(key)}') for key, value in node.items()}
        kind = node.get('@type')
        if isinstance(kind, str) and kind in {'https://schema.metadatacenter.org/core/Template', rest.TEMPLATE_ELEMENT}:
            removed = noncanonical_context_demands(node)
            if removed:
                old = node['properties']['@context']['required']
                new = [name for name in old if name not in removed]
                result['properties']['@context']['required'] = new
                changes.append({'path': path + '/properties/@context/required', 'replaced': old, 'wrote': new})
        return result
    return walk(artifact, ''), changes


def only_dropped_noncanonical_context_demands(before: Any, after: Any) -> Optional[str]:
    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or '/'
            for key in old:
                here = f'{path}/{rest.json_pointer_component(key)}'
                if here.endswith('/properties/@context/required'):
                    parent_path = here[:-len('/properties/@context/required')]
                    parent = before if not parent_path else value_at(before, parent_path)
                    kind = parent.get('@type') if isinstance(parent, dict) else None
                    removable = noncanonical_context_demands(parent) if isinstance(kind, str) and kind in {'https://schema.metadatacenter.org/core/Template', rest.TEMPLATE_ELEMENT} else set()
                    if not isinstance(old[key], list) or new[key] != [name for name in old[key] if name not in removable]:
                        return here
                else:
                    fault = walk(old[key], new[key], here)
                    if fault is not None:return fault
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):return path
            for index, value in enumerate(old):
                fault = walk(value, new[index], f'{path}/{index}')
                if fault is not None:return fault
            return None
        return None if json_equal(old, new) else path or '/'
    return walk(before, after, '')


def unfillable(demanded: Any, properties: Any) -> bool:
    """Whether a ``required`` names a property the field does not declare.

    This is the defect, and the whole of it. A field whose demands are all declared is satisfiable,
    whatever else it differs from the libraries in, and is none of this repair's business: writing
    the canonical list there could *add* a demand - a temporal field storing ``["@value"]`` where
    the libraries write ``["@value", "@type"]`` - and invalidate instances that validate today.
    """
    if not isinstance(demanded, list) or not isinstance(properties, dict):
        return False
    return any(key not in properties for key in demanded)


def canonicalise_field_required(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give a field the ``required`` its declared shape calls for.

    Production holds fields demanding a property they do not declare: an IRI field demanding
    ``@value``, and a literal field demanding ``@id``. No instance of either can validate. The
    demanded property is one the field gives an author no way to fill, and the field also sets
    ``additionalProperties: false``, so the value an author does supply is refused in turn. The
    field is unfillable in both directions rather than merely strict.

    Only a field demanding something it does not declare is touched, and it then takes the list the
    libraries write for its shape. That drops a demand on ``rdfs:label`` where one was made, since
    neither library emits it and it rides along with the impossible one. Every such case relaxes:
    nothing that validates today stops doing so, because nothing carrying that field validates
    today, and instances that could not validate at all may now.

    A field whose demands it does declare is left exactly as it stands, even where the libraries
    would write something else. Writing the canonical list there could add a demand rather than
    remove one, and that is a different change with a different risk.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(item, f"{path}/{index}") for index, item in enumerate(node)]
        if not isinstance(node, dict):
            return node
        wanted, shape = canonical_required(node)
        stored = node.get(REQUIRED_KEY)
        settled = (shape and isinstance(stored, list) and stored != wanted
                   and unfillable(stored, node.get("properties")))
        result = {}
        if settled and wanted is not None and REQUIRED_KEY not in node:
            raise TransformRefused(f"{path}: cannot place `required` in a field that has none")
        for name, value in node.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == REQUIRED_KEY and settled:
                changes.append({"path": here, "replaced": list(value), "wrote": wanted,
                                "shape": shape, "termConstrained": term_constrained(node)})
                if wanted is not None:
                    result[name] = list(wanted)
                continue
            result[name] = walk(value, here)
        return result

    return walk(artifact, ""), changes


def only_canonicalised_field_required(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is a field's ``required`` taking the value its shape calls for."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            if set(new) - set(old):
                return path or "/"
            wanted, shape = canonical_required(old)
            # The transform only ever touches a `required` naming something the field does not
            # declare, so the invariant holds a change to any other one to be someone else's.
            settled = shape and unfillable(old.get(REQUIRED_KEY), old.get("properties"))
            gone = set(old) - set(new)
            if gone and not (gone == {REQUIRED_KEY} and settled and wanted is None):
                return f"{path}/{rest.json_pointer_component(sorted(gone)[0])}"
            for name in new:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == REQUIRED_KEY and new[name] != old[name]:
                    if not settled or new[name] != wanted:
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


JSON_LD_ID = "@id"
EMPTY_IRI_ERROR = r"^(?:\[read\] )?An empty string is not a URI"


def drop_empty_instance_iri(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Take an empty ``@id`` out of a field that holds no IRI.

    An IRI-valued field - a link, an ORCID, a controlled term - says what it holds with ``@id``. A
    field nobody filled in holds no IRI, and the way to say that is to leave the key out: the
    occurrence is then an ordinary node with nothing in it. An empty string is not a way to say it.
    It is not an IRI, JSON-LD gives it no meaning, and ``cedar-artifact-library`` refuses to read
    one, so an instance carrying it has no YAML representation and answers 500 when asked for one.

    Nothing rejected it on write. The field's rendered schema types ``@id`` as a string with
    ``format: uri``, and an empty string satisfies that, so the validator holds these instances
    valid while the library will not read them. That gap is why the repair is worth making and why
    tightening the schema is a separate question: it would touch every stored template.

    ``null`` would also be read, and the library's own message offers it, but a node object's
    ``@id`` is defined to be a string and null is not one. Removal says the same thing in the shape
    an unfilled IRI field already has.

    The instance's own ``@id`` is left alone. An artifact whose identity is an empty string is a
    different defect and not one to settle by deleting its identity.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    stored_root = artifact.get(JSON_LD_ID)
    if isinstance(stored_root, str) and stored_root.strip() == "":
        raise TransformRefused("the instance's own @id is empty, which is a different defect")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(item, f"{path}/{index}") for index, item in enumerate(node)]
        if not isinstance(node, dict):
            return node
        stored = node.get(JSON_LD_ID)
        empty = path != "" and isinstance(stored, str) and stored.strip() == ""
        result = {}
        for name, value in node.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == JSON_LD_ID and empty:
                changes.append({"path": here, "replaced": stored, "wrote": None})
                continue
            result[name] = walk(value, here)
        return result

    return walk(artifact, ""), changes


def only_dropped_empty_instance_iri(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only keys gone are empty ``@id``s below the root."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            if set(new) - set(old):
                return path or "/"
            gone = set(old) - set(new)
            unexpected = sorted(gone - {JSON_LD_ID})
            if unexpected:
                return f"{path}/{rest.json_pointer_component(unexpected[0])}"
            if gone:
                stored = old[JSON_LD_ID]
                if path == "" or not isinstance(stored, str) or stored.strip() != "":
                    return f"{path}/{JSON_LD_ID}"
            for name in new:
                difference = walk(old[name], new[name], f"{path}/{rest.json_pointer_component(name)}")
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


TITLE_KEY = "title"
SCHEMA_NAME_KEY = "schema:name"
ARTIFACT_NOUN = {
    "https://schema.metadatacenter.org/core/Template": "template",
    "https://schema.metadatacenter.org/core/TemplateElement": "element",
    "https://schema.metadatacenter.org/core/TemplateField": "field",
    "https://schema.metadatacenter.org/core/StaticTemplateField": "field",
}


def composed_title(definition: Any) -> Optional[str]:
    """The title a definition of this name and kind has, or None where it does not have one."""
    if not isinstance(definition, dict):
        return None
    # `@type` is a string on an artifact and a JSON Schema fragment inside `properties`, so ask
    # only where it is the former.
    at_type = definition.get(AT_TYPE)
    noun = ARTIFACT_NOUN.get(at_type) if isinstance(at_type, str) else None
    name = definition.get(SCHEMA_NAME_KEY)
    if noun is None or not isinstance(name, str) or not name:
        return None
    return f"{name} {noun} schema"


def compose_artifact_title(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write the title an artifact's name and kind compose, where it holds another.

    ``title`` names the JSON Schema constraining instances of an artifact, and it restates the
    artifact's own name: an artifact called Study has a template schema called "Study template
    schema" and there is nothing else it could be called. It carries nothing an author decided, so
    a stored one that differs is not an alternative anybody chose.

    An older editor composed it from a lowercased name, so the stored title disagrees with the name
    beside it in case alone - "Template with Text Field 1" against "Template with text field 1
    template schema". Both model libraries derive the title on read, so such an artifact is
    rewritten the moment anything reads and writes it; composing it here means the stored document
    says what every reader of it already says.

    Every nested definition carries its own, so the walk covers them with the root.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(item, f"{path}/{index}") for index, item in enumerate(node)]
        if not isinstance(node, dict):
            return node
        result = {}
        wanted = composed_title(node)
        for name, value in node.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == TITLE_KEY and wanted is not None and isinstance(value, str) and value != wanted:
                result[name] = wanted
                changes.append({"path": here, "replaced": value, "wrote": wanted})
            else:
                result[name] = walk(value, here)
        return result

    return walk(artifact, ""), changes


def only_composed_artifact_title(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is a title becoming the one its own name and kind compose."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == TITLE_KEY and new[name] != old[name]:
                    if new[name] != composed_title(old):
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


ACRONYM_KEY = "acronym"
# The three keys that together address a constraint's vocabulary. A paste into the acronym lands in
# all of them, so a repair reaching only one leaves an address still pointing at a browse page.
SOURCE_KEYS = ("acronym", "name", "uri")
# Confirmed addresses, {storedValue: {acronym, name, uri}}, from `acronym_sheet.py`. Empty unless
# --acronyms names a file, and a value absent from it is reported rather than guessed at.
ACRONYMS: dict[str, dict[str, str]] = {}
CONSTRAINT_GROUPS = ("ontologies", "valueSets", "classes", "branches")


def in_constraint_entry(path: str) -> bool:
    return any(f"/{group}/" in f"{path}/" for group in CONSTRAINT_GROUPS)


def resolve_constraint_source(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write the address a constraint's vocabulary is reached by, where one was confirmed.

    An `acronym`, a `name` and a `uri` together say which vocabulary serves a constraint's terms.
    Production holds a pasted BioPortal browse URL in all three of an entry, which addresses
    nothing: the acronym carries a query string, the uri points at a page rather than an ontology,
    and the name repeats the paste. The meta-schema asks only for strings, so nothing refused it.

    Nothing is derived here. `acronym_sheet.py` proposes an address for each stored value and checks
    every part against BioPortal, and only what an owner confirmed reaches this transform, keyed by
    the value the entry holds. A key holding something other than that value is left alone, so a
    good name beside a bad acronym survives; a value the sheet does not carry is reported. An
    acronym that addresses the wrong vocabulary is worse than one that addresses none, because a
    lookup then succeeds against the wrong terms and nothing says so.

    The entry's kind is not touched. Whether an entry that names a whole ontology was meant to name
    one class within it is a question about intent, which no lookup answers.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    if not ACRONYMS:
        raise TransformRefused("no confirmed addresses supplied; pass --acronyms")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(item, f"{path}/{index}") for index, item in enumerate(node)]
        if not isinstance(node, dict):
            return node
        stored = node.get(ACRONYM_KEY)
        confirmed = ACRONYMS.get(stored) if isinstance(stored, str) else None
        if confirmed is None or not in_constraint_entry(path):
            return {name: walk(value, f"{path}/{rest.json_pointer_component(name)}")
                    for name, value in node.items()}
        # Only a value the sheet saw and named is overwritten. The acronym and the uri hold
        # different spellings of the same paste - the uri keeps the browse prefix - so the sheet
        # records each exactly rather than the transform matching a shape.
        replaceable = set(confirmed.get("replaces") or [stored])
        result = {}
        for name, value in node.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name in SOURCE_KEYS and value in replaceable and name in confirmed:
                result[name] = confirmed[name]
                changes.append({"path": here, "replaced": value, "wrote": confirmed[name]})
            else:
                result[name] = walk(value, here)
        return result

    return walk(artifact, ""), changes


def only_resolved_constraint_source(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is a key that held the corrupted value taking its confirmed one."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            stored = old.get(ACRONYM_KEY)
            confirmed = ACRONYMS.get(stored) if isinstance(stored, str) else None
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if new[name] != old[name] and name in SOURCE_KEYS:
                    replaceable = set(confirmed.get("replaces") or [stored]) if confirmed else set()
                    if (confirmed is None or not in_constraint_entry(path)
                            or old[name] not in replaceable
                            or new[name] != confirmed.get(name)):
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


# Confirmed narrowings, {artifactId: {entryPath: branchEntry}}, from a planner. Empty unless
# --branches names a file; the path identifies one entry, because a template holds several and only
# the named one is meant to move.
BRANCHES: dict[str, dict[str, dict[str, Any]]] = {}
BRANCH_REQUIRED = ("source", "acronym", "name", "uri", "maxDepth")


def node_at(artifact: Any, path: str) -> Any:
    node = artifact
    for step in [p for p in path.split("/") if p]:
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
    return node


def narrow_ontology_constraint_to_branch(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Constrain a field to the branch its author meant, not to every term the ontology serves.

    An `ontologies` entry admits any term in a vocabulary; a `branches` entry admits one subtree.
    Where a field was meant to offer a single branch and ended up naming the whole ontology, every
    instance of it may say more than the template intended, and nothing reports that because both
    shapes are valid.

    Which entry moves, and to which branch, is named per artifact and per path rather than derived:
    a template holds several `ontologies` entries and only the named one is meant to move. The
    branch entry is supplied whole and written as given, so what an owner confirmed is what is
    stored, and it must carry every key the meta-schema requires of a branch.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    planned = BRANCHES.get(artifact.get("@id"))
    if not planned:
        return artifact, []
    result = copy.deepcopy(artifact)
    changes: list[dict[str, Any]] = []
    for path, branch in planned.items():
        missing = [k for k in BRANCH_REQUIRED if k not in branch]
        if missing:
            raise TransformRefused(f"the branch named for {path} states no {', '.join(missing)}")
        constraints_path, _, index = path.rpartition("/ontologies/")
        if not constraints_path or not index.isdigit():
            raise TransformRefused(f"{path} does not name an ontologies entry")
        constraints = node_at(result, constraints_path)
        if not isinstance(constraints, dict) or not isinstance(constraints.get("ontologies"), list):
            raise TransformRefused(f"no ontologies list at {constraints_path}")
        if int(index) >= len(constraints["ontologies"]):
            raise TransformRefused(f"no entry {index} at {constraints_path}/ontologies")
        removed = constraints["ontologies"].pop(int(index))
        constraints.setdefault("branches", []).append(dict(branch))
        changes.append({"path": path, "replaced": removed, "wrote": dict(branch)})
    return result, changes


def only_narrowed_ontology_constraint(before: Any, after: Any) -> Optional[str]:
    """The invariant: each named entry left `ontologies` and exactly its confirmed branch arrived.

    Re-applied to the stored body rather than compared loosely, so a run that moved a different
    entry, or wrote a branch nobody confirmed, differs from this and is caught.
    """
    try:
        expected, _ = narrow_ontology_constraint_to_branch(before)
    except TransformRefused as refusal:
        return f"/ ({refusal})"
    return None if expected == after else "/"


PREVIOUS_VERSION_KEY = "pav:previousVersion"


def drop_unusable_previous_version(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Stop an artifact naming a predecessor by something that is not one.

    ``pav:previousVersion`` points at the artifact this one succeeds, so its value is that
    artifact's IRI. Production holds version strings there - one of them the artifact's own version,
    which would have it succeed itself. Neither addresses an artifact, and the meta-schema asks only
    for a string, so nothing refused them on write.

    Removal, because nothing says what was meant. A version string names no artifact, and where the
    artifact carries no ``pav:derivedFrom`` either there is no predecessor to recover; a first
    version has none to name in the first place. No meta-schema requires the key, so an artifact
    without it is saying the truth rather than losing a fact. A value that is an absolute IRI is
    left alone whether or not it resolves, because that is a different question and a different
    repair.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    stored = artifact.get(PREVIOUS_VERSION_KEY)
    if not isinstance(stored, str) or rest.is_absolute_iri(stored):
        return artifact, []
    result = {k: v for k, v in artifact.items() if k != PREVIOUS_VERSION_KEY}
    return result, [{"path": f"/{rest.json_pointer_component(PREVIOUS_VERSION_KEY)}",
                     "replaced": stored, "wrote": None}]


def only_dropped_unusable_previous_version(before: Any, after: Any) -> Optional[str]:
    """The invariant: the one key that left held a value that was not an absolute IRI."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return "/"
    gone = set(before) - set(after)
    if set(after) - set(before):
        return "/"
    # Name the removal that is not allowed, rather than whichever sorts first, so the report says
    # what is wrong with the candidate.
    unexpected = sorted(gone - {PREVIOUS_VERSION_KEY})
    if unexpected:
        return f"/{rest.json_pointer_component(unexpected[0])}"
    if gone:
        stored = before[PREVIOUS_VERSION_KEY]
        if not isinstance(stored, str) or rest.is_absolute_iri(stored):
            return f"/{PREVIOUS_VERSION_KEY}"
    for key in after:
        if after[key] != before[key]:
            return f"/{rest.json_pointer_component(key)}"
    return None


UNIT_OF_MEASURE_KEY = "unitOfMeasure"


def blank_unit(constraints: Any) -> bool:
    """Whether this ``_valueConstraints`` states a unit that states nothing."""
    if not isinstance(constraints, dict) or UNIT_OF_MEASURE_KEY not in constraints:
        return False
    stored = constraints[UNIT_OF_MEASURE_KEY]
    return isinstance(stored, str) and stored.strip() == ""


def drop_blank_unit_of_measure(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Stop a field stating a unit of measure that names no unit.

    ``unitOfMeasure`` says what a number is measured in. An empty string names nothing, so it says
    exactly what leaving the key out says, and the two are not worth distinguishing: a reader
    showing the unit beside the value has nothing to show either way. The meta-schema asks only for
    a string, so nothing refused it on write.

    Removal rather than repair, because there is no unit to recover. A field whose unit is a string
    with anything in it is left alone, whitespace included after trimming - inventing a unit for a
    number would put in the document something nobody measured.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, list):
            return [walk(item, f"{path}/{index}") for index, item in enumerate(node)]
        if not isinstance(node, dict):
            return node
        result = {}
        for name, value in node.items():
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == VALUE_CONSTRAINTS_KEY and blank_unit(value):
                trimmed = {k: v for k, v in value.items() if k != UNIT_OF_MEASURE_KEY}
                changes.append({"path": f"{here}/{UNIT_OF_MEASURE_KEY}",
                                "replaced": value[UNIT_OF_MEASURE_KEY], "wrote": None})
                result[name] = walk(trimmed, here)
            else:
                result[name] = walk(value, here)
        return result

    return walk(artifact, ""), changes


def only_dropped_blank_unit_of_measure(before: Any, after: Any) -> Optional[str]:
    """The invariant: every difference is a blank unit leaving, and nothing else moves."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            gone = set(old) - set(new)
            if set(new) - set(old):
                return path or "/"
            if gone and not (gone == {UNIT_OF_MEASURE_KEY} and path.endswith("/" + VALUE_CONSTRAINTS_KEY)
                             and isinstance(old[UNIT_OF_MEASURE_KEY], str)
                             and old[UNIT_OF_MEASURE_KEY].strip() == ""):
                return f"{path}/{sorted(gone)[0]}"
            for name in new:
                difference = walk(old[name], new[name], f"{path}/{rest.json_pointer_component(name)}")
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def only_narrowed_multi_select_value(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is one multi-select answer's type, re-derived rather than trusted.

    The narrowed declaration is recomputed from the stored one, so a transform that wrote some other
    type, or touched a field that is not multiple by nature, is caught here rather than written.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name == "type" and path.endswith("/properties/@value")
                        and new[name] != old[name]):
                    if not value_type_naming_array(old[name]) \
                            or new[name] != value_type_without_array(old[name]):
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def only_wrapped_inherently_multiple(before: Any, after: Any) -> Optional[str]:
    """The invariant: a child became an array envelope around exactly its former self.

    The inner definition must be the stored one with its cardinality keys lifted out, and nothing
    else in the document may differ.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            for name in set(old) | set(new):
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name in old) != (name in new):
                    return here
                wrapped = isinstance(old[name], dict) and isinstance(new[name], dict) \
                    and old[name].get("type") != "array" and new[name].get("type") == "array"
                if wrapped:
                    difference = envelope_difference(old[name], new[name], here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def envelope_difference(stored: dict, envelope: dict, path: str) -> Optional[str]:
        if set(envelope) - {"type", "minItems", "maxItems", "items"}:
            return path
        inner = envelope.get("items")
        expected = {k: v for k, v in stored.items() if k not in ("minItems", "maxItems")}
        if inner != expected:
            return f"{path}/items"
        if not isinstance(envelope.get("minItems"), int):
            return f"{path}/minItems"
        if "maxItems" in envelope and not isinstance(envelope["maxItems"], int):
            return f"{path}/maxItems"
        return None

    return walk(before, after, "")


def stamp_model_version(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write the current model version on every definition that already conforms to it.

    ``schema:schemaVersion`` asserts that the definition carrying it conforms to the model it names, so
    stamping one onto a definition that does not replaces a detectable defect with an undetectable one.
    This writes only over a version that parses; the tool validates every body before it is written,
    which is what makes the assertion true rather than hopeful.

    A template states a version on each nested field and element as well as at its root, and the two
    drift apart, so the walk covers both. A version that is absent or does not parse is left where it
    stands: inferring which model a definition was authored against is a different decision from moving
    one that is merely behind, and the inventory goes on reporting the ones left alone. Refusing the
    artifact outright is reserved for the case where that is all there is to do, which keeps a refusal
    visible in the record instead of reporting an artifact nothing touched as though it were clean.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []
    unsettled: list[tuple[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        here = f"{path}/{rest.json_pointer_component(MODEL_VERSION_KEY)}"
        stored = definition.get(MODEL_VERSION_KEY)
        if stored != audit.MODEL_VERSION:
            if isinstance(stored, str) and audit.VERSION_PATTERN.match(stored):
                result[MODEL_VERSION_KEY] = audit.MODEL_VERSION
                changes.append({"path": here, "replaced": stored, "wrote": audit.MODEL_VERSION})
            else:
                unsettled.append((here, stored))
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    stamped = walk(copy.deepcopy(artifact), "")
    if not changes and unsettled:
        path, stored = unsettled[0]
        raise TransformRefused(
            f"{path} is {stored!r}, which does not parse as a version; an absent or malformed version "
            "is a different decision from a stale one")
    return stamped, changes


def only_stamped_model_version(before: Any, after: Any) -> Optional[str]:
    """The invariant: model versions moved to the current one or stood still, and nothing else moved."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == MODEL_VERSION_KEY:
                    if new[name] == old[name]:
                        continue
                    moved_to_current = new[name] == audit.MODEL_VERSION
                    came_from_a_version = isinstance(old[name], str) \
                        and bool(audit.VERSION_PATTERN.match(old[name]))
                    if not (moved_to_current and came_from_a_version):
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


DRAFT_STATUS = "bibo:draft"
STATUS_KEY = "bibo:status"


# What `cedar-artifact-library` assigns a freshly created artifact: Version.DEFAULT.
DEFAULT_ARTIFACT_VERSION = "0.0.1"


def unreadable_version(value: Any) -> bool:
    """Whether a stated version says nothing any rule can turn into a version.

    Not merely unparseable: a short numeric value is completed by padding and a prerelease tag is
    dropped by settling, each of which derives its answer from what is written. This is what is
    left — a string that carries no version at all.
    """
    return (isinstance(value, str) and not audit.VERSION_PATTERN.match(value)
            and rest.padded_version(value) is None and rest.release_version(value) is None)


VALUE_CONSTRAINTS_KEY = "_valueConstraints"
CLASSES_KEY = "classes"


LITERALS_KEY = "literals"


UI_KEY = "_ui"
INPUT_TYPE_KEY = "inputType"
LIST_INPUT_TYPE = "list"
MULTIPLE_CHOICE_KEY = "multipleChoice"


# Where an artifact says nothing about its own making, what it says about its last change is the
# only evidence left. Each derivation is recorded in the change so the substitution stays visible.
DERIVED_PROVENANCE = ((rest.CREATED_ON, rest.UPDATED_ON), (rest.CREATED_BY, rest.MODIFIED_BY))


def derive_absent_provenance(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Fill a null creation date or author from what the artifact records about its last change.

    The meta-schema requires both keys and lets both be null, so an artifact that says nothing
    about who made it or when is valid, and five standalone fields in production say exactly that
    while naming who last touched them.

    The date is a lower bound: an artifact created earlier than it records is understated, not
    misdescribed. The author is an inference and the weaker of the two — it asserts that the last
    person to touch the artifact is the one who made it, which is likely for a draft written once
    and never edited, and wrong if someone else edited it since. Both derivations are named in the
    change record rather than presented as recovered fact.

    A value already present is never overwritten, and a null with no counterpart to derive from is
    left alone: there is nothing to say.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {name: walk(value, f"{path}/{rest.json_pointer_component(name)}")
                      for name, value in node.items()}
            for absent, source in DERIVED_PROVENANCE:
                if absent not in result or result[absent] is not None:
                    continue
                derived = result.get(source)
                if not isinstance(derived, str) or not derived:
                    continue
                result[absent] = derived
                changes.append({"path": f"{path}/{rest.json_pointer_component(absent)}",
                                "replaced": None, "wrote": derived, "derivedFrom": source})
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    repaired = walk(copy.deepcopy(artifact), "")
    if artifact.get(STATUS_KEY) != DRAFT_STATUS:
        raise TransformRefused(
            f"provenance is only derived on a draft; this artifact is {artifact.get(STATUS_KEY)!r}")
    return repaired, changes


def only_derived_absent_provenance(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only changes are null provenance taking the value it was derived from."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            derived = dict(DERIVED_PROVENANCE)
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name in derived and new[name] != old[name]:
                    if old[name] is not None or new[name] != old.get(derived[name]):
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


CONTROLLED_TERM_INPUT_TYPE = "controlled-term"
TEXTFIELD_INPUT_TYPE = "textfield"
DEFAULT_VALUE_KEY = "defaultValue"


def name_a_controlled_term_field_as_it_is_modelled(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write ``controlled-term`` as the input type the model actually has.

    CEDAR has no ``controlled-term`` input type. A controlled term is a text field carrying term
    constraints — classes, branches, value sets or ontologies — so a field naming that type is
    describing itself with a word the model never defined, and no reader can take it: the artifact
    has no YAML representation at all.

    Only a field that carries at least one term constraint is renamed, because that is what makes
    ``textfield`` the same field said properly rather than a different field. One carrying none
    would become a plain text box, which is a change to what it collects and an author's to make.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []
    refusals: list[str] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {name: walk(value, f"{path}/{rest.json_pointer_component(name)}")
                      for name, value in node.items()}
            ui = result.get(UI_KEY)
            if isinstance(ui, dict) and ui.get(INPUT_TYPE_KEY) == CONTROLLED_TERM_INPUT_TYPE:
                here = f"{path}/{rest.json_pointer_component(UI_KEY)}/{INPUT_TYPE_KEY}"
                constraints = result.get(VALUE_CONSTRAINTS_KEY)
                constraints = constraints if isinstance(constraints, dict) else {}
                terms = sum(len(constraints.get(k) or []) for k in rest.TERM_CONSTRAINT_KEYS)
                if not terms:
                    refusals.append(f"{here} names no term source, so a text field would collect "
                                    "something different")
                else:
                    result[UI_KEY] = {**ui, INPUT_TYPE_KEY: TEXTFIELD_INPUT_TYPE}
                    changes.append({"path": here, "replaced": CONTROLLED_TERM_INPUT_TYPE,
                                    "wrote": TEXTFIELD_INPUT_TYPE})
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    repaired = walk(copy.deepcopy(artifact), "")
    if artifact.get(STATUS_KEY) != DRAFT_STATUS:
        raise TransformRefused(
            f"an input type is only rewritten on a draft; this artifact is {artifact.get(STATUS_KEY)!r}")
    if refusals:
        raise TransformRefused(refusals[0] + (f" ({len(refusals)} in all)" if len(refusals) > 1 else ""))
    return repaired, changes


def only_named_controlled_term_fields(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only change is controlled-term becoming textfield, where terms are named."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            oldUi, newUi = old.get(UI_KEY), new.get(UI_KEY)
            if (isinstance(oldUi, dict) and isinstance(newUi, dict)
                    and oldUi.get(INPUT_TYPE_KEY) != newUi.get(INPUT_TYPE_KEY)):
                here = f"{path}/{rest.json_pointer_component(UI_KEY)}/{INPUT_TYPE_KEY}"
                constraints = old.get(VALUE_CONSTRAINTS_KEY)
                constraints = constraints if isinstance(constraints, dict) else {}
                if (oldUi.get(INPUT_TYPE_KEY) != CONTROLLED_TERM_INPUT_TYPE
                        or newUi.get(INPUT_TYPE_KEY) != TEXTFIELD_INPUT_TYPE
                        or not sum(len(constraints.get(k) or []) for k in rest.TERM_CONSTRAINT_KEYS)):
                    return here
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == UI_KEY and isinstance(oldUi, dict) and isinstance(newUi, dict):
                    if set(oldUi) != set(newUi):
                        return here
                    for key in oldUi:
                        if key == INPUT_TYPE_KEY:
                            continue
                        difference = walk(oldUi[key], newUi[key],
                                          f"{here}/{rest.json_pointer_component(key)}")
                        if difference is not None:
                            return difference
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def drop_unresolvable_default(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove a default that points at a term the field offers no way to reach.

    A controlled-term default is ``{termUri, rdfs:label}``. On a field with no ontology, value set,
    class or branch, nothing can resolve it, and the library refuses to read the artifact at all
    because the field's kind and its default's kind disagree.

    The default goes rather than being rewritten as text: the author chose a term, and a label is
    what that term is called rather than the value they meant to store. A field that does name a
    term source is left alone, since there the default may well be legitimate.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {name: walk(value, f"{path}/{rest.json_pointer_component(name)}")
                      for name, value in node.items()}
            constraints = result.get(VALUE_CONSTRAINTS_KEY)
            if isinstance(constraints, dict):
                default = constraints.get(DEFAULT_VALUE_KEY)
                terms = sum(len(constraints.get(k) or []) for k in rest.TERM_CONSTRAINT_KEYS)
                if (isinstance(default, dict) and not terms
                        and rest.CONTROLLED_TERM_DEFAULT_KEYS <= set(default)):
                    without = {k: v for k, v in constraints.items() if k != DEFAULT_VALUE_KEY}
                    result[VALUE_CONSTRAINTS_KEY] = without
                    changes.append({
                        "path": f"{path}/{rest.json_pointer_component(VALUE_CONSTRAINTS_KEY)}"
                                f"/{DEFAULT_VALUE_KEY}",
                        "replaced": default.get("rdfs:label"), "wrote": None})
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    repaired = walk(copy.deepcopy(artifact), "")
    if artifact.get(STATUS_KEY) != DRAFT_STATUS:
        raise TransformRefused(
            f"a default is only dropped on a draft; this artifact is {artifact.get(STATUS_KEY)!r}")
    return repaired, changes


def only_dropped_unresolvable_defaults(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only change is an unreachable term default being removed."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            removed = set(old) - set(new)
            if set(new) - set(old):
                return path or "/"
            if removed:
                if removed != {DEFAULT_VALUE_KEY}:
                    return path or "/"
                default = old.get(DEFAULT_VALUE_KEY)
                terms = sum(len(old.get(k) or []) for k in rest.TERM_CONSTRAINT_KEYS)
                if (not isinstance(default, dict) or terms
                        or not rest.CONTROLLED_TERM_DEFAULT_KEYS <= set(default)):
                    return f"{path}/{DEFAULT_VALUE_KEY}"
            for name in old:
                if name in removed:
                    continue
                difference = walk(old[name], new[name], f"{path}/{rest.json_pointer_component(name)}")
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


TEMPORAL_INPUT_TYPE = "temporal"
GRANULARITY_KEY = "temporalGranularity"
TEMPORAL_TYPE_KEY = "temporalType"
# What the Template Editor's own settings panel writes for a plain date, and what 23 of the 26
# configured temporal fields in production carry.
DEFAULT_GRANULARITY = "day"
DEFAULT_TEMPORAL_TYPE = "xsd:date"


def state_temporal_precision(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Say what precision a temporal field is read at, where it says nothing.

    A date with no ``temporalGranularity`` and no ``temporalType`` cannot be read by
    ``cedar-artifact-library`` at all, so the artifact has no YAML representation. The editor wrote
    the pair only when an author opened the field's settings, and the meta-schema never asked for
    it, so a date added and saved reached the store without one.

    Day precision on an ``xsd:date`` is what the editor itself picks for a plain date, so this
    states what the field would have carried had its settings been opened. A field that already
    states either half is left alone: a partial statement is an author's, and completing it would
    mean deciding which half is right.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {}
            for name, value in node.items():
                result[name] = walk(value, f"{path}/{rest.json_pointer_component(name)}")
            ui = result.get(UI_KEY)
            if isinstance(ui, dict) and ui.get(INPUT_TYPE_KEY) == TEMPORAL_INPUT_TYPE:
                constraints = result.get(VALUE_CONSTRAINTS_KEY)
                constraints = constraints if isinstance(constraints, dict) else None
                states_granularity = isinstance(ui.get(GRANULARITY_KEY), str)
                states_type = isinstance((constraints or {}).get(TEMPORAL_TYPE_KEY), str)
                if constraints is not None and not states_granularity and not states_type:
                    result[UI_KEY] = {**ui, GRANULARITY_KEY: DEFAULT_GRANULARITY}
                    result[VALUE_CONSTRAINTS_KEY] = {**constraints,
                                                     TEMPORAL_TYPE_KEY: DEFAULT_TEMPORAL_TYPE}
                    changes.append({"path": f"{path}/{rest.json_pointer_component(UI_KEY)}/{GRANULARITY_KEY}",
                                    "replaced": None, "wrote": DEFAULT_GRANULARITY})
                    changes.append({"path": f"{path}/{rest.json_pointer_component(VALUE_CONSTRAINTS_KEY)}"
                                            f"/{TEMPORAL_TYPE_KEY}",
                                    "replaced": None, "wrote": DEFAULT_TEMPORAL_TYPE})
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    repaired = walk(copy.deepcopy(artifact), "")
    if artifact.get(STATUS_KEY) != DRAFT_STATUS:
        raise TransformRefused(
            f"a field's precision is only stated on a draft; this artifact is "
            f"{artifact.get(STATUS_KEY)!r}")
    return repaired, changes


def only_stated_temporal_precision(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only changes are the two keys a temporal field was missing."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            added = set(new) - set(old)
            if set(old) - set(new) or added:
                # Only the two keys may appear, and only inside the nodes that hold them.
                if added - {GRANULARITY_KEY, TEMPORAL_TYPE_KEY} or set(old) - set(new):
                    return path or "/"
                if GRANULARITY_KEY in added and (
                        old.get(INPUT_TYPE_KEY) != TEMPORAL_INPUT_TYPE
                        or new[GRANULARITY_KEY] != DEFAULT_GRANULARITY):
                    return f"{path}/{GRANULARITY_KEY}"
                if TEMPORAL_TYPE_KEY in added and new[TEMPORAL_TYPE_KEY] != DEFAULT_TEMPORAL_TYPE:
                    return f"{path}/{TEMPORAL_TYPE_KEY}"
            for name in old:
                difference = walk(old[name], new[name], f"{path}/{rest.json_pointer_component(name)}")
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def present_choices_as_a_list(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Make a field that lists permitted values the kind of field that offers them.

    ``_valueConstraints.literals`` is a closed set of choices. Only a radio, checkbox or list field
    presents one, so a text field carrying it describes a control it is not: the options are stored,
    and whether a reader sees them depends on which library reads the artifact. A single-select list
    is what the field already says it is in every other respect — a closed set, ``multipleChoice``
    already stated, the requirement already stated — so only the input type moves.

    Deliberately narrow. Radio is not offered, because choosing between a dropdown and a row of
    buttons is a presentation decision about how many options a reader can stand to see, and that is
    the author's rather than a repair's. A field whose ``multipleChoice`` is absent is refused for
    the same reason: the list would have to guess whether one answer is allowed or several.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []
    refusals: list[str] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {}
            for name, value in node.items():
                result[name] = walk(value, f"{path}/{rest.json_pointer_component(name)}")
            ui = result.get(UI_KEY)
            constraints = result.get(VALUE_CONSTRAINTS_KEY)
            if isinstance(ui, dict) and isinstance(constraints, dict):
                literals = constraints.get(LITERALS_KEY)
                stated = ui.get(INPUT_TYPE_KEY)
                if (isinstance(literals, list) and literals
                        and stated not in rest.CHOICE_INPUT_TYPES):
                    here = f"{path}/{rest.json_pointer_component(UI_KEY)}/{INPUT_TYPE_KEY}"
                    if not isinstance(constraints.get(MULTIPLE_CHOICE_KEY), bool):
                        refusals.append(f"{here} states no multipleChoice, so how many answers "
                                        "a list would allow is a decision rather than a repair")
                    else:
                        result[UI_KEY] = {**ui, INPUT_TYPE_KEY: LIST_INPUT_TYPE}
                        changes.append({"path": here, "replaced": stated, "wrote": LIST_INPUT_TYPE})
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    repaired = walk(copy.deepcopy(artifact), "")
    if artifact.get(STATUS_KEY) != DRAFT_STATUS:
        raise TransformRefused(
            f"a field's type is only changed on a draft; this artifact is {artifact.get(STATUS_KEY)!r}")
    if refusals:
        raise TransformRefused(refusals[0] + (f" ({len(refusals)} in all)" if len(refusals) > 1 else ""))
    return repaired, changes


def only_presented_choices_as_a_list(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only change is an input type becoming ``list``, on a field with options.

    Every option, the multiple-choice flag and the requirement are compared like any other value,
    so a repair that touched what the field offers rather than how it offers it is caught here.
    """

    def offered_choices(node: Any) -> bool:
        constraints = node.get(VALUE_CONSTRAINTS_KEY) if isinstance(node, dict) else None
        literals = constraints.get(LITERALS_KEY) if isinstance(constraints, dict) else None
        return isinstance(literals, list) and bool(literals)

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            # The input type is judged where the options are visible: a field, not its _ui alone.
            oldUi, newUi = old.get(UI_KEY), new.get(UI_KEY)
            if (isinstance(oldUi, dict) and isinstance(newUi, dict)
                    and oldUi.get(INPUT_TYPE_KEY) != newUi.get(INPUT_TYPE_KEY)):
                here = f"{path}/{rest.json_pointer_component(UI_KEY)}/{INPUT_TYPE_KEY}"
                if (newUi.get(INPUT_TYPE_KEY) != LIST_INPUT_TYPE
                        or oldUi.get(INPUT_TYPE_KEY) in rest.CHOICE_INPUT_TYPES
                        or not offered_choices(old)
                        or not isinstance((old.get(VALUE_CONSTRAINTS_KEY) or {}).get(MULTIPLE_CHOICE_KEY), bool)):
                    return here
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == UI_KEY and isinstance(oldUi, dict) and isinstance(newUi, dict):
                    if set(oldUi) != set(newUi):
                        return here
                    for key in oldUi:
                        if key == INPUT_TYPE_KEY:
                            continue
                        difference = walk(oldUi[key], newUi[key],
                                          f"{here}/{rest.json_pointer_component(key)}")
                        if difference is not None:
                            return difference
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")




def has_a_label(entry: Any) -> bool:
    """Whether a permitted value names itself."""
    return isinstance(entry, dict) and isinstance(entry.get("label"), str) and entry["label"] != ""


def drop_blank_literal(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove a permitted value that has no label.

    A literal's label is the value an instance stores, so a blank entry offers a choice whose
    answer cannot be told from no answer. What it is reaching for — that the field may be left
    alone — is already what ``requiredValue: false`` says, so removing the entry takes away a
    second, lossier way of saying it rather than taking away a choice.

    Refused where it would empty a list, since a list field with no permitted values is a
    different change, and on anything that is not a draft.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []
    refusals: list[str] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {}
            for name, value in node.items():
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name == VALUE_CONSTRAINTS_KEY and isinstance(value, dict)
                        and isinstance(value.get(LITERALS_KEY), list)):
                    entries = value[LITERALS_KEY]
                    kept = [entry for entry in entries if has_a_label(entry)]
                    if len(kept) != len(entries):
                        literals_path = f"{here}/{LITERALS_KEY}"
                        if not kept:
                            refusals.append(f"{literals_path} would be left with no permitted value")
                        else:
                            for index, entry in enumerate(entries):
                                if not has_a_label(entry):
                                    changes.append({"path": f"{literals_path}/{index}",
                                                    "replaced": entry.get("label"), "wrote": None})
                            value = {**value, LITERALS_KEY: kept}
                result[name] = walk(value, here)
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    repaired = walk(copy.deepcopy(artifact), "")
    if artifact.get(STATUS_KEY) != DRAFT_STATUS:
        raise TransformRefused(
            f"a permitted value is only dropped on a draft; this artifact is {artifact.get(STATUS_KEY)!r}")
    if refusals:
        raise TransformRefused(refusals[0] + (f" ({len(refusals)} in all)" if len(refusals) > 1 else ""))
    return repaired, changes


def only_dropped_blank_literals(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only change is unlabelled permitted values, removed in place."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name == LITERALS_KEY and isinstance(old[name], list)
                        and isinstance(new[name], list) and len(old[name]) != len(new[name])):
                    if new[name] != [e for e in old[name] if has_a_label(e)]:
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")




def resolves_to_a_term(entry: Any) -> bool:
    """Whether a class constraint points at anything."""
    return isinstance(entry, dict) and isinstance(entry.get("uri"), str) and entry["uri"] != ""


def drop_unresolved_class_constraint(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove a class constraint whose URI is the empty string.

    A class constraint is a pointer to a term, so one pointing at ``""`` offers a choice that
    cannot be resolved: both model libraries refuse to read it, which leaves the template with no
    YAML representation. The entry carries a label and nothing else, and no term exists to give it
    — the converter that wrote these had an empty ``conceptURI`` in its own input, meaning the
    harmonisation upstream had already concluded there was none.

    Removing the entry loses the fact that the label was once offered as a choice. That is the
    point of the repair rather than an oversight: what it offered was unusable, and the alternative
    readings — inventing a near-miss term, or leaving the template unreadable — are both worse.

    Refused where it would empty a list, since a controlled-term field left with no constraint at
    all is a different change, and on anything that is not a draft, since dropping a choice a
    published template offered is not a repair.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []
    refusals: list[str] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            result = {}
            for name, value in node.items():
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name == VALUE_CONSTRAINTS_KEY and isinstance(value, dict)
                        and isinstance(value.get(CLASSES_KEY), list)):
                    entries = value[CLASSES_KEY]
                    kept = [entry for entry in entries if resolves_to_a_term(entry)]
                    if len(kept) != len(entries):
                        classes_path = f"{here}/{CLASSES_KEY}"
                        if not kept:
                            refusals.append(f"{classes_path} would be left with no constraint at all")
                        elif node.get(STATUS_KEY) is not None and node.get(STATUS_KEY) != DRAFT_STATUS:
                            refusals.append(f"{classes_path} is on a {node.get(STATUS_KEY)!r} artifact")
                        else:
                            for index, entry in enumerate(entries):
                                if not resolves_to_a_term(entry):
                                    changes.append({
                                        "path": f"{classes_path}/{index}",
                                        "replaced": entry.get("prefLabel"), "wrote": None})
                            value = {**value, CLASSES_KEY: kept}
                result[name] = walk(value, here)
            return result
        if isinstance(node, list):
            return [walk(value, f"{path}/{index}") for index, value in enumerate(node)]
        return node

    repaired = walk(copy.deepcopy(artifact), "")
    if artifact.get(STATUS_KEY) != DRAFT_STATUS:
        raise TransformRefused(
            f"a class constraint is only dropped on a draft; this artifact is "
            f"{artifact.get(STATUS_KEY)!r}")
    if refusals:
        raise TransformRefused(refusals[0] + (f" ({len(refusals)} in all)" if len(refusals) > 1 else ""))
    return repaired, changes


def only_dropped_unresolved_class_constraints(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only change is class constraints pointing at nothing, removed in place.

    A list that shrank is checked against the filter itself, so the survivors have to be exactly
    the entries that resolve, in the order they were already in. Every other list must keep its
    length, and every other value must be identical.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name == CLASSES_KEY and isinstance(old[name], list)
                        and isinstance(new[name], list) and len(old[name]) != len(new[name])):
                    if new[name] != [e for e in old[name] if resolves_to_a_term(e)]:
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def default_unreadable_version(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give a draft whose stated version carries no version the one a new artifact gets.

    ``0.0.1`` is not a guess at what the author meant: nothing in ``requestJson`` or ``asd`` means
    anything, and the alternative to writing the default is leaving the artifact with no YAML
    representation for good. It is what the library would have assigned had the caller supplied
    nothing at all, which is the honest reading of a field that was filled by accident.

    Deliberately last of the three version repairs, and never a fallback for the other two: a value
    padding or settling can read is theirs, because those recover what was written rather than
    replacing it.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []
    published: list[str] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        stored = definition.get(ARTIFACT_VERSION_KEY)
        if unreadable_version(stored):
            here = f"{path}/{rest.json_pointer_component(ARTIFACT_VERSION_KEY)}"
            if definition.get(STATUS_KEY) != DRAFT_STATUS:
                published.append(f"{here} is {definition.get(STATUS_KEY)!r}")
            else:
                result[ARTIFACT_VERSION_KEY] = DEFAULT_ARTIFACT_VERSION
                changes.append({"path": here, "replaced": stored,
                                "wrote": DEFAULT_ARTIFACT_VERSION})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    defaulted = walk(artifact, "")
    if published:
        raise TransformRefused(
            "a version is only defaulted on a draft, and " + published[0]
            + (f" ({len(published)} in all)" if len(published) > 1 else ""))
    return defaulted, changes


def only_defaulted_unreadable_version(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is an unreadable version on a draft becoming the default."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == ARTIFACT_VERSION_KEY and new[name] != old[name]:
                    if not unreadable_version(old[name]) or new[name] != DEFAULT_ARTIFACT_VERSION:
                        return here
                    if old.get(STATUS_KEY) != DRAFT_STATUS:
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")




def settle_prerelease_version(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write a version carrying a prerelease tag as its release.

    ``1.0.0-rc1`` is correct semver whose tag the model's three integers cannot hold, so the
    artifact has no YAML representation until the tag goes. Dropping it is a reading of what was
    meant rather than a completion of what was written — unlike padding, something is discarded —
    so this is a separate repair an owner asks for, not one the tool applies on its own.

    Refused unless every definition carrying such a version is a draft. On a published artifact the
    version is what other things cite, and changing which release it claims is not a repair.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []
    published: list[str] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        stored = definition.get(ARTIFACT_VERSION_KEY)
        release = rest.release_version(stored) if isinstance(stored, str) else None
        if release is not None:
            here = f"{path}/{rest.json_pointer_component(ARTIFACT_VERSION_KEY)}"
            if definition.get(STATUS_KEY) != DRAFT_STATUS:
                published.append(f"{here} is {definition.get(STATUS_KEY)!r}")
            else:
                result[ARTIFACT_VERSION_KEY] = release
                changes.append({"path": here, "replaced": stored, "wrote": release})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    settled = walk(artifact, "")
    if published:
        raise TransformRefused(
            "a prerelease version is only settled on a draft, and " + published[0]
            + (f" ({len(published)} in all)" if len(published) > 1 else ""))
    return settled, changes


def only_settled_prerelease_version(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is a prerelease version becoming its own release, nothing else.

    The release is re-derived from the stored value rather than trusted, and the status is compared
    like any other value, so a repair that moved a draft to published would be caught here.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == ARTIFACT_VERSION_KEY and new[name] != old[name]:
                    if not isinstance(old[name], str) or new[name] != rest.release_version(old[name]):
                        return here
                    if old.get(STATUS_KEY) != DRAFT_STATUS:
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def pad_artifact_version(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write a short numeric ``pav:version`` as the three-part version it means.

    ``0.9`` is ``0.9.0`` and ``1`` is ``1.0.0``: the missing parts are zero, which is the only
    reading available and the one the library assumes the moment it can parse the value at all.
    Until it can, the artifact has no YAML representation — a JSON read returns the stored bytes
    unexamined while a YAML read transcodes them and fails — so this is what restores one.

    A version carrying a prerelease tag is left alone: ``1.0.0-rc1`` is correct semver that the
    model's three integers cannot hold, which is a limitation to decide about rather than a value
    to rewrite. So is anything a rule cannot read, such as ``asd``; inventing a version for it
    would replace a visible defect with an invisible one. Both go on being reported.

    A template states a version on each nested definition as well as at its root, and the two drift
    apart, so the walk covers both.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        stored = definition.get(ARTIFACT_VERSION_KEY)
        if isinstance(stored, str) and not audit.VERSION_PATTERN.match(stored):
            padded = rest.padded_version(stored)
            if padded is not None:
                result[ARTIFACT_VERSION_KEY] = padded
                changes.append({"path": f"{path}/{rest.json_pointer_component(ARTIFACT_VERSION_KEY)}",
                                "replaced": stored, "wrote": padded})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(artifact, ""), changes


def only_padded_artifact_version(before: Any, after: Any) -> Optional[str]:
    """The invariant: every change is a short numeric version becoming the one it means.

    The padding has to be re-derived from the stored value rather than trusted, so a transform that
    wrote some other version would be caught here rather than shipped.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == ARTIFACT_VERSION_KEY and new[name] != old[name]:
                    if not isinstance(old[name], str) or new[name] != rest.padded_version(old[name]):
                        return here
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def stamp_static_field_model_version(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Declare the current model version on a static field that states none.

    A static field is a model specification like any other definition, and the model gives it a
    version. ``static-field-meta-schema.json`` omits the property, which is why an absence there is
    accepted on write while the library writes one on every render; the omission is a defect in the
    meta-schema rather than a decision, and this fills the artifacts ahead of closing it.

    Narrower than :func:`stamp_model_version` on purpose. That one moves a version that is merely
    behind and refuses to guess at one that is absent or unparseable, which is the right answer
    wherever the model already demands a version. Here the demand is the thing being added, so the
    absence is the defect. A static field stating a version, current or not, is left to the other
    repair, and nothing but a static field is touched.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        if definition.get("@type") == STATIC_AT_TYPE and MODEL_VERSION_KEY not in definition:
            result[MODEL_VERSION_KEY] = audit.MODEL_VERSION
            changes.append({"path": f"{path}/{rest.json_pointer_component(MODEL_VERSION_KEY)}",
                            "replaced": None, "wrote": audit.MODEL_VERSION})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(artifact, ""), changes


def only_stamped_static_field_model_version(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only change is a static field gaining the current model version.

    An addition is what this repair makes, so unlike its sibling the walk has to admit one key
    appearing — and admit exactly that one, on exactly that kind of node, with exactly that value.
    Nothing may be removed and no other value may move.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            if set(old) - set(new):
                return path or "/"
            added = set(new) - set(old)
            if added - {MODEL_VERSION_KEY}:
                return path or "/"
            if added:
                here = f"{path}/{rest.json_pointer_component(MODEL_VERSION_KEY)}"
                if old.get("@type") != STATIC_AT_TYPE or new[MODEL_VERSION_KEY] != audit.MODEL_VERSION:
                    return here
            for name in old:
                difference = walk(old[name], new[name], f"{path}/{rest.json_pointer_component(name)}")
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def complete_ui_order(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Append to ``_ui.order`` the children a container declares but does not list.

    The order is a presentation index over the children, not the authority for whether one exists, so
    a child absent from it is invisible rather than gone. Each omitted key is appended after the
    existing order, which changes no established position. The inverse drift, an order entry naming no
    child, is deliberately left alone: the store does not hold enough to synthesize the child, and
    removing the entry would discard the only remaining evidence that it was there.
    """
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        names = [name for name, _child, _multiple in container_children(container)]
        ui = result.get("_ui")
        if names and isinstance(ui, dict) and isinstance(ui.get("order"), list):
            listed = [entry for entry in ui["order"] if isinstance(entry, str)]
            omitted = [name for name in names if name not in listed]
            if omitted:
                ui["order"] = list(ui["order"]) + omitted
                for name in omitted:
                    changes.append({"path": f"{path}/_ui/order", "replaced": None, "wrote": name})
        for name, child, multiple in container_children(container):
            declared = rest.child_path(path, name)
            here = f"{declared}/items" if multiple else declared
            repaired = walk(child, here)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def unusable_order_entries(container: Any) -> list[str]:
    """The entries of a container's ``_ui.order`` that name no child and never could.

    An order entry is a presentation index over the children, so one naming no child renders nothing
    and is inert. That alone does not make it safe to remove: where a child was deleted from
    ``properties`` and left in the order, the entry is the only surviving evidence that it existed, and
    discarding it costs more than the tidiness is worth. Two cases carry their own proof that nothing
    is lost.

    The first is an entry bearing a name the model reserves for an artifact's own keywords, which no
    child can ever be called; these arrive when a writer pours every key of an object into the order.
    The second is a name that a rename left behind, recognised by the container declaring a child whose
    name is the entry with each ``/`` replaced by ``-`` — the spelling a property name is allowed. The
    renamed child is present and already ordered, so the stale entry duplicates a record that survives
    in full.
    """
    ui = container.get("_ui") if isinstance(container, dict) else None
    order = ui.get("order") if isinstance(ui, dict) else None
    if not isinstance(order, list):
        return []
    declared = {name for name, _child, _multiple in container_children(container)}
    unusable = []
    for entry in order:
        if not isinstance(entry, str) or entry in declared:
            continue
        if entry in rest.RESERVED_CHILD_NAMES or ("/" in entry and entry.replace("/", "-") in declared):
            unusable.append(entry)
    return unusable


def drop_unusable_order_entries(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove the order entries that name no child and never could."""
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        unusable = unusable_order_entries(container)
        if unusable:
            ui = result["_ui"]
            ui["order"] = [entry for entry in ui["order"]
                           if not (isinstance(entry, str) and entry in unusable)]
            for entry in unusable:
                changes.append({"path": f"{path}/_ui/order", "replaced": entry, "wrote": None})
        for name, child, multiple in container_children(container):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_dropped_unusable_order_entries(before: Any, after: Any) -> Optional[str]:
    """The invariant: an order list lost only unusable entries, and kept the rest in sequence."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            unusable = unusable_order_entries(old)
            for name in old:
                here = f"{path}/{rest.json_pointer_component(name)}"
                if name == "_ui" and unusable and isinstance(old[name], dict) and isinstance(new[name], dict):
                    difference = ui_order_difference(old[name], new[name], unusable, here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def ui_order_difference(old: dict, new: dict, unusable: list[str], path: str) -> Optional[str]:
        if set(old) != set(new):
            return path
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name != "order":
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
                continue
            kept = [entry for entry in old[name]
                    if not (isinstance(entry, str) and entry in unusable)]
            if new[name] != kept:
                return here
        return None

    return walk(before, after, "")


def only_appended_ui_order(before: Any, after: Any) -> Optional[str]:
    """The invariant: an order list only gained declared children, appended after what it already held."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            declared = {name for name, _child, _multiple in container_children(old)}
            for name in set(old) | set(new):
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name in old) != (name in new):
                    return here
                if name == "_ui" and isinstance(old[name], dict) and isinstance(new[name], dict):
                    difference = ui_difference(old[name], new[name], declared, here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def ui_difference(old: dict, new: dict, declared: set[str], path: str) -> Optional[str]:
        for name in set(old) | set(new):
            here = f"{path}/{rest.json_pointer_component(name)}"
            if (name in old) != (name in new):
                return here
            if name == "order" and isinstance(old[name], list) and isinstance(new[name], list):
                kept, appended = new[name][:len(old[name])], new[name][len(old[name]):]
                if kept != old[name]:
                    return here
                if any(entry not in declared or entry in old[name] for entry in appended):
                    return here
                continue
            difference = walk(old[name], new[name], here)
            if difference is not None:
                return difference
        return None

    return walk(before, after, "")


def drop_zero_term_count(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Delete a ``numTerms`` written as zero, which claims a constraint matches nothing.

    ``numTerms`` caches how many terms a controlled-term constraint covers, so a reader can size a
    picker before asking the terminology server. Zero says the constraint matches nothing, which would
    make the field unfillable, and no constraint in production means that: the value is a sentinel for
    a count that was never taken. Deleting the key restores the honest state, an unknown count, which
    is what every reader already handles when the key is absent.
    """
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        constraints = result.get("_valueConstraints")
        if isinstance(constraints, dict):
            for key in audit.COUNTED_CONSTRAINT_KEYS:
                entries = constraints.get(key)
                if not isinstance(entries, list):
                    continue
                for index, entry in enumerate(entries):
                    if not isinstance(entry, dict) or not audit.is_plain_int(entry.get("numTerms")):
                        continue
                    if entry["numTerms"] != 0:
                        continue
                    del entry["numTerms"]
                    changes.append({"path": f"{path}/_valueConstraints/{key}/{index}/numTerms",
                                    "replaced": 0, "wrote": None})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_dropped_zero_term_counts(before: Any, after: Any) -> Optional[str]:
    """The invariant: only a ``numTerms`` of exactly zero went, and nothing else moved."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            for key in set(old) | set(new):
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key not in new:
                    if key != "numTerms" or old[key] != 0 or not audit.is_plain_int(old[key]):
                        return here
                    continue
                if key not in old:
                    return here
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def drop_stray_cardinality_keys(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Delete ``minItems`` and ``maxItems`` from a child deployed as a single object.

    The two keys are JSON Schema's bounds on an array, and a child deployed as an object holds one
    value by construction. Left in place they read as a cardinality the deployment cannot express, and
    a reader that believes them describes a child that does not exist. Removing them changes nothing
    an instance may contain: the object deployment already permits exactly one value.
    """
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        for name, child, multiple in container_children(container):
            declared_path = rest.child_path(path, name)
            repaired = walk(child, f"{declared_path}/items" if multiple else declared_path)
            if multiple:
                result["properties"][name]["items"] = repaired
                continue
            # A child deployed as an object is its own declaration, so the bounds come off the
            # walked result rather than the original, which the walk would otherwise reinstate.
            for key in ("minItems", "maxItems"):
                if key in repaired:
                    changes.append({"path": f"{declared_path}/{key}",
                                    "replaced": repaired[key], "wrote": None})
                    del repaired[key]
            result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_dropped_stray_cardinality_keys(before: Any, after: Any) -> Optional[str]:
    """The invariant: bounds went only from a child that is not an array, and nothing else moved."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            single = {name for name, _child, multiple in container_children(old) if not multiple}
            declarations = old.get("properties") if isinstance(old.get("properties"), dict) else {}
            for key in set(old) | set(new):
                here = f"{path}/{rest.json_pointer_component(key)}"
                if (key in old) != (key in new):
                    return here
                if key == "properties" and isinstance(old[key], dict) and isinstance(new[key], dict):
                    difference = properties_difference(old[key], new[key], single, here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def properties_difference(old: dict, new: dict, single: set[str], path: str) -> Optional[str]:
        if set(old) != set(new):
            return path
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name in single and isinstance(old[name], dict) and isinstance(new[name], dict):
                for key in set(old[name]) | set(new[name]):
                    there = f"{here}/{rest.json_pointer_component(key)}"
                    if key not in new[name]:
                        if key not in ("minItems", "maxItems"):
                            return there
                        continue
                    if key not in old[name]:
                        return there
                    difference = walk(old[name][key], new[name][key], there)
                    if difference is not None:
                        return difference
                continue
            difference = walk(old[name], new[name], here)
            if difference is not None:
                return difference
        return None

    return walk(before, after, "")


def settle_temporal_type(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write the temporal type a temporal field's own granularity already settles.

    ``_valueConstraints.temporalType`` is what makes a temporal field fillable; without it the field
    sits in the template as a slot nobody can complete. A granularity of a day or coarser can only be
    a date, so the field itself already says what it holds and the type is read off rather than
    chosen. Below a day the field may hold a time of day or a full timestamp, the granularity does not
    decide between them, and those fields are left for the stored values to settle.
    """
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        ui = definition.get("_ui")
        constraints = definition.get("_valueConstraints")
        settled = audit.GRANULARITY_TO_TEMPORAL_TYPE.get(
            ui.get("temporalGranularity")) if isinstance(ui, dict) else None
        if isinstance(ui, dict) and ui.get("inputType") == "temporal" and settled is not None \
                and isinstance(constraints, dict) and not constraints.get("temporalType"):
            result["_valueConstraints"]["temporalType"] = settled
            changes.append({"path": f"{path}/_valueConstraints/temporalType",
                            "replaced": constraints.get("temporalType"), "wrote": settled})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_settled_temporal_types(before: Any, after: Any) -> Optional[str]:
    """The invariant: a temporal type appeared only where the field's own granularity settles it.

    The granularity sits in ``_ui`` and the type in ``_valueConstraints``, so the two are read
    together at the definition that holds both rather than at the block that changed.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            ui = old.get("_ui")
            settled = audit.GRANULARITY_TO_TEMPORAL_TYPE.get(
                ui.get("temporalGranularity")) if isinstance(ui, dict) else None
            temporal = isinstance(ui, dict) and ui.get("inputType") == "temporal"
            for key in old:
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key == "_valueConstraints" and temporal and settled is not None \
                        and isinstance(old[key], dict) and isinstance(new[key], dict):
                    difference = constraints_difference(old[key], new[key], settled, here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def constraints_difference(old: dict, new: dict, settled: str, path: str) -> Optional[str]:
        if set(old) | {"temporalType"} != set(new) | {"temporalType"}:
            return path
        for key in set(old) | set(new):
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key == "temporalType":
                # An absent or empty type may take the settled value; a stated one may not move.
                if old.get(key):
                    if new.get(key) != old.get(key):
                        return here
                elif new.get(key) != settled:
                    return here
                continue
            if (key in old) != (key in new):
                return here
            difference = walk(old[key], new[key], here)
            if difference is not None:
                return difference
        return None

    return walk(before, after, "")


def kind_word(definition: Any) -> Optional[str]:
    """The kind a definition's ``@type`` names, where it names one.

    A JSON Schema subtree can hold an ``@type`` that is not an artifact type at all: inside a field's
    ``properties`` it is the object constraining an instance's own ``@type``, which is neither a
    string nor hashable, so it is read rather than looked up.
    """
    if not isinstance(definition, dict):
        return None
    at_type = definition.get(AT_TYPE)
    return KIND_WORD.get(at_type) if isinstance(at_type, str) else None


# The model fixes the head of a container's JSON Schema `required` array: `@context` then `@id`, then
# the rest. A container is the artifact's own account of what an instance must carry.
CONTAINER_AT_TYPES = frozenset({audit.TEMPLATE, rest.TEMPLATE_ELEMENT})


def is_container(definition: Any) -> bool:
    """Whether a definition is a template or an element.

    The ``@type`` is read as a string before it is looked up. A JSON Schema subtree can hold an
    ``@type`` that is not an artifact type at all — inside a field's ``properties`` it is the object
    constraining an instance's own ``@type`` — and an object is not hashable, so testing it for
    membership raises rather than answering.
    """
    if not isinstance(definition, dict):
        return False
    at_type = definition.get(AT_TYPE)
    return isinstance(at_type, str) and at_type in CONTAINER_AT_TYPES
MISSING_CONTEXT_REQUIRED_ERROR = r"^object instance has properties which are not allowed by the schema"


def require_context(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Put ``@context`` back at the head of a container's ``required`` array.

    A template or element states in ``required`` what an instance of it must carry, and the model
    fixes the first entries: ``@context`` before ``@id``. A container that lists ``@id`` and not
    ``@context`` describes an instance with no context at all, which is not a CEDAR instance, and the
    library reads the container under the wrong branch entirely — it stops matching the element
    schema, falls through to the field schema, and then reports every child as a property a field may
    not have. One absent entry, and the whole subtree is misread.

    The entry goes at the head rather than the end, which is where the model puts it and where the
    positions of the entries after it are counted from.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        required = definition.get("required")
        if is_container(definition) and isinstance(required, list) \
                and "@context" not in required:
            result["required"] = ["@context"] + list(required)
            changes.append({"path": f"{path}/required", "replaced": None, "wrote": "@context"})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_required_context(before: Any, after: Any) -> Optional[str]:
    """The invariant: a required array gained only ``@context``, at its head, order otherwise kept."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            required = old.get("required")
            addable = is_container(old) and isinstance(required, list) \
                and "@context" not in required
            for key in old:
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key == "required" and addable:
                    if new[key] != ["@context"] + list(old[key]):
                        return here
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


# The name the model gave a date field before it gave one name to every temporal kind. The Template
# Designer still carries a branch for it, which is why artifacts hold it long after the rename.
LEGACY_TEMPORAL_INPUT_TYPE = "date"
LITERAL_INPUT_TYPE_ERROR = (r"^/(.*/)?_ui/inputType: does not have a value in the enumeration "
                            r"\['textfield', 'textarea'")


def rename_legacy_temporal_input_type(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give a field declared ``date`` the name the model now uses for a temporal field.

    ``date`` was the input type of a field holding a date before the model settled on ``temporal`` for
    every temporal kind, and the rename left stored artifacts behind. The Designer's own branch for it
    also shaped the field: it constrains ``@type`` as a bare URI and adds ``@type`` to ``required``,
    which is why a field written this way does not look like its modern siblings. Both of those the
    model still accepts; only the name does not.

    Nothing else is written. In particular no granularity or temporal type is invented: the field says
    it holds a date and not which kind of date, so the repair leaves it stating what it states, and the
    inventory goes on counting it among the temporal types only stored values can settle.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        ui = definition.get("_ui")
        properties = definition.get("properties")
        literal = isinstance(properties, dict) and "@value" in properties
        if definition.get(AT_TYPE) == rest.TEMPLATE_FIELD and literal and isinstance(ui, dict) \
                and ui.get("inputType") == LEGACY_TEMPORAL_INPUT_TYPE:
            result["_ui"]["inputType"] = "temporal"
            changes.append({"path": f"{path}/_ui/inputType",
                            "replaced": LEGACY_TEMPORAL_INPUT_TYPE, "wrote": "temporal"})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_renamed_legacy_temporal_input_types(before: Any, after: Any) -> Optional[str]:
    """The invariant: only a literal field's ``date`` became ``temporal``, and nothing else moved."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            properties = old.get("properties")
            literal = isinstance(properties, dict) and "@value" in properties
            renameable = old.get(AT_TYPE) == rest.TEMPLATE_FIELD and literal
            for key in old:
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key == "_ui" and isinstance(old[key], dict) and isinstance(new[key], dict):
                    difference = ui_difference(old[key], new[key], renameable, here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def ui_difference(old: dict, new: dict, renameable: bool, path: str) -> Optional[str]:
        if set(old) != set(new):
            return path
        for key in old:
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key == "inputType" and new[key] != old[key]:
                if not renameable or old[key] != LEGACY_TEMPORAL_INPUT_TYPE \
                        or new[key] != "temporal":
                    return here
                continue
            difference = walk(old[key], new[key], here)
            if difference is not None:
                return difference
        return None

    return walk(before, after, "")


# The input types the model allows a field whose value is an IRI, and the text bounds only a field
# whose value is a literal may carry.
IRI_FIELD_INPUT_TYPES = frozenset({
    "link", "controlled-term", "ext-ror", "ext-orcid", "ext-pfas", "ext-rrid", "ext-pubmed",
    "ext-nih-grant-id", "ext-doi",
})
LITERAL_ONLY_CONSTRAINT_KEYS = ("minLength", "maxLength")
TERM_CONSTRAINT_KEYS = ("ontologies", "valueSets", "classes", "branches")
IRI_INPUT_TYPE_ERROR = (r"^/(.*/)?_ui/inputType: does not have a value in the enumeration "
                        r"\['link', 'controlled-term'")


def holds_an_iri_value(definition: Any) -> bool:
    """Whether a field's own value shape is an IRI rather than a literal.

    The shape is the field's account of what an instance may carry: ``@id`` for a term, ``@value``
    for a literal. It is the part a user cannot set by hand and an editor does not rewrite, which is
    why it is the reliable witness when the rest of the declaration disagrees with it.
    """
    if not isinstance(definition, dict) or definition.get(AT_TYPE) != rest.TEMPLATE_FIELD:
        return False
    properties = definition.get("properties")
    if not isinstance(properties, dict):
        return False
    return "@id" in properties and "@value" not in properties


def constrains_terms(definition: Any) -> bool:
    """Whether a field names ontologies, value sets, classes or branches to draw its terms from."""
    constraints = definition.get("_valueConstraints") if isinstance(definition, dict) else None
    if not isinstance(constraints, dict):
        return False
    return any(constraints.get(key) for key in TERM_CONSTRAINT_KEYS)


def settle_controlled_term_field(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Declare as a controlled-term field one whose value and constraints already are.

    A field states its kind three times: in the value shape under ``properties``, in the constraints
    it draws terms from, and in ``_ui.inputType``. Where the first two say a term and the third says
    a literal, the third is the one that moved, because an editor writes it and nothing else does.
    The type is read off the body rather than chosen: ``controlled-term`` is what a field drawing
    from ontologies, value sets, classes or branches is, as distinct from the other IRI input types,
    which take their value from somewhere no constraint names.

    The bounds a literal field may carry go at the same time. ``minLength`` and ``maxLength`` measure
    a string, and the model does not let a field holding an IRI state them; they are left over from
    the literal the field was declared as, and keeping them would describe a length nothing has.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        ui = definition.get("_ui")
        input_type = ui.get("inputType") if isinstance(ui, dict) else None
        if holds_an_iri_value(definition) and constrains_terms(definition) \
                and isinstance(input_type, str) and input_type not in IRI_FIELD_INPUT_TYPES:
            result["_ui"]["inputType"] = "controlled-term"
            changes.append({"path": f"{path}/_ui/inputType", "replaced": input_type,
                            "wrote": "controlled-term"})
            constraints = result.get("_valueConstraints")
            if isinstance(constraints, dict):
                for key in LITERAL_ONLY_CONSTRAINT_KEYS:
                    if key in constraints:
                        changes.append({"path": f"{path}/_valueConstraints/{key}",
                                        "replaced": constraints[key], "wrote": None})
                        del constraints[key]
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_settled_controlled_term_fields(before: Any, after: Any) -> Optional[str]:
    """The invariant: only a term-constrained IRI field's declaration moved, and only those parts."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            ui = old.get("_ui")
            input_type = ui.get("inputType") if isinstance(ui, dict) else None
            settleable = holds_an_iri_value(old) and constrains_terms(old) \
                and isinstance(input_type, str) and input_type not in IRI_FIELD_INPUT_TYPES
            for key in old:
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key == "_ui" and settleable and isinstance(old[key], dict) \
                        and isinstance(new[key], dict):
                    difference = ui_difference(old[key], new[key], here)
                    if difference is not None:
                        return difference
                    continue
                if key == "_valueConstraints" and settleable and isinstance(old[key], dict) \
                        and isinstance(new[key], dict):
                    difference = constraints_difference(old[key], new[key], here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def ui_difference(old: dict, new: dict, path: str) -> Optional[str]:
        if set(old) != set(new):
            return path
        for key in old:
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key == "inputType":
                if new[key] != old[key] and new[key] != "controlled-term":
                    return here
                continue
            difference = walk(old[key], new[key], here)
            if difference is not None:
                return difference
        return None

    def constraints_difference(old: dict, new: dict, path: str) -> Optional[str]:
        if set(new) != set(old) - set(LITERAL_ONLY_CONSTRAINT_KEYS) and set(new) != set(old):
            return path
        for key in new:
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key not in old:
                return here
            difference = walk(old[key], new[key], here)
            if difference is not None:
                return difference
        return None

    return walk(before, after, "")


BLANK_PROPERTY_LABEL_ERROR = r"^/(.*/)?_ui/propertyLabels/.+: must be at least 1 characters long$"


def blank_orphan_property_labels(container: Any) -> list[str]:
    """The ``_ui.propertyLabels`` keys that name no child and carry no label.

    A label names a child for a reader. The model requires a non-empty one, so a blank label is not a
    way of hiding a heading; it is a value the artifact may not hold. Where the key also names no
    child the entry is what a deleted child left behind, and nothing is lost by removing it. A blank
    label on a child that still exists is a different repair, because the child's own name is the
    label to write and dropping the entry would throw that answer away.
    """
    ui = container.get("_ui") if isinstance(container, dict) else None
    labels = ui.get("propertyLabels") if isinstance(ui, dict) else None
    if not isinstance(labels, dict):
        return []
    declared = {name for name, _child, _multiple in container_children(container)}
    return [name for name, label in labels.items()
            if isinstance(label, str) and not label.strip() and name not in declared]


def drop_blank_orphan_property_labels(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove a blank property label left behind by a child that no longer exists."""
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        for name in blank_orphan_property_labels(container):
            del result["_ui"]["propertyLabels"][name]
            changes.append({"path": f"{path}/_ui/propertyLabels/"
                                    f"{rest.json_pointer_component(name)}",
                            "replaced": container["_ui"]["propertyLabels"][name], "wrote": None})
        for name, child, multiple in container_children(container):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_dropped_blank_orphan_property_labels(before: Any, after: Any) -> Optional[str]:
    """The invariant: only a blank label naming no child went, and nothing else moved."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            droppable = set(blank_orphan_property_labels(old))
            for key in old:
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key == "_ui" and droppable and isinstance(old[key], dict) \
                        and isinstance(new[key], dict):
                    difference = ui_difference(old[key], new[key], droppable, here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def ui_difference(old: dict, new: dict, droppable: set[str], path: str) -> Optional[str]:
        if set(old) != set(new):
            return path
        for key in old:
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key != "propertyLabels":
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
                continue
            if not isinstance(old[key], dict) or not isinstance(new[key], dict):
                return None if old[key] == new[key] else here
            if set(new[key]) != set(old[key]) - droppable:
                return here
            for name in new[key]:
                if new[key][name] != old[key][name]:
                    return f"{here}/{rest.json_pointer_component(name)}"
        return None

    return walk(before, after, "")


MISSING_ACTION_SOURCE_ERROR = r"^object has missing required properties \(\['source'\]\)$"


def action_source_index(constraints: Any) -> dict[str, str]:
    """The acronym each constrained ontology, value set, class or branch is known by, keyed by its URI.

    An action names what it acted on by URI; the constraint entry beside it carries the acronym under
    whichever key its kind uses — ``source`` for a class, ``acronym`` for an ontology, ``vsCollection``
    for a value set.
    """
    index: dict[str, str] = {}
    if not isinstance(constraints, dict):
        return index
    for key in audit.CONSTRAINT_KEYS:
        for entry in constraints.get(key) or []:
            if not isinstance(entry, dict) or not isinstance(entry.get("uri"), str):
                continue
            acronym = entry.get("source") or entry.get("acronym") or entry.get("vsCollection")
            if isinstance(acronym, str) and acronym:
                index.setdefault(entry["uri"], acronym)
    return index


def settled_action_source(action: Any, index: dict[str, str]) -> Optional[str]:
    """The acronym an action's own URIs resolve to, where the field still constrains what it names."""
    if not isinstance(action, dict):
        return None
    for key in ("sourceUri", "termUri"):
        value = action.get(key)
        if isinstance(value, str) and value in index:
            return index[value]
    return None


def settle_constraint_actions(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give an action the source it names, or drop it where it names nothing the field still holds.

    An action records an edit to the term list a controlled-term field offers: a term moved to a
    position, or removed from the list. The model requires five keys on one, and ``source`` — the
    acronym of the collection the term came from — is the one some editors left out. ``sourceUri``
    is not that key under another name: it identifies what the term was picked from, an ontology, a
    branch, a value set, or the literal ``template`` where the list was built in place.

    The acronym is read off the field rather than chosen, by matching the action's own URIs against
    the constraint entries beside it. An action naming something the field no longer constrains is
    dropped instead: there is no list for it to act on, so it changes nothing today, and completing it
    would mean inventing the collection it once referred to. Positions are left as they stand, since a
    move names an absolute index into a list the remaining actions still describe.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        constraints = result.get("_valueConstraints")
        actions = constraints.get("actions") if isinstance(constraints, dict) else None
        if isinstance(actions, list):
            index = action_source_index(constraints)
            kept: list[Any] = []
            for position, action in enumerate(actions):
                where = f"{path}/_valueConstraints/actions/{position}"
                if not isinstance(action, dict) or "source" in action:
                    kept.append(action)
                    continue
                acronym = settled_action_source(action, index)
                if acronym is None:
                    changes.append({"path": where, "replaced": action.get("termUri"), "wrote": None,
                                    "reason": "names nothing the field still constrains"})
                    continue
                settled = dict(action)
                settled["source"] = acronym
                kept.append(settled)
                changes.append({"path": f"{where}/source", "replaced": None, "wrote": acronym})
            if changes:
                constraints["actions"] = kept
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    return walk(copy.deepcopy(artifact), ""), changes


def only_settled_constraint_actions(before: Any, after: Any) -> Optional[str]:
    """The invariant: an action kept its order and gained only a source the field itself names.

    Stated as properties rather than by recomputing the transform: what survives is a subsequence of
    what was there, each survivor differs by at most the one key, and what did not survive had no
    source and resolved to nothing.
    """

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            for key in old:
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key == "_valueConstraints" and isinstance(old[key], dict) \
                        and isinstance(new[key], dict):
                    difference = constraints_difference(old[key], new[key], here)
                    if difference is not None:
                        return difference
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    def constraints_difference(old: dict, new: dict, path: str) -> Optional[str]:
        if set(old) != set(new):
            return path
        for key in old:
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key != "actions":
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
                continue
            if not isinstance(old[key], list) or not isinstance(new[key], list):
                return None if old[key] == new[key] else here
            difference = actions_difference(old[key], new[key], action_source_index(old), here)
            if difference is not None:
                return difference
        return None

    def actions_difference(old: list, new: list, index: dict[str, str],
                           path: str) -> Optional[str]:
        remaining = list(new)
        for position, action in enumerate(old):
            here = f"{path}/{position}"
            settled = settled_action_source(action, index)
            if remaining and action_survives(action, remaining[0], settled):
                remaining.pop(0)
                continue
            # Dropped: only an action with no source that resolves to nothing may go.
            if not isinstance(action, dict) or "source" in action or settled is not None:
                return here
        return path if remaining else None

    def action_survives(old: Any, new: Any, settled: Optional[str]) -> bool:
        if old == new:
            return True
        if not isinstance(old, dict) or not isinstance(new, dict):
            return False
        if "source" in old or settled is None:
            return False
        return set(new) == set(old) | {"source"} and new["source"] == settled \
            and all(new[key] == old[key] for key in old)

    return walk(before, after, "")


# The input types a static field deploys. A static field renders and holds nothing, so unlike
# `attribute-value` — which does not serialize either, but is a field with a value — these say the
# definition carrying one is static.
STATIC_INPUT_TYPES = frozenset({"page-break", "section-break", "richtext", "image", "youtube"})
STATIC_INPUT_TYPE_ERROR = r"^/(.*/)?_ui/inputType: does not have a value in the enumeration"


def reclassify_static_field(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give a definition that is a static field in every respect but its ``@type`` that type.

    The Designer converts a field to a static type without revisiting everything the change implies,
    which is the same mechanism that leaves a static field named in ``required``. Here it leaves the
    original ``@type``, so the library reads the definition as an ordinary field and then finds it
    missing the ``properties`` and ``_valueConstraints`` an ordinary field must have, carrying a
    ``_ui._content`` only a static field may carry, and naming an ``inputType`` that is not among
    those a field holding a value can take. One key is wrong; the four complaints are its shadow.

    The type is read off the definition rather than chosen: it is written only where the input type is
    a static one and the definition has neither the value shape nor the constraints an ordinary field
    is defined by. A definition holding either of those is a different case, because the type would
    then contradict the rest of the body instead of agreeing with it.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        ui = definition.get("_ui")
        input_type = ui.get("inputType") if isinstance(ui, dict) else None
        if definition.get(AT_TYPE) == rest.TEMPLATE_FIELD and input_type in STATIC_INPUT_TYPES \
                and "properties" not in definition and "_valueConstraints" not in definition:
            result[AT_TYPE] = STATIC_AT_TYPE
            changes.append({"path": f"{path}/{rest.json_pointer_component(AT_TYPE)}",
                            "replaced": rest.TEMPLATE_FIELD, "wrote": STATIC_AT_TYPE,
                            "inputType": input_type})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    # An artifact with nothing to reclassify reports no change rather than refusing: the tool reruns
    # every transform over the stored body to confirm a write, and a refusal there reads as a failure.
    return walk(copy.deepcopy(artifact), ""), changes


def only_reclassified_static_fields(before: Any, after: Any) -> Optional[str]:
    """The invariant: only a static definition's @type moved, from field to static field."""

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict) or set(old) != set(new):
                return path or "/"
            ui = old.get("_ui")
            input_type = ui.get("inputType") if isinstance(ui, dict) else None
            reclassifiable = old.get(AT_TYPE) == rest.TEMPLATE_FIELD \
                and input_type in STATIC_INPUT_TYPES \
                and "properties" not in old and "_valueConstraints" not in old
            for key in old:
                here = f"{path}/{rest.json_pointer_component(key)}"
                if key == AT_TYPE and new[key] != old[key]:
                    if not reclassifiable or new[key] != STATIC_AT_TYPE:
                        return here
                    continue
                difference = walk(old[key], new[key], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def canonical_title(definition: Any) -> Optional[str]:
    """The title a definition's own ``@type`` and ``schema:name`` compose, where both are usable."""
    kind = kind_word(definition)
    name = definition.get("schema:name") if isinstance(definition, dict) else None
    if kind is None or not isinstance(name, str) or not name.strip():
        return None
    return f"{name} {kind} schema"


def derive_title(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Compose every definition's JSON Schema title from its own name, as an ordinary write does.

    The title is derived metadata rather than an authored value, and a stale one records a name the
    definition no longer has. A template states a title on each embedded field and element as well as
    at its root, and the server rewrites only the artifact's own, so an embedded child keeps whatever
    its generator gave it however far that has drifted. Each title here is composed from the name
    beside it, never from an ancestor's.

    A definition whose ``@type`` names no kind, or that has no usable name, is left alone: there is
    nothing to compose from, and guessing would write a title that asserts a name the definition does
    not have. Refusing the artifact outright is reserved for the case where that is all there is to
    do. The description is never touched, since it carries the generator's signature the audits read.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(definition: Any, path: str) -> Any:
        if not isinstance(definition, dict):
            return definition
        result = copy.deepcopy(definition)
        expected = canonical_title(definition)
        if expected is not None and definition.get("title") != expected:
            result["title"] = expected
            changes.append({"path": f"{path}/title", "replaced": definition.get("title"),
                            "wrote": expected})
        for name, child, multiple in container_children(definition):
            declared = rest.child_path(path, name)
            repaired = walk(child, f"{declared}/items" if multiple else declared)
            if multiple:
                result["properties"][name]["items"] = repaired
            else:
                result["properties"][name] = repaired
        return result

    titled = walk(copy.deepcopy(artifact), "")
    if not changes and canonical_title(artifact) is None:
        if kind_word(artifact) is None:
            raise TransformRefused(
                f"@type {artifact.get(AT_TYPE)!r} names no kind a title is composed from")
        raise TransformRefused("artifact has no usable schema:name to compose a title from")
    return titled, changes


def only_derived_title(before: Any, after: Any) -> Optional[str]:
    """The invariant: every title that moved became the one its own definition composes.

    The walk follows the same path the transform does, definition to declared child, rather than
    descending every dict. A container may declare a child literally named ``title``, and only the
    traversal says whether a key of that name is the JSON Schema keyword or a child's key.
    """

    def definition_difference(old: Any, new: Any, path: str) -> Optional[str]:
        if not isinstance(old, dict) or not isinstance(new, dict):
            return path or "/"
        if set(old) | {"title"} != set(new) | {"title"}:
            return path or "/"
        expected = canonical_title(old)
        children = {name for name, _child, _multiple in container_children(old)}
        for key in set(old) | set(new):
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key == "title":
                if new.get(key) != old.get(key) and new.get(key) != expected:
                    return here
                continue
            if (key in old) != (key in new):
                return here
            if key == "properties" and children \
                    and isinstance(old[key], dict) and isinstance(new[key], dict):
                difference = properties_difference(old, old[key], new[key], here)
                if difference is not None:
                    return difference
                continue
            if type(old[key]) is not type(new[key]) or old[key] != new[key]:
                return here
        return None

    def properties_difference(container: dict, old: dict, new: dict, path: str) -> Optional[str]:
        if set(old) != set(new):
            return path
        multiple_by_name = {name: multiple for name, _child, multiple in container_children(container)}
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name not in multiple_by_name:
                if type(old[name]) is not type(new[name]) or old[name] != new[name]:
                    return here
                continue
            if not multiple_by_name[name]:
                difference = definition_difference(old[name], new[name], here)
                if difference is not None:
                    return difference
                continue
            # A multi-instance child is an array wrapper; only the definition under items may move.
            if not isinstance(old[name], dict) or not isinstance(new[name], dict) \
                    or set(old[name]) != set(new[name]):
                return here
            for key in old[name]:
                there = f"{here}/{rest.json_pointer_component(key)}"
                if key == "items":
                    difference = definition_difference(old[name][key], new[name][key], there)
                    if difference is not None:
                        return difference
                    continue
                if type(old[name][key]) is not type(new[name][key]) or old[name][key] != new[name][key]:
                    return there
        return None

    return definition_difference(before, after, "")


class GuardedBridge:
    """The validation bridge, made safe to call from several workers at once.

    The JVM answers one request at a time over a single pipe, so concurrent callers would interleave
    on it and desynchronise the protocol. Everything expensive about a repair is network latency, and
    validation is about a millisecond against roughly four hundred of round trips, so holding one lock
    across it costs almost nothing while letting the waiting happen in parallel.

    Restarting is guarded by the same lock: a bridge that died takes every in-flight validation with
    it, and only one worker should rebuild it.
    """

    def __init__(self, bridge: audit.ValidationBridge, max_restarts: int):
        self._bridge = bridge
        self._lock = threading.Lock()
        self._max_restarts = max_restarts
        self._restarts = 0

    @property
    def hello(self) -> dict[str, Any]:
        return self._bridge.hello

    @property
    def starts(self) -> int:
        return self._bridge.starts

    def validate(self, kind: str, artifact: Any, template_id: Optional[str] = None) -> dict[str, Any]:
        with self._lock:
            self._ensure_running()
            return self._bridge.validate(kind, artifact, template_id)

    def cache_template(self, template_id: str, template: dict) -> dict[str, Any]:
        with self._lock:
            self._ensure_running()
            return self._bridge.cache_template(template_id, template)

    def _ensure_running(self) -> None:
        if self._bridge.process is not None:
            return
        self._restarts += 1
        if self._restarts > self._max_restarts:
            raise audit.BridgeError(f"bridge failed {self._restarts} times; giving up")
        print(f"! restarting the validation bridge ({self._restarts}/{self._max_restarts})",
              file=sys.stderr)
        self._bridge.start()

    def close(self) -> None:
        with self._lock:
            self._bridge.close()


class GuardedResolver:
    """The template resolver, made safe to share. Its caches are ordinary dicts."""

    def __init__(self, resolver: audit.TemplateResolver):
        self._resolver = resolver
        self._lock = threading.Lock()

    @property
    def unresolved(self) -> dict[str, Any]:
        return self._resolver.unresolved

    def fetch_body(self, template_id: str) -> Optional[dict]:
        with self._lock:
            return self._resolver.fetch_body(template_id)

    def ensure_cached_in_bridge(self, template_id: str) -> bool:
        with self._lock:
            return self._resolver.ensure_cached_in_bridge(template_id)


class TransformRefused(Exception):
    """The artifact is not one this repair can speak for, so it is reported rather than written."""


def identifier_base(artifact: Any) -> str:
    """The deployment's identifier prefix, read from the artifact's own root identifier.

    Deriving it rather than configuring it keeps a repair correct on any deployment, and refuses an
    artifact whose root identifier is not the shape every minted identifier is built from.
    """
    root = artifact.get(AT_ID) if isinstance(artifact, dict) else None
    if not isinstance(root, str) or not rest.is_absolute_iri(root):
        raise TransformRefused("the artifact root has no absolute @id to derive an identifier base from")
    for segment in ROOT_SEGMENTS:
        marker = "/" + segment
        position = root.rfind(marker)
        if position != -1:
            return root[:position + 1]
    raise TransformRefused(f"root @id {root!r} carries no recognised artifact path segment")


def child_id_segment(child: Any) -> str:
    """Element or field, by the same test the server applies before it mints.

    The prefix must say what the child actually is. An element given a field's prefix is never
    repaired afterwards, because the wrong identifier is well formed and no longer temporary.
    """
    at_type = child.get(AT_TYPE) if isinstance(child, dict) else None
    return ELEMENT_SEGMENT if at_type == ELEMENT_AT_TYPE else FIELD_SEGMENT


def is_freshly_minted(value: Any, child: Any, base: str) -> bool:
    expected = base + child_id_segment(child)
    if not isinstance(value, str) or not value.startswith(expected):
        return False
    return bool(UUID_PATTERN.match(value[len(expected):]))


def mint_child_ids(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give every child whose own identifier is unusable a fresh absolute one, at every depth.

    This is what the server does on an ordinary write and cannot do on a verbatim one, which is why
    an artifact carrying such a child refuses the verbatim write a repair needs. Usability is decided
    by the server's own test, so a child it would leave alone is left alone here.

    The replaced value is recorded because minting destroys it and nothing else in the stack keeps
    it. A child that already holds an absolute identifier keeps it, so a second run changes nothing.
    """
    base = identifier_base(artifact)
    minted: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        for name, child, multiple, error in rest.direct_schema_children(container):
            if error or child is None:
                continue
            declared_path = rest.child_path(path, name)
            actual_path = f"{declared_path}/items" if multiple else declared_path
            repaired_child = walk(child, actual_path)
            identifier = repaired_child.get(AT_ID)
            if not rest.server_considers_child_id_usable(identifier):
                fresh = base + child_id_segment(repaired_child) + str(uuid.uuid4())
                minted.append({"path": f"{actual_path}/{rest.json_pointer_component(AT_ID)}",
                               "replaced": identifier, "wrote": fresh,
                               "kind": "element" if child_id_segment(repaired_child) == ELEMENT_SEGMENT
                                       else "field"})
                repaired_child[AT_ID] = fresh
            if multiple:
                result["properties"][name]["items"] = repaired_child
            else:
                result["properties"][name] = repaired_child
        return result

    return walk(copy.deepcopy(artifact), ""), minted


def only_minted_child_ids(before: Any, after: Any) -> Optional[str]:
    """The invariant: the only differences are child identifiers that were unusable and are now correct.

    An identifier the server would have accepted must not move, a minted one must carry the prefix its
    child's type requires, and nothing else in the document may differ.
    """
    base = identifier_base(before)

    def walk(old: Any, new: Any, path: str) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            for name in set(old) | set(new):
                here = f"{path}/{rest.json_pointer_component(name)}"
                present_before, present_after = name in old, name in new
                if name == AT_ID and (not present_before or old.get(name) != new.get(name)):
                    if not present_after:
                        return here
                    if rest.server_considers_child_id_usable(old.get(name)):
                        return here
                    if not is_freshly_minted(new[name], new, base):
                        return here
                    continue
                if present_before != present_after:
                    return here
                difference = walk(old[name], new[name], here)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return None if type(old) is type(new) and old == new else (path or "/")

    return walk(before, after, "")


def context_properties(container: Any) -> Optional[dict]:
    properties = container.get("properties") if isinstance(container, dict) else None
    context = properties.get("@context") if isinstance(properties, dict) else None
    mapping = context.get("properties") if isinstance(context, dict) else None
    return mapping if isinstance(mapping, dict) else None


def mapped_property_iri(mapping: Any) -> tuple[bool, Any]:
    """(present, value) for one child's mapping, where an unusable value is what this repair replaces."""
    if not isinstance(mapping, dict):
        return False, mapping
    values = mapping.get("enum")
    if not isinstance(values, list) or len(values) != 1:
        return False, values
    return True, values[0]


def mint_property_iris(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Replace a child's property IRI where the stored one is present but not an absolute IRI.

    This is the only property-IRI defect the validator rejects, and in production the stored value is
    always the empty string. A mapping that is absent altogether is deliberately out of scope: the
    validator accepts it, and adding one is not the same decision, because the server pairs a new
    mapping with an entry in ``@context.required`` that an existing instance may not satisfy.

    A property IRI is what an instance's own ``@context`` must match, so unlike a child identifier this
    cannot be minted freely. Exclude any artifact whose instances rely on the stored value; the
    ``--exclude-ids`` list exists for that.
    """
    minted: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        mapping = context_properties(result)
        for name, child, multiple, error in rest.direct_schema_children(container):
            if error or child is None:
                continue
            declared_path = rest.child_path(path, name)
            actual_path = f"{declared_path}/items" if multiple else declared_path
            repaired_child = walk(child, actual_path)
            if multiple:
                result["properties"][name]["items"] = repaired_child
            else:
                result["properties"][name] = repaired_child
            if mapping is None:
                continue
            present, value = mapped_property_iri(mapping.get(name))
            if not present or rest.is_absolute_iri(value):
                continue
            fresh = PROPERTY_IRI_PREFIX + str(uuid.uuid4())
            minted.append({
                "path": f"{path}/properties/@context/properties/"
                        f"{rest.json_pointer_component(name)}/enum/0",
                "replaced": value, "wrote": fresh, "child": name})
            mapping[name] = {**mapping[name], "enum": [fresh]}
        return result

    return walk(copy.deepcopy(artifact), ""), minted


def only_minted_property_iris(before: Any, after: Any) -> Optional[str]:
    """The invariant: every difference is one mapping's single enum value, unusable before and minted now."""

    def walk(old: Any, new: Any, path: str, in_enum_of: Optional[str]) -> Optional[str]:
        if isinstance(old, dict):
            if not isinstance(new, dict):
                return path or "/"
            for name in set(old) | set(new):
                here = f"{path}/{rest.json_pointer_component(name)}"
                if (name in old) != (name in new):
                    return here
                nested = name if name == "enum" else in_enum_of
                difference = walk(old[name], new[name], here, nested)
                if difference is not None:
                    return difference
            return None
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path or "/"
            for index, value in enumerate(old):
                difference = walk(value, new[index], f"{path}/{index}", in_enum_of)
                if difference is not None:
                    return difference
            return None
        if type(old) is type(new) and old == new:
            return None
        # The single value of a child's enum may move, and only from unusable to a minted IRI.
        if in_enum_of != "enum" or "/properties/@context/properties/" not in path:
            return path or "/"
        if rest.is_absolute_iri(old):
            return path or "/"
        if not isinstance(new, str) or not new.startswith(PROPERTY_IRI_PREFIX) \
                or not UUID_PATTERN.match(new[len(PROPERTY_IRI_PREFIX):]):
            return path or "/"
        return None

    return walk(before, after, "", None)


# An element occurrence carries its own `@context`, so the complaint names the route to it —
# "/Person/@context/ORCID: ..." — and a pattern anchored on the top-level one selects none of
# those. The repair walks every depth; its pattern has to reach as far.
CONTEXT_ENUM_ERROR = r".*@context/.+: does not have a value in the enumeration"


def instance_context_expectations(container: Any) -> dict[str, str]:
    """What a schema container says each of its children's property IRIs must be."""
    expected: dict[str, str] = {}
    mapping = context_properties(container)
    if not isinstance(mapping, dict):
        return expected
    for name, entry in mapping.items():
        present, value = mapped_property_iri(entry)
        if present and rest.is_absolute_iri(value):
            expected[name] = value
    return expected


UNDECLARED_KEY_ERROR = r"^object instance has properties which are not allowed by the schema"
# The same stray key reads as a type complaint when the template spells `additionalProperties` as a
# schema rather than as `false`: an instance property that is not declared has to match that schema,
# and `bibo:status` holding the string it is reads as "string found, object expected". Located at
# one of the two keys, so a stray property of any other name is still none of this repair's business.
SCHEMA_ONLY_KEY_ERROR = (r"^(?:object instance has properties which are not allowed by the schema"
                         r"|/(?:pav:version|bibo:status): )")
# A records file is searched with `re.match`, which anchors at the start of the message. These
# complaints name their location first — "/Date: object found, array expected" — so a pattern that
# describes only the complaint would select nothing at all.
ARRAY_EXPECTED_ERROR = r".*array expected"
OBJECT_EXPECTED_ERROR = r".*object expected"
VALUE_SHAPE_ERROR = r".*@value"
TYPE_EXPECTED_ERROR = r".*expected"


def carries_a_value(value: Any) -> bool:
    """Conservatively recognize content, including IRI-only values and structural identities.

    Without a declaration an @id cannot safely be classified as merely structural.
    Datatype metadata alone does not make a null literal populated.
    """
    if value in (None, "", [], {}):
        return False
    if isinstance(value, dict):
        return any(carries_a_value(inner) for key, inner in value.items()
                   if key not in {"@type", "@context"})
    if isinstance(value, list):
        return any(carries_a_value(inner) for inner in value)
    return True


def superseded_keys(instance: Any, declared: set[str]) -> dict[str, str]:
    """Duplicate assertions: the same explicit property IRI and the same typed JSON value.

    Equal values under different predicates are independent facts, not evidence of a rename.
    Complex context definitions are deliberately left for an explicit migration.
    """
    if not isinstance(instance, dict):
        return {}
    superseded = {}
    context = instance.get("@context")
    if not isinstance(context, dict):
        return superseded
    for key, value in instance.items():
        if key in declared or key.startswith("@") or ":" in key or not carries_a_value(value):
            continue
        predicate = context.get(key)
        if not rest.is_absolute_iri(predicate):
            continue
        for name in sorted(declared):
            if name in instance and context.get(name) == predicate \
                    and json_equal(instance[name], value):
                superseded[key] = name
                break
    return superseded


def explicitly_empty(value: Any) -> bool:
    """Only shapes that assert no value; never identities, labels or unknown metadata."""
    return value == {} or value == [] or (isinstance(value, dict)
        and set(value) <= {"@value", "@type"} and "@value" in value
        and value["@value"] is None
        and ("@type" not in value or isinstance(value["@type"], str)))


def drop_empty_undeclared_keys(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove empty undeclared top-level slots, preserving attribute-group members."""
    if not isinstance(instance, dict) or not isinstance(template, dict):
        raise TransformRefused("instance and template must be objects")
    declared = set(template.get("properties", {}))
    # Attribute-value groups name sibling fields in a string array. Those dynamic names need
    # not appear in properties: even a null member is still referenced by the group. Preserve
    # every possible reference, including when the group's own declaration is malformed.
    referenced = {name for value in instance.values() if isinstance(value, list)
                  for name in value if isinstance(name, str)}
    result = copy.deepcopy(instance)
    changes = []
    for key, value in instance.items():
        if key in declared or key in referenced or key.startswith("@") or ":" in key \
                or not explicitly_empty(value):
            continue
        del result[key]
        if isinstance(result.get("@context"), dict):
            result["@context"].pop(key, None)
        changes.append({"path": f"/{rest.json_pointer_component(key)}", "replaced": value,
                        "wrote": None})
    return result, changes


def only_dropped_empty_undeclared_keys(before: Any, after: Any, template: Any) -> Optional[str]:
    if not all(isinstance(x, dict) for x in (before, after, template)):
        return "/"
    removed = set(before) - set(after)
    for key in removed:
        if key in template.get("properties", {}) or key.startswith("@") or ":" in key \
                or not explicitly_empty(before[key]):
            return f"/{rest.json_pointer_component(key)}"
        if any(isinstance(value, list) and key in value for value in before.values()):
            return f"/{rest.json_pointer_component(key)}"
    restored = copy.deepcopy(after)
    for key in removed:
        restored[key] = before[key]
    if isinstance(before.get("@context"), dict) and isinstance(restored.get("@context"), dict):
        for key in removed:
            if key in before["@context"]:
                if key in restored["@context"]:
                    return "/@context"
                restored["@context"][key] = before["@context"][key]
    difference = next(differences(before, restored), None)
    return difference[0] if difference else None


def complete_empty_literal(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Add explicit null only to an otherwise empty literal slot whose schema permits null."""
    result = copy.deepcopy(instance)
    changes = []
    def fill(value: Any, definition: dict, path: str) -> Any:
        allowed = definition.get("properties", {}).get("@value", {}).get("type")
        if isinstance(value, dict) and set(value) <= {"@type"} \
                and (allowed == "null" or isinstance(allowed, list) and "null" in allowed):
            value["@value"] = None
            changes.append({"path": path + "/@value", "replaced": None, "wrote": None})
        return value
    return walk_instance(result, template, "", fill), changes


def context_name_used(node: Any, name: str) -> bool:
    """Conservatively retain terms used as keys, compact IRIs or attribute-group members."""
    if isinstance(node, str):
        return node == name or node.startswith(name + ":")
    if isinstance(node, list):
        return any(context_name_used(value, name) for value in node)
    if isinstance(node, dict):
        return any(context_name_used(key, name) or context_name_used(value, name)
                   for key, value in node.items())
    return False


def drop_unused_instance_context(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove only undeclared simple context terms that nothing in their scope references."""
    if not isinstance(instance, dict) or not isinstance(template, dict):
        raise TransformRefused("instance and template must be objects")
    changes = []
    def walk(node: Any, schema: Any, path: str) -> Any:
        if not isinstance(node, dict):
            return node
        result = copy.deepcopy(node)
        context = node.get("@context")
        declared = schema.get("properties", {}).get("@context", {}).get("properties", {})
        if isinstance(context, dict) and isinstance(declared, dict):
            for name, value in context.items():
                if name in declared or name.startswith("@") or ":" in name \
                        or not rest.is_absolute_iri(value):
                    continue
                scope = copy.deepcopy(node)
                del scope['@context'][name]
                if context_name_used(scope, name):
                    continue
                del result['@context'][name]
                changes.append({'path': f'{path}/@context/{rest.json_pointer_component(name)}',
                                'replaced': value, 'wrote': None})
        for name, child, multiple in container_children(schema):
            if not is_element(child) or name not in result:
                continue
            value = result[name]
            here = f'{path}/{rest.json_pointer_component(name)}'
            if multiple and isinstance(value, list):
                result[name] = [walk(item, child, f'{here}/{index}') for index, item in enumerate(value)]
            elif not multiple and isinstance(value, dict):
                result[name] = walk(value, child, here)
        return result
    return walk(instance, template, ''), changes


def only_dropped_unused_context(before: Any, after: Any, template: Any) -> Optional[str]:
    for path, old, new in differences(before, after):
        context_path, _, encoded = path.rpartition('/')
        if not context_path.endswith('/@context') or new is not ABSENT or not rest.is_absolute_iri(old):
            return path or '/'
        name = encoded.replace('~1', '/').replace('~0', '~')
        scope_path = context_path[:-len('/@context')]
        schema = template if not scope_path else declaration_at(template, scope_path)
        if not isinstance(schema, dict) or name.startswith('@') or ':' in name:
            return path
        declared = schema.get('properties', {}).get('@context', {}).get('properties', {})
        if name in declared:
            return path
        scope = copy.deepcopy(before if not scope_path else value_at(before, scope_path))
        if not isinstance(scope, dict) or not isinstance(scope.get('@context'), dict):
            return path
        scope['@context'].pop(name, None)
        if context_name_used(scope, name):
            return path
    return None


def normalized_spaced_orcid(value: Any) -> Optional[str]:
    """Remove accidental space after the ORCID host only when the unchanged iD checksums.

    Checksum: https://support.orcid.org/hc/en-us/articles/360006897674
    This checks format, not registration or ownership. No identifier characters are altered.
    """
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"https://orcid\.org/[ \t]+([0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X])", value)
    if not match:
        return None
    identifier = match.group(1)
    digits = identifier.replace("-", "")
    total = 0
    for digit in digits[:-1]:
        total = (total + int(digit)) * 2
    check = (12 - total % 11) % 11
    if digits[-1] != ("X" if check == 10 else str(check)):
        return None
    return "https://orcid.org/" + identifier


def normalize_instance_orcid_spacing(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    changes = []
    def visit(value: Any, definition: dict, path: str) -> Any:
        if not isinstance(value, dict) or "@id" not in definition.get("properties", {}):
            return value
        wanted = normalized_spaced_orcid(value.get("@id"))
        if wanted is None:
            return value
        changes.append({"path": path + "/@id", "replaced": value["@id"], "wrote": wanted})
        return {**value, "@id": wanted}
    return walk_instance(instance, template, "", visit), changes


def only_normalized_orcid_spacing(before: Any, after: Any, template: Any) -> Optional[str]:
    for path, was, now in differences(before, after):
        definition = declaration_at(template, path.rsplit("/", 1)[0])
        if not path.endswith("/@id") or not definition \
                or "@id" not in definition.get("properties", {}) \
                or normalized_spaced_orcid(was) is None or normalized_spaced_orcid(was) != now:
            return path
    return None


def blank_field_occurrence(value: Any) -> bool:
    """Whether a field occurrence holds nothing: no value, no identifier, no label."""
    if value in ({}, None):
        return True
    if not isinstance(value, dict):
        return False
    keys = set(value) - {AT_TYPE}
    if keys == {"@value"} and value["@value"] is None:
        return True
    if keys and keys <= {"@id", "rdfs:label", "skos:notation"} and not value.get("@id"):
        return True
    return False


def occurrence_lower_bound(container: Any, name: str) -> int:
    """How many occurrences of this child the container's JSON Schema demands.

    A multi-instance child always states a lower bound, and states the model's default of one when
    it names none, so the bound is never absent in practice; the default is applied here for a
    container that somehow omits it.
    """
    declared = (container or {}).get("properties", {}).get(name)
    if not isinstance(declared, dict):
        return 1
    bound = declared.get("minItems")
    return bound if isinstance(bound, int) and bound >= 0 else 1


def compacted_occurrences(value: list, bound: int) -> Optional[list]:
    """Values in their order, then only as many blank occurrences as the bound requires.

    Returns None when the list already has that shape, so a field needing nothing is not rewritten.
    """
    flags = [blank_field_occurrence(item) for item in value]
    if not any(flags) or all(flags):
        return None
    # A blank that stands after every value moves nothing when it is dropped, so a list already in
    # values-then-blanks order is left exactly as it is.
    if flags.index(True) > max(index for index, blank in enumerate(flags) if not blank):
        return None
    values = [item for item, blank in zip(value, flags) if not blank]
    blanks = [item for item, blank in zip(value, flags) if blank]
    wanted = values + blanks[:max(0, bound - len(values))]
    return None if wanted == value else wanted


def compact_blank_occurrences(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Put a multi-instance field's values first and keep only the blanks its bound requires.

    A multi-instance field renders occurrence by occurrence and an occurrence holding nothing is
    omitted, so a blank standing before a value moves every later value down a place: a list stored
    as ``[blank, "audio disc"]`` comes back as ``["audio disc"]``, and the deployment and the
    representation disagree about which occurrence is which. Nothing rejects either form, so the
    disagreement is silent.

    Reordering settles it. Values keep their order, and enough blanks remain to meet the lower bound
    the field declares, which is the shape a round trip already returns — so the stored list and the
    returned list agree from then on.

    Only a list whose blanks stand before a value is touched. Trailing blanks move nothing and are
    left alone. A list of nothing but blanks is left alone too: it states an occurrence count that
    no value contradicts, and emptying it would be a different decision.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, container: Any, path: str) -> Any:
        if not isinstance(node, dict):
            return node
        result = copy.deepcopy(node)
        for name, child, multiple in container_children(container):
            if name not in result:
                continue
            here = f"{path}/{rest.json_pointer_component(name)}"
            value = result[name]
            if is_element(child):
                if isinstance(value, list):
                    result[name] = [walk(item, child, f"{here}/{index}")
                                    for index, item in enumerate(value)]
                elif isinstance(value, dict):
                    result[name] = walk(value, child, here)
                continue
            if not multiple or not isinstance(value, list):
                continue
            wanted = compacted_occurrences(value, occurrence_lower_bound(container, name))
            if wanted is None:
                continue
            result[name] = wanted
            changes.append({"path": here, "replaced": len(value), "wrote": len(wanted),
                            "keptValues": sum(1 for item in wanted
                                              if not blank_field_occurrence(item))})
        return result

    return walk(instance, template, ""), changes


def only_compacted_blank_occurrences(before: Any, after: Any, template: Any) -> Optional[str]:
    """Every difference lies inside one multi-instance field list rewritten to the shape above.

    A difference is resolved to the list that encloses it, because a reordering that keeps the
    length reports element by element rather than as one whole-list change. That list is then
    re-derived from the stored one — the values it must keep, in their stored order, followed by
    the blanks its bound requires — so a value altered, reordered or dropped fails this, as does
    any change outside such a list.
    """
    for path, _was, _now in differences(before, after):
        parts = path.split("/")
        accounted = False
        for depth in range(len(parts), 1, -1):
            prefix = "/".join(parts[:depth])
            stored = value_at(before, prefix)
            if not isinstance(stored, list):
                continue
            container = declaration_at(template, "/".join(parts[:depth - 1])) \
                if depth > 2 else template
            name = parts[depth - 1]
            if container is None:
                continue
            declared = (container.get("properties") or {}).get(name)
            if not isinstance(declared, dict) or declared.get("type") != "array":
                continue
            wanted = compacted_occurrences(stored, occurrence_lower_bound(container, name))
            if wanted is None or wanted != value_at(after, prefix):
                return path
            accounted = True
            break
        if not accounted:
            return path
    return None


def only_completed_empty_literals(before: Any, after: Any, template: Any) -> Optional[str]:
    for path, was, now in differences(before, after):
        if not path.endswith("/@value") or was is not ABSENT or now is not None:
            return path
        parent = path.rsplit("/", 1)[0]
        previous = value_at(before, parent)
        definition = declaration_at(template, parent)
        allowed = (definition or {}).get("properties", {}).get("@value", {}).get("type")
        if not isinstance(previous, dict) or not set(previous) <= {"@type"} \
                or not (allowed == "null" or isinstance(allowed, list) and "null" in allowed):
            return path
    return None


def drop_superseded_instance_keys(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove an instance key the template no longer declares and whose value it carries elsewhere.

    Both names must map explicitly to the same property IRI and carry identical values.
    Value equality alone cannot establish the history or meaning of a field.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    declared = {name for name, _child, _multiple in container_children(template)}
    result = copy.deepcopy(instance)
    changes: list[dict[str, Any]] = []
    for key, name in superseded_keys(instance, declared).items():
        del result[key]
        changes.append({"path": f"/{rest.json_pointer_component(key)}", "replaced": key,
                        "wrote": None, "supersededBy": name})
        context = result.get("@context")
        if isinstance(context, dict) and key in context:
            del context[key]
    return result, changes


def only_dropped_superseded_keys(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: a key went only where its value stays under a name the template declares."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return "/"
    declared = {name for name, _child, _multiple in container_children(template)} \
        if isinstance(template, dict) else set()
    droppable = superseded_keys(before, declared)
    for key in set(before) | set(after):
        here = f"/{rest.json_pointer_component(key)}"
        if key == "@context":
            continue
        if key in before and key not in after:
            if key not in droppable:
                return here
            twin = droppable[key]
            if not json_equal(after.get(twin), before[key]):
                return here          # the value did not in fact survive
            continue
        if (key in before) != (key in after):
            return here
        if not json_equal(before[key], after[key]):
            return here
    old_context = before.get("@context")
    new_context = after.get("@context")
    if isinstance(old_context, dict) and isinstance(new_context, dict):
        expected = {k: v for k, v in old_context.items()
                    if not (k in droppable and k not in after)}
        if not json_equal(new_context, expected):
            return "/@context"
    elif not json_equal(old_context, new_context):
        return "/@context"
    return None
# Confirmed renames, keyed by template IRI then by the key an instance carries. Supplied by the
# operator through --mapping, because nothing in the artifacts says which old name became which new
# one: a rename is a fact about the template's history, and only its owner holds that.
RENAMES: dict[str, dict[str, str]] = {}


# Keys `ModelNodeNames` allows at the top of a schema artifact and not at the top of an instance.
# A template states its version and publication status; an instance of it does not have either, and
# the meta-schema admits no property it does not declare, so one that carries them cannot validate.
# Confined to the two seen in production: `schema:schemaVersion`, `pav:previousVersion` and `_ui`
# are equally schema-only, and would be removed only on the same decision being taken about them.
SCHEMA_ONLY_INSTANCE_KEYS = frozenset({"pav:version", "bibo:status"})


def drop_schema_keys_from_instance(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove artifact-level keys an instance may not carry.

    ``pav:version`` and ``bibo:status`` belong to the artifact that declares a shape, not to one that
    fills it in: a template is drafted and published and versioned, an instance simply is. Where they
    appear on an instance they were copied from the template that made it, and they carry nothing
    about the instance that is true.
    """
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    result = copy.deepcopy(instance)
    changes: list[dict[str, Any]] = []
    # A handful of templates render with these among the properties an instance must carry. Where a
    # template demands one, removing it is what breaks the instance, so the demand wins.
    demanded = template.get("required") if isinstance(template, dict) else None
    demanded = set(demanded) if isinstance(demanded, list) else set()
    for key in SCHEMA_ONLY_INSTANCE_KEYS:
        if key not in result or key in demanded:
            continue
        changes.append({"path": f"/{rest.json_pointer_component(key)}",
                        "replaced": result[key], "wrote": None})
        del result[key]
        context = result.get("@context")
        if isinstance(context, dict) and key in context:
            del context[key]
    return result, changes


def only_dropped_schema_keys(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: only the artifact-level keys went, and nothing else moved."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return "/"
    demanded = template.get("required") if isinstance(template, dict) else None
    demanded = set(demanded) if isinstance(demanded, list) else set()
    for key in set(before) | set(after):
        here = f"/{rest.json_pointer_component(key)}"
        if key in before and key not in after:
            if key not in SCHEMA_ONLY_INSTANCE_KEYS or key in demanded:
                return here
            continue
        if key == "@context":
            continue
        if (key in before) != (key in after):
            return here
        if before[key] != after[key] or type(before[key]) is not type(after[key]):
            return here
    old_context = before.get("@context")
    new_context = after.get("@context")
    if isinstance(old_context, dict) and isinstance(new_context, dict):
        expected = {k: v for k, v in old_context.items()
                    if not (k in SCHEMA_ONLY_INSTANCE_KEYS and k not in after)}
        if new_context != expected:
            return "/@context"
    elif old_context != new_context:
        return "/@context"
    return None


def declared_multiplicity(template: Any) -> dict[str, bool]:
    """Whether each declared child holds one value or a list of them."""
    return {name: multiple for name, _child, multiple in container_children(template)}


def chosen_source(instance: Any, sources: list[str]) -> Optional[str]:
    """Which of several old keys mapped to one field supplies the value.

    Exactly one source may carry content. A rename mapping does not authorize choosing
    between competing values, even when those values compare equal.
    """
    populated = [source for source in sources
                 if source in instance and carries_a_value(instance[source])]
    if len(populated) > 1:
        raise TransformRefused("multiple populated rename sources require an explicit value decision: "
                               + ", ".join(populated))
    return populated[0] if populated else None


def path_head(path: str) -> tuple[str, Optional[str]]:
    """Split a mapping path into the key it names here and whatever it names further in.

    A path names the route through the template down to the key being ruled on: every segment but
    the last is a name the template declares, and the last is the key an instance carries there.
    Segments are separated by ``/`` and each is escaped the way a JSON Pointer component is, ``~1``
    for a ``/`` in the name itself and ``~0`` for a ``~``. A path of one segment names a key at the
    top of the instance, which is every mapping written before nesting was supported.
    """
    head, separator, tail = path.partition("/")
    return head.replace("~1", "/").replace("~0", "~"), (tail if separator else None)


def split_mapping(mapping: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Separate a level's own renames from the ones addressed inside one of its children."""
    here: dict[str, Any] = {}
    deeper: dict[str, dict[str, Any]] = {}
    for path, target in mapping.items():
        head, tail = path_head(path)
        if tail is None:
            here[head] = target
        else:
            deeper.setdefault(head, {})[tail] = target
    return here, deeper


def renamed_container(node: Any, definition: Any, mapping: dict[str, Any], path: str,
                      changes: list[dict[str, Any]]) -> Any:
    """Apply one level of a rename mapping to a container instance, then settle its children.

    This level is settled before anything inside it, so a child is reached under the name the
    container declares rather than the one the instance happened to file it under. That is what
    lets a mapping path name the route through the template.
    """
    if not isinstance(node, dict):
        return node
    here, deeper = split_mapping(mapping)
    declarations = {name: (child, multiple) for name, child, multiple in container_children(definition)}
    multiplicity = {name: multiple for name, (_child, multiple) in declarations.items()}
    declared = set(declarations)
    iris = declared_context_iris(definition)
    result = copy.deepcopy(node)

    targets: dict[str, list[str]] = {}
    for old, new in here.items():
        if new is not None:
            targets.setdefault(new, []).append(old)

    # A mapping to null says the key is not to be carried anywhere: the container dropped the field
    # and the operator has decided the value goes with it.
    for old, new in here.items():
        if new is not None or old not in result or old in declared:
            continue
        del result[old]
        changes.append({"path": f"{path}/{rest.json_pointer_component(old)}", "replaced": old,
                        "wrote": None, "discarded": [old]})
        context = result.get("@context")
        if isinstance(context, dict) and old in context:
            del context[old]
    for new, sources in targets.items():
        present = [s for s in sources if s in result]
        if not present or new not in declared or any(s in declared for s in present):
            continue
        if new in result and carries_a_value(result[new]):
            continue                      # the field already holds a value; never overwrite one
        supplier = chosen_source(result, present)
        value = result[supplier] if supplier else result[present[0]]
        if multiplicity.get(new) and not isinstance(value, list):
            value = [value]
        elif not multiplicity.get(new) and isinstance(value, list):
            # A field that used to repeat and now holds one value: a list of nought or one says the
            # same thing either way, so it is unwrapped. A longer one does not, and is refused.
            if len(value) > 1:
                raise TransformRefused(
                    f"{path}/{present[0]} holds {len(value)} values and {new!r} takes one; which "
                    "survives is not this repair's to decide")
            value = value[0] if value else empty_instance_value(declarations[new][0], False)
        for source in present:
            del result[source]
            context = result.get("@context")
            if isinstance(context, dict) and source in context:
                del context[source]
        result[new] = value
        changes.append({"path": f"{path}/{rest.json_pointer_component(present[0])}",
                        "replaced": supplier or present[0], "wrote": new,
                        "discarded": [s for s in present if s != (supplier or present[0])]})
        context = result.get("@context")
        if isinstance(context, dict) and new not in context and new in iris:
            context[new] = iris[new]

    # Now that this level answers to the names the container declares, each child that has renames
    # of its own is settled against its own declaration. Doing it in this order is what lets a path
    # name the route through the template: every segment but the last is a declared name.
    for segment, submapping in deeper.items():
        entry = declarations.get(segment)
        if segment not in result or entry is None or not is_element(entry[0]):
            continue
        child_definition = entry[0]
        child_path = f"{path}/{rest.json_pointer_component(segment)}"
        value = result[segment]
        if isinstance(value, list):
            result[segment] = [renamed_container(item, child_definition, submapping,
                                                 f"{child_path}/{index}", changes)
                               for index, item in enumerate(value)]
        else:
            result[segment] = renamed_container(value, child_definition, submapping, child_path,
                                                changes)
    return result


def rename_instance_keys(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Carry an instance's values over to the names its template now declares.

    A template edited after its instances were written leaves them naming a field the template no
    longer has, and the schema admits no property it does not declare, so the instance stops
    validating however complete it is. The value is not in question — only what it is filed under.

    The mapping is supplied, never inferred: which old name became which new one is a fact about an
    edit nobody recorded, and guessing it would move a value into a field that means something else.
    A key is moved only where the container declares the new name and does not declare the old one.
    A mapping to ``null`` removes the key instead, which is the answer where the field was dropped
    rather than renamed and the value is not wanted.

    A rename reaches inside an element. Renaming an element moves the whole occurrence across, and
    its own children are then answerable to what the new declaration names, so a mapping key can
    address a key inside one. ``DataCite Title/titleLanguage`` names the key ``titleLanguage`` as an
    instance carries it inside the element the template declares as ``DataCite Title``, whether the
    instance reached that element by a rename or was always filed there. Every segment but the last
    is a declared name, so a path reads as the route through the template.

    Two shapes need care. A field the template declares as repeating takes a list, so a single value
    moving into one is wrapped. A field that used to repeat and now holds one value has its list
    unwrapped, but only where the list holds nought or one: a longer one is refused, since which
    element survives is not this repair's to decide. And where several old keys map to one
    field, at most one source may be populated. Competing populated sources are refused.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    based_on = instance.get("schema:isBasedOn")
    mapping = RENAMES.get(based_on) if isinstance(based_on, str) else None
    if not mapping:
        return copy.deepcopy(instance), []
    changes: list[dict[str, Any]] = []
    return renamed_container(instance, template, mapping, "", changes), changes


def occurrence_fault(before: Any, after: Any, definition: Any, submapping: dict[str, Any],
                     path: str) -> Optional[str]:
    """Compare a child's occurrences, allowing only what a sub-mapping accounts for."""
    if isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            return path
        for index, (was, now) in enumerate(zip(before, after)):
            fault = occurrence_fault(was, now, definition, submapping, f"{path}/{index}")
            if fault is not None:
                return fault
        return None
    if submapping and isinstance(before, dict) and isinstance(after, dict):
        return renamed_container_fault(before, after, definition, submapping, path)
    if before != after or type(before) is not type(after):
        return path
    return None


def renamed_container_fault(before: Any, after: Any, definition: Any, mapping: dict[str, Any],
                            path: str) -> Optional[str]:
    """Where one level of the rename did something the mapping does not account for.

    The check follows the transform's own traversal rather than descending everything it finds, so a
    child whose name collides with a JSON Schema keyword is read as the child it is.
    """
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None if before == after and type(before) is type(after) else (path or "/")
    here, deeper = split_mapping(mapping)
    declarations = ({name: (child, multiple) for name, child, multiple in container_children(definition)}
                    if isinstance(definition, dict) else {})
    multiplicity = {name: multiple for name, (_child, multiple) in declarations.items()}
    iris = declared_context_iris(definition) if isinstance(definition, dict) else {}
    targets: dict[str, list[str]] = {}
    for old, new in here.items():
        if new is not None:
            targets.setdefault(new, []).append(old)
    dropped = {old for old, new in here.items()
               if new is None and old in before and old not in after}

    moved: dict[str, list[str]] = {}
    for new, sources in targets.items():
        present = [s for s in sources if s in before]
        if present and all(s not in after for s in present) and new in after:
            moved[new] = present

    # A key that moved carries its supplier's value, settled inside by whatever sub-mapping the
    # supplier's own path names, and wrapped or unwrapped to the arity the target declares.
    for new, present in moved.items():
        if new in before and carries_a_value(before[new]):
            return f"{path}/{rest.json_pointer_component(new)}"
        try:
            supplier = chosen_source(before, present) or present[0]
        except TransformRefused:
            return f"{path}/{rest.json_pointer_component(new)}"
        submapping = deeper.get(new, {})
        child_definition = declarations.get(new, ({}, False))[0]
        expected = before[supplier]
        here_path = f"{path}/{rest.json_pointer_component(new)}"
        value = after[new]
        if multiplicity.get(new) and not isinstance(expected, list):
            if not isinstance(value, list) or len(value) != 1:
                return here_path
            value = value[0]
        elif not multiplicity.get(new) and isinstance(expected, list):
            if len(expected) > 1:
                return here_path
            if not expected:
                continue           # an empty list became the model's shape for absence
            expected = expected[0]
        fault = occurrence_fault(expected, value, child_definition, submapping, here_path)
        if fault is not None:
            return fault

    # A child that stayed where it is may still have been settled inside, and nothing else may move.
    surrendered = {s for sources in moved.values() for s in sources} | dropped
    for key in set(before) | set(after):
        if key == "@context" or key in surrendered or key in moved:
            continue
        here_path = f"{path}/{rest.json_pointer_component(key)}"
        if (key in before) != (key in after):
            return here_path
        submapping = deeper.get(key)
        if submapping:
            child_definition = declarations.get(key, ({}, False))[0]
            fault = occurrence_fault(before[key], after[key], child_definition, submapping, here_path)
            if fault is not None:
                return fault
            continue
        if before[key] != after[key] or type(before[key]) is not type(after[key]):
            return here_path
    old_context = before.get("@context")
    new_context = after.get("@context")
    if isinstance(old_context, dict) and isinstance(new_context, dict):
        expected_context = {k: v for k, v in old_context.items() if k not in surrendered}
        for new in moved:
            if new in iris:
                expected_context.setdefault(new, iris[new])
        if new_context != expected_context:
            return f"{path}/@context"
    elif old_context != new_context:
        return f"{path}/@context"
    return None


def only_renamed_instance_keys(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: the mapped keys went, one of their values survives under the declared name.

    A mapping may explicitly delete a key with null. A many-to-one rename must not discard
    competing populated sources or overwrite a populated destination.
    """
    if not isinstance(before, dict) or not isinstance(after, dict):
        return "/"
    based_on = before.get("schema:isBasedOn")
    mapping = RENAMES.get(based_on) or {}
    fault = renamed_container_fault(before, after, template, mapping, "")
    return fault if fault != "" else "/"


ELEMENT_INSTANCE_BASE = "https://repo.metadatacenter.org/template-element-instances/"
MISSING_CHILD_ERROR = r"^object has missing required properties"


def declared_context_iris(definition: Any) -> dict[str, str]:
    """What property IRI a container says each of its children's ``@context`` entry must equal."""
    properties = definition.get("properties") if isinstance(definition, dict) else None
    context = properties.get("@context") if isinstance(properties, dict) else None
    mapped = context.get("properties") if isinstance(context, dict) else None
    if not isinstance(mapped, dict):
        return {}
    iris = {}
    for name, entry in mapped.items():
        values = entry.get("enum") if isinstance(entry, dict) else None
        if isinstance(values, list) and values and isinstance(values[0], str):
            iris[name] = values[0]
    return iris


def empty_instance_value(definition: Any, multiple: bool, minimum: int = 0) -> Any:
    """What an instance carries for a child it holds no value for.

    The model has a shape for absence and every CEDAR editor writes it: an empty list where a child
    may repeat, ``{"@value": null}`` where the value is a literal, and ``{}`` where it is an IRI,
    since ``@id: null`` is not legal JSON-LD. An element is not empty in the same way — it is a
    container whose own children are each empty — so it is built out rather than left blank.

    A numeric or temporal field carries its datatype even when it carries no value, because CEDAR
    renders both with ``@type`` among the properties the value must have. That is what the model's
    own `EmptyFieldInstances` builds, down to the defaults it falls back on when the field names
    neither: ``xsd:decimal`` for a numeric field, ``xsd:dateTime`` for a temporal one.

    A repeating child carries as many empty occurrences as its declaration demands. A container that
    states ``minItems`` is saying an instance must hold at least that many, and an empty list does
    not satisfy it however empty the field is.
    """
    if multiple:
        return [empty_instance_value(definition, False) for _ in range(max(0, minimum))]
    if is_element(definition):
        return completed_element({}, definition)
    properties = definition.get("properties") if isinstance(definition, dict) else None
    if isinstance(properties, dict) and "@value" in properties:
        empty: dict[str, Any] = {"@value": None}
        if demands_value_type(definition):
            datatype = declared_value_type(definition)
            if datatype is not None:
                empty["@type"] = datatype
        return empty
    return {}


def is_element(definition: Any) -> bool:
    if not isinstance(definition, dict):
        return False
    at_type = definition.get(AT_TYPE)
    return isinstance(at_type, str) and at_type == rest.TEMPLATE_ELEMENT


def completed_element(value: Any, definition: Any) -> Any:
    """An element instance with every declared child present and its own identity stated."""
    node = dict(value) if isinstance(value, dict) else {}
    if not isinstance(node.get("@id"), str):
        node["@id"] = f"{ELEMENT_INSTANCE_BASE}{uuid.uuid4()}"
    iris = declared_context_iris(definition)
    context = dict(node["@context"]) if isinstance(node.get("@context"), dict) else {}
    declarations = definition.get("properties") if isinstance(definition, dict) else {}
    for name, child, multiple in container_children(definition):
        # A static field renders in the form and holds nothing, so it is not a property of an
        # instance and has no empty form to write. The model says so itself: `EmptyFieldInstances`
        # refuses one outright and tells the caller to skip the child before asking.
        if isinstance(child, dict) and child.get(AT_TYPE) == STATIC_AT_TYPE:
            continue
        if name not in node:
            declared = declarations.get(name) if isinstance(declarations, dict) else None
            minimum = declared.get("minItems") if isinstance(declared, dict) else None
            node[name] = empty_instance_value(
                child, multiple, minimum if isinstance(minimum, int) else 0)
        else:
            node[name] = completed_value(node[name], child, multiple)
        if name in iris and name not in context:
            context[name] = iris[name]
    node["@context"] = context
    return node


def completed_value(value: Any, definition: Any, multiple: bool) -> Any:
    """Complete whatever an instance already holds, without touching a value it states.

    A value that is not the shape its definition calls for is left exactly as it stands. Production
    holds element occurrences written as bare strings, and replacing one with a built-out element
    would discard the only content there is: that is a malformed value, which is a different defect
    from an absent one and not this repair's to decide.
    """
    if multiple:
        if not isinstance(value, list):
            return value
        return [completed_value(item, definition, False) for item in value]
    if is_element(definition) and isinstance(value, dict):
        return completed_element(value, definition)
    return value


def complete_instance(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give an instance the shape its template declares, with nothing filled in.

    A CEDAR instance states every field its template declares, carrying the model's shape for absence
    where it holds no value. An instance written before a field was added, or before one was made
    required, simply lacks the key, and the library reads that as a missing required property rather
    than as an empty field. Adding the empty shape says exactly what is true — that there is no value
    — and is what the server itself writes when it completes an instance against its template.

    No value already present is touched, at any depth. An element gains the ``@id`` the model requires
    of it and the ``@context`` entries its own container maps, since an element instance carries both.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    before = json.dumps(instance, sort_keys=True)
    completed = completed_element(instance, template)
    # The instance's own identity is its own, not an element's: never mint one here.
    if isinstance(instance.get("@id"), str):
        completed["@id"] = instance["@id"]
    elif "@id" not in instance:
        completed.pop("@id", None)
    changes: list[dict[str, Any]] = []
    if json.dumps(completed, sort_keys=True) != before:
        for path in added_paths(instance, completed, ""):
            changes.append({"path": path, "replaced": None, "wrote": "empty"})
    return completed, changes


def added_paths(old: Any, new: Any, path: str) -> Iterator[str]:
    """Every place the completion put something where the instance had nothing."""
    if isinstance(old, dict) and isinstance(new, dict):
        for key in new:
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key not in old:
                yield here
            else:
                yield from added_paths(old[key], new[key], here)
    elif isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        for index, value in enumerate(old):
            yield from added_paths(value, new[index], f"{path}/{index}")


def only_completed_absences(before: Any, after: Any, template: Any) -> Optional[str]:
    """Permit only declared empty children, missing context terms and fresh element identities."""
    def same(old: Any, new: Any, path: str) -> Optional[str]:
        difference = next(differences(old, new, path), None)
        return difference[0] if difference is not None else None

    def empty(value: Any, definition: dict, multiple: bool, minimum: int,
              path: str) -> Optional[str]:
        if multiple:
            if not isinstance(value, list) or len(value) != max(0, minimum):
                return path
            for index, item in enumerate(value):
                fault = empty(item, definition, False, 0, f"{path}/{index}")
                if fault is not None:
                    return fault
            return None
        if is_element(definition):
            return container({}, value, definition, path, False)
        properties = definition.get("properties", {})
        expected = {"@value": None} if "@value" in properties else {}
        if "@value" in properties and demands_value_type(definition):
            datatype = declared_value_type(definition)
            if datatype is not None:
                expected["@type"] = datatype
        return same(expected, value, path)

    def container(old: Any, new: Any, definition: dict, path: str, root: bool) -> Optional[str]:
        if not isinstance(old, dict) or not isinstance(new, dict):
            return same(old, new, path)
        children = {name: (child, multiple) for name, child, multiple in container_children(definition)
                    if child.get(AT_TYPE) != STATIC_AT_TYPE}
        iris = declared_context_iris(definition)
        for name in set(old) | set(new):
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name not in new:
                return here
            if name == "@context":
                previous = old.get(name, {})
                current = new[name]
                if not isinstance(previous, dict) or not isinstance(current, dict):
                    fault = same(previous, current, here)
                else:
                    expected = {**{k: v for k, v in iris.items() if k in children}, **previous}
                    fault = same(expected, current, here)
            elif name not in old:
                if name == "@id" and not root:
                    ident = new[name]
                    fault = None if isinstance(ident, str) and ident.startswith(ELEMENT_INSTANCE_BASE) \
                        and UUID_PATTERN.fullmatch(ident[len(ELEMENT_INSTANCE_BASE):]) else here
                elif name in children:
                    child, multiple = children[name]
                    declaration = definition.get("properties", {}).get(name, {})
                    minimum = declaration.get("minItems", 0)
                    fault = empty(new[name], child, multiple,
                                  minimum if isinstance(minimum, int) else 0, here)
                else:
                    fault = here
            elif name in children and is_element(children[name][0]):
                child, multiple = children[name]
                was, now = old[name], new[name]
                if multiple and isinstance(was, list):
                    if not isinstance(now, list) or len(was) != len(now):
                        return here
                    fault = None
                    for index, (a, b) in enumerate(zip(was, now)):
                        fault = container(a, b, child, f"{here}/{index}", False)
                        if fault is not None:
                            break
                elif not multiple and isinstance(was, dict):
                    fault = container(was, now, child, here, False)
                else:
                    fault = same(was, now, here)
            else:
                fault = same(old[name], new[name], here)
            if fault is not None:
                return fault
        return None

    if not isinstance(template, dict):
        return "/"
    return container(before, after, template, "", True)


def align_instance_context_iris(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Rewrite an instance's ``@context`` property IRIs to the ones its template names.

    An instance's ``@context`` maps its field names to property IRIs, and the template is the authority
    for what those are: the mapping is derived from the template rather than authored on the instance,
    and the instance's own content is its field values. Where the two disagree the instance carries a
    value from before some template edit, and its siblings usually already carry the current one.

    Only a name the template maps is touched, so JSON-LD prefixes and system keys are left alone, and
    only where the template's own value is usable. Element occurrences are walked against the element
    definition they belong to, at every depth.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, container: Any, path: str) -> Any:
        if not isinstance(node, dict):
            return node
        result = copy.deepcopy(node)
        context = result.get("@context")
        if isinstance(context, dict):
            for name, wanted in instance_context_expectations(container).items():
                if name in context and context[name] != wanted:
                    changes.append({
                        "path": f"{path}/@context/{rest.json_pointer_component(name)}",
                        "replaced": context[name], "wrote": wanted, "child": name})
                    context[name] = wanted
        for name, child, multiple, error in rest.direct_schema_children(container):
            if error or child is None or child.get("@type") != ELEMENT_AT_TYPE:
                continue
            value = result.get(name)
            here = f"{path}/{rest.json_pointer_component(name)}"
            if isinstance(value, list):
                result[name] = [walk(item, child, f"{here}/{index}") for index, item in enumerate(value)]
            elif isinstance(value, dict):
                result[name] = walk(value, child, here)
        return result

    return walk(copy.deepcopy(instance), template, ""), changes


def only_aligned_context_iris(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every difference is a mapped ``@context`` value now equal to the template's own.

    Anything the template does not map, and any value that already agreed with it, must be untouched.
    """
    if not isinstance(template, dict):
        return "/"

    def walk(old: Any, new: Any, container: Any, path: str) -> Optional[str]:
        if not isinstance(old, dict):
            return None if type(old) is type(new) and old == new else (path or "/")
        if not isinstance(new, dict):
            return path or "/"
        expected = instance_context_expectations(container) if isinstance(container, dict) else {}
        elements = {}
        if isinstance(container, dict):
            for name, child, _multiple, error in rest.direct_schema_children(container):
                if not error and child is not None and child.get("@type") == ELEMENT_AT_TYPE:
                    elements[name] = child
        for name in set(old) | set(new):
            here = f"{path}/{rest.json_pointer_component(name)}"
            if (name in old) != (name in new):
                return here
            if name == "@context":
                difference = context_difference(old[name], new[name], expected, here)
                if difference is not None:
                    return difference
                continue
            if name in elements:
                difference = walk_children(old[name], new[name], elements[name], here)
                if difference is not None:
                    return difference
                continue
            if type(old[name]) is not type(new[name]) or old[name] != new[name]:
                return here
        return None

    def walk_children(old: Any, new: Any, child: Any, path: str) -> Optional[str]:
        if isinstance(old, list):
            if not isinstance(new, list) or len(old) != len(new):
                return path
            for index, item in enumerate(old):
                difference = walk(item, new[index], child, f"{path}/{index}")
                if difference is not None:
                    return difference
            return None
        return walk(old, new, child, path)

    def context_difference(old: Any, new: Any, expected: dict[str, str], path: str) -> Optional[str]:
        if not isinstance(old, dict) or not isinstance(new, dict) or set(old) != set(new):
            return path
        for name, value in old.items():
            if value == new[name] and type(value) is type(new[name]):
                continue
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name not in expected or new[name] != expected[name]:
                return here
        return None

    return walk(before, after, template, "")


@dataclass(frozen=True)
class Repair:
    name: str
    condition: str
    summary: str
    transform: Callable[..., tuple[Any, list[dict[str, Any]]]]
    invariant: Callable[..., Optional[str]]
    # A repair of an instance may need the template it names, for both halves.
    needs_template: bool = False
    # Some defects are a validator complaint rather than an inventory condition, and are selected by it.
    error_pattern: Optional[str] = None
    # The inventory counts a defect at the root apart from the same defect on a nested definition, so
    # a repair that reaches both is named by more than one condition.
    also_conditions: tuple[str, ...] = ()

    @property
    def conditions(self) -> tuple[str, ...]:
        return (self.condition, *self.also_conditions) if self.condition else self.also_conditions


# --------------------------------------------------------------------------------------------------
# Instance value shapes
#
# An instance value is answerable to the field that declares it, and a handful of defects are simply
# the wrong shape rather than the wrong content: a typed literal with no datatype, one value where
# the template declares a list, a list of one where it declares a value, and the model's form for
# absence written as the other kind's. Each is settled by reading the declaration, so none of them
# needs an owner.
# --------------------------------------------------------------------------------------------------

ABSENT = object()


def differences(before: Any, after: Any, path: str = "") -> Iterator[tuple[str, Any, Any]]:
    """Every place two documents differ, as a pointer and the pair of values.

    An invariant built on this cannot overlook a change: the walk visits the union of both
    documents, so a key added, removed or altered at any depth is reported whether or not the rule
    being checked expected to find anything there.
    """
    if isinstance(before, dict) and isinstance(after, dict):
        for key in set(before) | set(after):
            here = f"{path}/{rest.json_pointer_component(key)}"
            if key not in before or key not in after:
                yield here, before.get(key, ABSENT), after.get(key, ABSENT)
            else:
                yield from differences(before[key], after[key], here)
    elif isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            yield path, before, after
        else:
            for index, (was, now) in enumerate(zip(before, after)):
                yield from differences(was, now, f"{path}/{index}")
    elif before != after or type(before) is not type(after):
        yield path, before, after


def json_equal(before: Any, after: Any) -> bool:
    """JSON equality that does not equate nested booleans and numbers."""
    return next(differences(before, after), None) is None


def declaration_at(template: Any, pointer: str) -> Optional[dict]:
    """The declaration governing an instance location, or ``None`` where the path leaves the schema.

    List indices are stepped over, since an occurrence answers to the same declaration as its
    siblings. A segment naming a model keyword ends the walk: below that point the pointer is inside
    a value rather than in the tree of declarations.
    """
    definition = template
    for segment in [s for s in pointer.split("/") if s]:
        name = segment.replace("~1", "/").replace("~0", "~")
        if name.isdigit():
            continue
        if name.startswith("@") or name in RESERVED_INSTANCE_KEYS:
            return None
        found = None
        for child_name, child, _multiple in container_children(definition):
            if child_name == name:
                found = child
                break
        if found is None:
            return None
        definition = found
    return definition if isinstance(definition, dict) else None


# Keys an instance carries that belong to the artifact rather than to a declared field.
RESERVED_INSTANCE_KEYS = frozenset({
    "@context", "@id", "@type", "@value", "schema:isBasedOn", "schema:name", "schema:description",
    "pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy", "pav:derivedFrom",
    "_annotations", "rdfs:label",
})

# What a field's own declaration says an instance value's `@type` must be. The model's defaults are
# `EmptyFieldInstances` in cedar-artifact-library: a numeric field with no `numberType` is
# `xsd:decimal`, a temporal field with no `temporalType` is `xsd:dateTime`.
NUMERIC_DEFAULT_TYPE = "xsd:decimal"
TEMPORAL_DEFAULT_TYPE = "xsd:dateTime"


def declared_value_type(definition: Any) -> Optional[str]:
    """The datatype an instance value must state, where its field pins one.

    Only numeric and temporal fields carry one. CEDAR renders both with `@type` in the field's own
    `required` array, so an instance that omits it does not validate however empty the field is.
    """
    if not isinstance(definition, dict):
        return None
    input_type = (definition.get("_ui") or {}).get("inputType")
    constraints = definition.get("_valueConstraints") or {}
    if input_type == "numeric":
        value = constraints.get("numberType")
        return value if isinstance(value, str) and value else NUMERIC_DEFAULT_TYPE
    if input_type == "temporal":
        value = constraints.get("temporalType")
        return value if isinstance(value, str) and value else TEMPORAL_DEFAULT_TYPE
    return None


def demands_value_type(definition: Any) -> bool:
    """Whether the field's rendered schema lists ``@type`` among the properties it requires."""
    required = definition.get("required") if isinstance(definition, dict) else None
    return isinstance(required, list) and "@type" in required


def instance_field_children(container: Any) -> Iterator[tuple[str, dict, bool]]:
    """The children a container declares that hold a value rather than another container."""
    for name, child, multiple in container_children(container):
        if not is_element(child):
            yield name, child, multiple


def walk_instance(node: Any, container: Any, path: str,
                  visit) -> Any:
    """Rebuild an instance, letting ``visit`` settle each declared field value it holds.

    ``visit`` is handed one occurrence with the declaration that governs it and returns what should
    stand there. Element occurrences are walked against the element they belong to, so the rule
    reaches every depth, and a child the instance does not carry is left absent: putting one there
    is completion's job, not this walk's.
    """
    if not isinstance(node, dict):
        return node
    result = copy.deepcopy(node)
    for name, child, multiple in container_children(container):
        if name not in result:
            continue
        here = f"{path}/{rest.json_pointer_component(name)}"
        value = result[name]
        if is_element(child):
            if isinstance(value, list):
                result[name] = [walk_instance(item, child, f"{here}/{index}", visit)
                                for index, item in enumerate(value)]
            elif isinstance(value, dict):
                result[name] = walk_instance(value, child, here, visit)
            continue
        if isinstance(value, list):
            result[name] = [visit(item, child, f"{here}/{index}") for index, item in enumerate(value)]
        else:
            result[name] = visit(value, child, here)
    return result


def stamp_instance_value_type(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give a typed literal the datatype its field declares.

    A numeric or temporal field renders with ``@type`` among the properties its instance value must
    carry, and CEDAR's own editor writes the datatype the field declares — ``xsd:decimal`` for a
    numeric field that names none, ``xsd:dateTime`` for a temporal one. A value written before that
    was enforced states only ``@value``, and the library reads it as a missing required property
    however complete the field is.

    Only an absent ``@type`` is written. One already stated is left alone even where it disagrees
    with the declaration: that is a value someone chose, and correcting it is not this repair's to
    decide.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def visit(value: Any, definition: Any, path: str) -> Any:
        wanted = declared_value_type(definition)
        if wanted is None or not demands_value_type(definition):
            return value
        if not isinstance(value, dict) or "@type" in value:
            return value
        settled = dict(value)
        settled["@type"] = wanted
        changes.append({"path": f"{path}/@type", "replaced": None, "wrote": wanted})
        return settled

    return walk_instance(instance, template, "", visit), changes


def only_stamped_value_types(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every change is an absent ``@type`` gaining the datatype its field declares."""
    if not isinstance(template, dict):
        return "/"
    for path, was, now in differences(before, after):
        if not path.endswith("/@type") or was is not ABSENT:
            return path or "/"
        definition, _where = declaration_for_value(template, path)
        if definition is None or not demands_value_type(definition):
            return path
        if now != declared_value_type(definition) or not isinstance(now, str):
            return path
    return None


def declaration_for_value(template: Any, pointer: str) -> tuple[Optional[dict], str]:
    """The declaration governing an instance value, and the pointer to the value itself.

    A change inside a value is reported at the key that moved — ``/age/@value`` or
    ``/Species/rdfs:label`` rather than the field itself — and a repeating field puts an index
    between the value and its name, so both are stepped over to reach the declaration that governs
    what sits there.

    The longest route that resolves is the one taken, rather than a fixed list of keys to strip. A
    container may declare a child named for a model keyword, and assuming such a segment is always
    part of a value would read that child as something else.
    """
    parts = [s for s in pointer.split("/") if s]
    while True:
        value_pointer = "/" + "/".join(parts) if parts else ""
        found = declaration_at(template, value_pointer)
        if found is not None or not parts:
            return found, value_pointer
        parts.pop()


def child_declaration_at(template: Any, pointer: str) -> tuple[Optional[dict], bool]:
    """The declaration a pointer's last segment names, and whether it is declared as repeating."""
    head, _sep, tail = pointer.rpartition("/")
    name = tail.replace("~1", "/").replace("~0", "~")
    parent = declaration_at(template, head) if head else template
    if not isinstance(parent, dict):
        return None, False
    for child_name, child, multiple in container_children(parent):
        if child_name == name:
            return child, multiple
    return None, False


def wrap_instance_occurrence(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Put a lone occurrence in the list its template declares.

    A child the template declares as repeating takes a JSON array whether it holds one occurrence or
    several, and an instance written while the field held a single value carries the occurrence bare.
    The content is not in question: the same occurrence, in the list the declaration calls for.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, container: Any, path: str) -> Any:
        if not isinstance(node, dict):
            return node
        result = copy.deepcopy(node)
        for name, child, multiple in container_children(container):
            if name not in result:
                continue
            here = f"{path}/{rest.json_pointer_component(name)}"
            value = result[name]
            if multiple and not isinstance(value, list):
                result[name] = value = [value]
                changes.append({"path": here, "replaced": "one value", "wrote": "a list of one"})
            if not is_element(child):
                continue
            if isinstance(value, list):
                result[name] = [walk(item, child, f"{here}/{index}")
                                for index, item in enumerate(value)]
            elif isinstance(value, dict):
                result[name] = walk(value, child, here)
        return result

    return walk(instance, template, ""), changes


def only_wrapped_occurrences(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every change is one occurrence becoming a list holding exactly it."""
    if not isinstance(template, dict):
        return "/"
    for path, was, now in differences(before, after):
        if was is ABSENT or now is ABSENT:
            return path or "/"
        if not isinstance(now, list) or len(now) != 1 or now[0] != was:
            return path or "/"
        if type(now[0]) is not type(was):
            return path or "/"
        _declaration, multiple = child_declaration_at(template, path)
        if not multiple:
            return path or "/"
    return None


def unwrap_instance_occurrence(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Take a lone occurrence out of a list its template does not declare as one.

    A child the template declares as holding one value takes the occurrence itself, and a list of
    one says exactly what the bare occurrence says. A longer list does not: which of several
    survives is a decision, so a list holding more than one is left as it stands rather than being
    cut down. An empty list is the model's form for absence under a repeating declaration, and
    becomes this field's own form for absence.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, container: Any, path: str) -> Any:
        if not isinstance(node, dict):
            return node
        result = copy.deepcopy(node)
        for name, child, multiple in container_children(container):
            if name not in result:
                continue
            here = f"{path}/{rest.json_pointer_component(name)}"
            value = result[name]
            if not multiple and isinstance(value, list) and len(value) <= 1:
                settled = value[0] if value else empty_instance_value(child, False)
                result[name] = value = settled
                changes.append({"path": here, "replaced": f"a list of {len(value) if isinstance(value, list) else 1}",
                                "wrote": "one value"})
            if not is_element(child):
                continue
            if isinstance(value, list):
                result[name] = [walk(item, child, f"{here}/{index}")
                                for index, item in enumerate(value)]
            elif isinstance(value, dict):
                result[name] = walk(value, child, here)
        return result

    return walk(instance, template, ""), changes


def only_unwrapped_occurrences(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every change is a list of nought or one becoming what it held."""
    if not isinstance(template, dict):
        return "/"
    for path, was, now in differences(before, after):
        if was is ABSENT or now is ABSENT or not isinstance(was, list) or len(was) > 1:
            return path or "/"
        declaration, multiple = child_declaration_at(template, path)
        if declaration is None or multiple:
            return path or "/"
        expected = was[0] if was else empty_instance_value(declaration, False)
        if now != expected or type(now) is not type(expected):
            return path or "/"
    return None


def holds_a_literal(definition: Any) -> bool:
    """Whether the field's rendered schema gives its instance value a ``@value``."""
    properties = definition.get("properties") if isinstance(definition, dict) else None
    return isinstance(properties, dict) and "@value" in properties


def settle_instance_empty_shape(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write an absent value in the form its own field takes.

    The model has two forms for absence and they are not interchangeable: ``{"@value": null}`` where
    the field holds a literal, ``{}`` where it holds an IRI, since ``@id: null`` is not legal
    JSON-LD. A field that changed from one kind to the other, or an instance built by something that
    knew only one form, carries the wrong one, and the rendered schema admits only its own — so the
    instance fails on a value that says nothing either way.

    Three shapes are settled and no others: an empty object where the field holds a literal, a null
    literal where it holds an IRI, and a null ``@id``. Each says the field is empty and each is
    replaced by the other way of saying exactly that, so nothing can be lost. A value carrying
    anything at all is left as it stands, including where its shape disagrees with the declaration:
    moving content between the two forms is a different repair and a larger claim.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def visit(value: Any, definition: Any, path: str) -> Any:
        if not isinstance(value, dict):
            return value
        if holds_a_literal(definition):
            if value != {}:
                return value
            settled: dict[str, Any] = {"@value": None}
            if demands_value_type(definition):
                datatype = declared_value_type(definition)
                if datatype is not None:
                    settled["@type"] = datatype
        else:
            if value not in ({"@value": None}, {"@id": None}):
                return value
            settled = {}
        changes.append({"path": path, "replaced": json.dumps(value, sort_keys=True),
                        "wrote": json.dumps(settled, sort_keys=True)})
        return settled

    return walk_instance(instance, template, "", visit), changes


def only_settled_empty_shapes(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every change replaces one stated absence with the form its field takes."""
    if not isinstance(template, dict):
        return "/"
    settled: set[str] = set()
    for path, _was, _now in differences(before, after):
        definition, here = declaration_for_value(template, path)
        if here in settled:
            continue
        if definition is None or is_element(definition):
            return path or "/"
        old_value, new_value = value_at(before, here), value_at(after, here)
        if holds_a_literal(definition):
            wanted: Any = {"@value": None}
            if demands_value_type(definition) and declared_value_type(definition) is not None:
                wanted["@type"] = declared_value_type(definition)
            if old_value != {} or new_value != wanted:
                return path or "/"
        else:
            if old_value not in ({"@value": None}, {"@id": None}) or new_value != {}:
                return path or "/"
        settled.add(here)
    return None


def value_at(document: Any, pointer: str) -> Any:
    """What a document holds at a pointer, or ``None`` where the path does not reach."""
    current = document
    for segment in [s for s in pointer.split("/") if s]:
        name = segment.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            if not name.isdigit() or int(name) >= len(current):
                return None
            current = current[int(name)]
        elif isinstance(current, dict):
            if name not in current:
                return None
            current = current[name]
        else:
            return None
    return current


def pinned_context_value(entry: Any) -> Any:
    """The single value a ``@context`` schema entry allows, where it allows exactly one.

    A term is pinned in one of two shapes. A prefix or a property IRI is a string with a
    one-value ``enum``. A JSON-LD term definition is a small object — ``{"@type": "xsd:string"}``
    for a literal, ``{"@type": "@id"}`` for a reference — whose own properties are each pinned the
    same way. Anything else leaves the instance a choice, and a choice is not the template's to make
    on its behalf.
    """
    if not isinstance(entry, dict):
        return ABSENT
    values = entry.get("enum")
    if isinstance(values, list) and len(values) == 1 and isinstance(values[0], str):
        return values[0]
    if entry.get("type") != "object":
        return ABSENT
    mapped = entry.get("properties")
    if not isinstance(mapped, dict) or not mapped:
        return ABSENT
    built = {}
    for name, inner in mapped.items():
        value = pinned_context_value(inner)
        if value is ABSENT:
            return ABSENT
        built[name] = value
    return built


def required_context_entries(container: Any) -> dict[str, Any]:
    """Each ``@context`` entry a container requires and pins to a single value.

    An instance's ``@context`` carries the prefix declarations the model uses and the JSON-LD term
    definitions for its own provenance, as well as a property IRI per declared field. The template
    states all of them: what it requires, and what each may be. Where it admits exactly one value,
    the entry is the template's to supply rather than the instance's.
    """
    properties = container.get("properties") if isinstance(container, dict) else None
    context = properties.get("@context") if isinstance(properties, dict) else None
    if not isinstance(context, dict):
        return {}
    required = context.get("required")
    mapped = context.get("properties")
    if not isinstance(required, list) or not isinstance(mapped, dict):
        return {}
    wanted = {}
    for name in required:
        value = pinned_context_value(mapped.get(name))
        if value is not ABSENT:
            wanted[name] = value
    return wanted


def complete_instance_context(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Give an instance the ``@context`` entries its template requires and states.

    A template requires certain terms in an instance's ``@context`` and pins each to a single
    permitted IRI: the prefixes the model itself uses, and a property IRI per declared field. An
    instance written before a term was required simply lacks it, and no amount of content makes up
    for it, because the schema names it as a missing required property.

    Only an entry the template pins to one value is written, and only where the instance has none.
    An entry already there is left alone even where it differs — reconciling that is what
    ``align-instance-context-iris`` is for, and the two are separate so that adding a term never
    quietly rewrites one.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, container: Any, path: str) -> Any:
        if not isinstance(node, dict):
            return node
        result = copy.deepcopy(node)
        context = result.get("@context")
        if isinstance(context, dict):
            for name, wanted in required_context_entries(container).items():
                if name not in context:
                    context[name] = wanted
                    changes.append({"path": f"{path}/@context/{rest.json_pointer_component(name)}",
                                    "replaced": None, "wrote": wanted})
        for name, child, _multiple in container_children(container):
            if not is_element(child) or name not in result:
                continue
            here = f"{path}/{rest.json_pointer_component(name)}"
            value = result[name]
            if isinstance(value, list):
                result[name] = [walk(item, child, f"{here}/{index}")
                                for index, item in enumerate(value)]
            elif isinstance(value, dict):
                result[name] = walk(value, child, here)
        return result

    return walk(instance, template, ""), changes


def only_added_context_entries(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every change adds a ``@context`` term the template requires and pins."""
    if not isinstance(template, dict):
        return "/"
    for path, was, now in differences(before, after):
        head, _sep, name = path.rpartition("/")
        if was is not ABSENT or not head.endswith("/@context"):
            return path or "/"
        container = declaration_at(template, head[: -len("/@context")]) or template
        wanted = required_context_entries(container)
        term = name.replace("~1", "/").replace("~0", "~")
        if term not in wanted or now != wanted[term]:
            return path or "/"
    return None


def literal_json_types(definition: Any) -> set[str]:
    """The JSON types a field's rendered schema allows its ``@value`` to take."""
    properties = definition.get("properties") if isinstance(definition, dict) else None
    entry = properties.get("@value") if isinstance(properties, dict) else None
    declared = entry.get("type") if isinstance(entry, dict) else None
    if isinstance(declared, str):
        return {declared}
    if isinstance(declared, list):
        return {t for t in declared if isinstance(t, str)}
    return set()


def restated_literal(value: Any, allowed: set[str]) -> Any:
    """The same literal written as the schema's own JSON type, or ``ABSENT`` where it cannot be.

    A number and the digits that spell it are the same literal, and CEDAR's rendered schema pins
    which of the two an instance carries. The restatement has to survive a round trip: a string
    becomes a number only where writing that number back gives the string it came from, so nothing
    is rounded, re-based or silently normalised on the way.
    """
    if isinstance(value, bool) or value is None:
        return ABSENT
    if isinstance(value, str) and "string" not in allowed and {"number", "integer"} & allowed:
        text = value.strip()
        if text != value:
            return ABSENT
        try:
            number: Any = int(text)
        except ValueError:
            try:
                number = float(text)
            except ValueError:
                return ABSENT
        if "integer" in allowed and "number" not in allowed and not isinstance(number, int):
            return ABSENT
        return number if str(number) == text else ABSENT
    if isinstance(value, (int, float)) and "string" in allowed \
            and not {"number", "integer"} & allowed:
        return str(value)
    return ABSENT


def restate_instance_literal(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Write a literal as the JSON type its field's schema states.

    CEDAR renders a numeric field's ``@value`` as a JSON number in some templates and as the string
    that spells it in others, following what the field declares, and an instance written against one
    rendering does not validate against the other. The content is the same literal either way; only
    its JSON type differs.

    The restatement must survive a round trip, so ``"826"`` becomes ``826`` and ``826`` becomes
    ``"826"``, while ``"LSJDK=1213"``, ``"007"`` and ``"1e3"`` are left exactly as they are. A value
    that cannot be restated without changing what it says is not this repair's to change.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def visit(value: Any, definition: Any, path: str) -> Any:
        if not isinstance(value, dict) or "@value" not in value:
            return value
        allowed = literal_json_types(definition)
        if not allowed:
            return value
        restated = restated_literal(value["@value"], allowed)
        if restated is ABSENT:
            return value
        settled = dict(value)
        settled["@value"] = restated
        changes.append({"path": f"{path}/@value", "replaced": value["@value"], "wrote": restated})
        return settled

    return walk_instance(instance, template, "", visit), changes


def only_restated_literals(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every change restates one literal as its schema's type, saying the same thing."""
    if not isinstance(template, dict):
        return "/"
    for path, was, now in differences(before, after):
        if not path.endswith("/@value") or was is ABSENT or now is ABSENT:
            return path or "/"
        definition, _where = declaration_for_value(template, path)
        if definition is None:
            return path or "/"
        if restated_literal(was, literal_json_types(definition)) != now:
            return path or "/"
        # The two must spell each other: a restatement that does not round-trip is a different value.
        if str(was).strip() != str(now).strip():
            return path or "/"
    return None


def instance_static_names(container: Any) -> set[str]:
    """The children a container declares that render nothing and hold nothing."""
    return {name for name, child, _multiple in container_children(container)
            if isinstance(child, dict) and child.get(AT_TYPE) == STATIC_AT_TYPE}


def drop_static_field_from_instance(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Remove a static field an instance was given.

    A static field is a heading, a break or a block of rich text: it renders in the form and holds
    nothing, so it is not a property of an instance and CEDAR's editor writes none. Where an
    instance carries one it was copied from the template that made it, and the rendered schema
    demands of it a ``_content`` the instance has no business holding, so it cannot validate.

    The key goes whether or not it holds anything. A static field has no instance representation at
    all, so text found under one is not a value in a field — it is content with nowhere in the model
    to live, and no edit to the instance can give it one. Where such content is discarded the change
    record states it, and the stored body is kept, so the loss is visible and reversible rather than
    silent.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def walk(node: Any, container: Any, path: str) -> Any:
        if not isinstance(node, dict):
            return node
        result = copy.deepcopy(node)
        for name in instance_static_names(container):
            if name not in result:
                continue
            here = f"{path}/{rest.json_pointer_component(name)}"
            discarded = (json.dumps(result[name], sort_keys=True)[:200]
                         if carries_a_value(result[name]) else None)
            changes.append({"path": here, "replaced": name, "wrote": None,
                            **({"discarded": discarded} if discarded else {})})
            del result[name]
            context = result.get("@context")
            if isinstance(context, dict) and name in context:
                del context[name]
        for name, child, _multiple in container_children(container):
            if not is_element(child) or name not in result:
                continue
            here = f"{path}/{rest.json_pointer_component(name)}"
            value = result[name]
            if isinstance(value, list):
                result[name] = [walk(item, child, f"{here}/{index}")
                                for index, item in enumerate(value)]
            elif isinstance(value, dict):
                result[name] = walk(value, child, here)
        return result

    return walk(instance, template, ""), changes


def only_dropped_static_fields(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: every change removes an empty key the template declares as a static field."""
    if not isinstance(template, dict):
        return "/"
    for path, was, now in differences(before, after):
        if now is not ABSENT or was is ABSENT:
            return path or "/"
        head, _sep, tail = path.rpartition("/")
        name = tail.replace("~1", "/").replace("~0", "~")
        if head.endswith("/@context"):
            # The term maps the name to its property IRI; it goes with the key, not with content.
            container = declaration_at(template, head[: -len("/@context")]) or template
        else:
            container = declaration_at(template, head) if head else template
        if not isinstance(container, dict) or name not in instance_static_names(container):
            return path or "/"
    return None


def settle_instance_iri_value(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Take an ``@value`` out of a field whose schema admits only an IRI.

    A controlled-term field holds ``@id`` and a label, and its rendered schema names no ``@value`` at
    all, so an instance carrying one does not validate however ordinary the content looks. Three
    shapes say nothing the field cannot say properly: a ``@value`` holding nothing, one holding an
    absolute IRI where the value states no ``@id``, and one repeating the ``@id`` already there.

    Only those are settled. A ``@value`` holding a term's label — ``"Tatum, J. L."`` — is left
    exactly as it stands: the label alone does not determine the IRI, resolving it means asking the
    terminology the field is constrained to, and inventing one would say the instance points at a
    term nobody chose.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    changes: list[dict[str, Any]] = []

    def visit(value: Any, definition: Any, path: str) -> Any:
        if not isinstance(value, dict) or holds_a_literal(definition) or "@value" not in value:
            return value
        held = value.get("@value")
        settled = {key: inner for key, inner in value.items() if key != "@value"}
        if held in (None, ""):
            wrote = "the empty form the field takes"
        elif isinstance(held, str) and rest.is_absolute_iri(held.strip()) and not value.get("@id"):
            settled["@id"] = held.strip()
            wrote = "the same IRI, stated as @id"
        elif isinstance(held, str) and value.get("@id") == held.strip():
            wrote = "nothing; the IRI was already stated"
        else:
            return value          # a label, or free text: where it belongs is not settled here
        changes.append({"path": f"{path}/@value", "replaced": held, "wrote": wrote})
        return settled

    return walk_instance(instance, template, "", visit), changes


def only_settled_iri_values(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: an ``@value`` only ever goes, and only where the IRI it held is kept."""
    if not isinstance(template, dict):
        return "/"
    seen: set[str] = set()
    for path, _was, _now in differences(before, after):
        definition, here = declaration_for_value(template, path)
        if here in seen:
            continue
        if definition is None or is_element(definition) or holds_a_literal(definition):
            return path or "/"
        old, new = value_at(before, here), value_at(after, here)
        if not isinstance(old, dict) or not isinstance(new, dict) or "@value" in new:
            return path or "/"
        expected = {key: inner for key, inner in old.items() if key != "@value"}
        held = old.get("@value")
        if isinstance(held, str) and held.strip() and rest.is_absolute_iri(held.strip()) \
                and not old.get("@id"):
            expected["@id"] = held.strip()
        elif held not in (None, "") and not (isinstance(held, str)
                                             and old.get("@id") == held.strip()):
            return path or "/"    # content went that this repair does not speak for
        if new != expected:
            return path or "/"
        seen.add(here)
    return None


# The term each label in a controlled field resolves to, keyed by template IRI, then by the route to
# the field, then by the label an instance carries. Supplied through --terms, never inferred: a label
# does not determine an IRI, and the answer comes from asking the terminology the field is
# constrained to. A mapping to ``null`` says the label states no value, which is what "NA" means.
TERMS: dict[str, dict[str, dict[str, Any]]] = {}


def settle_instance_term_label(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Put a controlled field's value behind the term its label names.

    A controlled-term field holds ``@id`` and a label, and an instance that carries the label alone —
    under ``@value``, where the schema admits none — names a term without pointing at it. The term is
    supplied rather than inferred: which IRI a label names is a fact about the ontology the field is
    constrained to, and the table is built by asking it.

    A label the table maps to nothing is emptied instead. That is what a field holding ``"NA"`` says:
    not a term, but that there is none, and the model already has a form for saying so.
    """
    if not isinstance(template, dict):
        raise TransformRefused("the template this instance names could not be read")
    if not isinstance(instance, dict):
        raise TransformRefused("artifact is not a JSON object")
    based_on = instance.get("schema:isBasedOn")
    fields = TERMS.get(based_on) if isinstance(based_on, str) else None
    if not fields:
        return copy.deepcopy(instance), []
    changes: list[dict[str, Any]] = []

    def visit(value: Any, definition: Any, path: str) -> Any:
        if not isinstance(value, dict) or holds_a_literal(definition):
            return value
        if "@value" not in value or value.get("@id"):
            return value
        label = value.get("@value")
        if not isinstance(label, str):
            return value
        # The walk numbers a repeating field's occurrences; the table speaks about the field.
        route = re.sub(r"/\d+(?=/|$)", "", path)
        known = fields.get(route)
        if not known or label.strip() not in known:
            return value
        term = known[label.strip()]
        settled = {key: inner for key, inner in value.items() if key != "@value"}
        if term is None:
            wrote = "nothing; the label stated no value"
        else:
            settled["@id"] = term["@id"]
            settled["rdfs:label"] = term["rdfs:label"]
            wrote = term["@id"]
        changes.append({"path": path, "replaced": label, "wrote": wrote})
        return settled

    return walk_instance(instance, template, "", visit), changes


def only_settled_term_labels(before: Any, after: Any, template: Any) -> Optional[str]:
    """The invariant: a label only ever becomes the term the table names for it, or absence."""
    if not isinstance(template, dict) or not isinstance(before, dict):
        return "/"
    based_on = before.get("schema:isBasedOn")
    fields = TERMS.get(based_on) if isinstance(based_on, str) else {}
    seen: set[str] = set()
    for path, _was, _now in differences(before, after):
        definition, here = declaration_for_value(template, path)
        if here in seen:
            continue
        if definition is None or is_element(definition) or holds_a_literal(definition):
            return path or "/"
        old, new = value_at(before, here), value_at(after, here)
        if not isinstance(old, dict) or not isinstance(new, dict):
            return path or "/"
        label = old.get("@value")
        route = re.sub(r"/\d+(?=/|$)", "", here)
        known = (fields or {}).get(route) or {}
        if not isinstance(label, str) or label.strip() not in known:
            return path or "/"
        term = known[label.strip()]
        expected = {key: inner for key, inner in old.items() if key != "@value"}
        if term is not None:
            expected["@id"] = term["@id"]
            expected["rdfs:label"] = term["rdfs:label"]
        if new != expected:
            return path or "/"
        seen.add(here)
    return None


# Fields an operator has decided should hold free text rather than a term, keyed by template IRI.
# Supplied through --free-fields, never inferred: whether a field was meant to be controlled is a
# decision about what the template means, and only its owner can take it.
FREE_FIELDS: dict[str, list[str]] = {}

# What a controlled-term field's instance value may carry, and what a free-text one may.
CONTROLLED_VALUE_PROPERTIES = ("@id",)
TERM_CONSTRAINT_KEYS = ("ontologies", "branches", "classes", "valueSets")


def free_controlled_field(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Let a named field hold free text instead of a term.

    A controlled-term field renders with ``@id`` among the properties its instance value may carry
    and no ``@value`` at all, so an instance holding a label rather than a term cannot validate. Where
    the terminology has no term for what people are actually writing, the field was never really
    controlled, and the template is what needs changing.

    Two things move together, because either alone leaves the field incoherent: the value's shape
    loses ``@id`` and gains ``@value``, and the constraint loses the ontologies, branches, classes
    and value sets it named. Everything else the field declares is untouched, including its
    identifier, its label and whether it is required.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    wanted = FREE_FIELDS.get(artifact.get(AT_ID) or "") or []
    if not wanted:
        return copy.deepcopy(artifact), []
    result = copy.deepcopy(artifact)
    changes: list[dict[str, Any]] = []
    declarations = result.get("properties")
    if not isinstance(declarations, dict):
        raise TransformRefused("the artifact declares no properties")
    for name in wanted:
        entry = declarations.get(name)
        holder = entry.get("items") if isinstance(entry, dict) and "items" in entry else entry
        if not isinstance(holder, dict):
            continue
        properties = holder.get("properties")
        if not isinstance(properties, dict) or "@value" in properties:
            continue          # already free text; saying so twice is not a change
        properties.pop("@id", None)
        properties["@value"] = {"type": ["string", "null"]}
        required = holder.get("required")
        if isinstance(required, list):
            holder["required"] = [r for r in required if r != "@id"]
        constraints = holder.get("_valueConstraints")
        if isinstance(constraints, dict):
            for key in TERM_CONSTRAINT_KEYS:
                if constraints.get(key):
                    constraints[key] = []
        changes.append({"path": f"/properties/{rest.json_pointer_component(name)}",
                        "replaced": "a controlled term", "wrote": "free text"})
    return result, changes


def only_freed_controlled_fields(before: Any, after: Any) -> Optional[str]:
    """The invariant: only the named fields changed, and only from a term to free text."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return "/"
    wanted = set(FREE_FIELDS.get(before.get(AT_ID) or "") or [])
    for path, was, now in differences(before, after):
        parts = [p.replace("~1", "/").replace("~0", "~") for p in path.split("/") if p]
        if len(parts) < 2 or parts[0] != "properties" or parts[1] not in wanted:
            return path or "/"
        inside = parts[2:]
        # Only three places may move, and each only in the one direction the repair states.
        if inside[:1] == ["items"]:
            inside = inside[1:]
        if inside[:1] == ["properties"] and inside[1:] == ["@id"]:
            if now is not ABSENT:
                return path
        elif inside[:1] == ["properties"] and inside[1:] == ["@value"]:
            if was is not ABSENT or now != {"type": ["string", "null"]}:
                return path
        elif inside[:1] == ["required"]:
            if not isinstance(now, list) or "@id" in now or was is ABSENT:
                return path
        elif inside[:1] == ["_valueConstraints"] and inside[1:2] and inside[1] in TERM_CONSTRAINT_KEYS:
            if now != []:
                return path
        else:
            return path
    return None


# Fields an operator has decided a template should declare, keyed by template IRI. Supplied through
# --declare-fields, never inferred: instances carry keys a template does not declare for two quite
# different reasons, and only its owner knows which applies. Where the key is a field that was
# renamed, the answer is a rename; where the field was added to the instances and never to the
# template, the answer is to declare it, and that is what this carries out.
#
# Each declaration names the field, what it holds, whether it may repeat, and the two identifiers it
# will be written under. The identifiers are stated rather than minted so that the file says exactly
# what will be written and a second run changes nothing.
DECLARED_FIELDS: dict[str, list[dict[str, Any]]] = {}

DECLARATION_KEYS = {"name", "description", "kind", "multiple", "classes", "propertyIri", "fieldId"}
LITERAL_VALUE_PROPERTIES = {"@value", "@type", "rdfs:label"}


def field_model(declarations: dict, kind: str) -> Optional[dict]:
    """A field this template already declares of the kind wanted, to take the boilerplate from.

    A field declaration carries more than the decision behind it: a ``@context`` block, a schema
    version, provenance, the shape its value may take. Copying a sibling keeps the new field
    consistent with the template it joins rather than with whatever the tool was written against.
    The choice is by name so that it does not depend on key order.
    """
    for name in sorted(k for k in declarations if isinstance(declarations.get(k), dict)):
        entry = declarations[name]
        holder = entry.get("items") if "items" in entry else entry
        if not isinstance(holder, dict) or holder.get(AT_TYPE) != FIELD_AT_TYPE:
            continue
        properties = holder.get("properties")
        if not isinstance(properties, dict):
            continue
        controlled = "@id" in properties and "@value" not in properties
        if (kind == "iri") == controlled:
            return holder
    return None


def declared_field(model: dict, declaration: dict) -> dict:
    """One field declaration, built from a sibling's boilerplate and this declaration's decision."""
    field = copy.deepcopy(model)
    field[AT_ID] = declaration["fieldId"]
    field["schema:name"] = declaration["name"]
    field["schema:description"] = declaration.get("description") or ""
    field["title"] = f"{declaration['name']} field schema"
    field["description"] = f"{declaration['name']} field schema"
    field.pop("skos:prefLabel", None)
    field.pop("skos:altLabel", None)
    if declaration["kind"] == "iri":
        field["_valueConstraints"] = {"requiredValue": False, "ontologies": [], "valueSets": [],
                                      "classes": copy.deepcopy(declaration.get("classes") or []),
                                      "branches": [], "multipleChoice": False}
    else:
        field["_valueConstraints"] = {"requiredValue": False}
    return field


def declare_instance_field(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Declare a field the template's instances already carry.

    An instance may hold a key its template never declared, and the template's own
    ``additionalProperties`` decides what happens next: it admits a plain literal and nothing else,
    so a key holding a term, or a list, cannot validate however the instance is written. Where the
    field is real and only the template is behind, declaring it is the repair.

    A declared field is required to be present, so every instance of the template gains the key,
    including the ones that validate today. Those hold it empty, which ``complete-instance`` writes,
    and they must be repaired in the same campaign or the template change leaves them invalid.
    """
    if not isinstance(artifact, dict):
        raise TransformRefused("artifact is not a JSON object")
    wanted = DECLARED_FIELDS.get(artifact.get(AT_ID) or "") or []
    if not wanted:
        return copy.deepcopy(artifact), []
    result = copy.deepcopy(artifact)
    declarations = result.get("properties")
    if not isinstance(declarations, dict):
        raise TransformRefused("the artifact declares no properties")
    context = declarations.get("@context")
    if not isinstance(context, dict) or not isinstance(context.get("properties"), dict):
        raise TransformRefused("the artifact declares no @context properties")
    required = result.get("required")
    if not isinstance(required, list):
        raise TransformRefused("the artifact states no required properties")
    interface = result.get("_ui")
    if not isinstance(interface, dict) or not isinstance(interface.get("order"), list):
        raise TransformRefused("the artifact states no field order")
    changes: list[dict[str, Any]] = []
    for declaration in wanted:
        if not isinstance(declaration, dict) or not DECLARATION_KEYS.issuperset(declaration):
            raise TransformRefused("a declaration names something this repair does not write")
        for key in ("name", "kind", "propertyIri", "fieldId"):
            if not declaration.get(key):
                raise TransformRefused(f"a declaration states no {key}")
        if declaration["kind"] not in ("iri", "literal"):
            raise TransformRefused("a declaration states a kind that is neither iri nor literal")
        name = declaration["name"]
        if name in declarations:
            continue          # already declared; saying so twice is not a change
        model = field_model(declarations, declaration["kind"])
        if model is None:
            raise TransformRefused(f"the template declares no {declaration['kind']} field to follow")
        field = declared_field(model, declaration)
        declarations[name] = ({"type": "array", "minItems": 1, "items": field}
                              if declaration.get("multiple") else field)
        context["properties"][name] = {"enum": [declaration["propertyIri"]]}
        required.append(name)
        interface["order"].append(name)
        for place, value in (("propertyLabels", name),
                             ("propertyDescriptions", declaration.get("description") or "")):
            if isinstance(interface.get(place), dict):
                interface[place][name] = value
        wrote = "a controlled field" if declaration["kind"] == "iri" else "a free-text field"
        changes.append({"path": f"/properties/{rest.json_pointer_component(name)}",
                        "replaced": None, "wrote": wrote})
    return result, changes


def only_declared_fields(before: Any, after: Any) -> Optional[str]:
    """The invariant: the named fields were declared, and nothing the template already said moved."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return "/"
    wanted = [d for d in (DECLARED_FIELDS.get(before.get(AT_ID) or "") or [])
              if isinstance(d, dict) and d.get("name")
              and d["name"] not in (before.get("properties") or {})]
    names = [d["name"] for d in wanted]
    by_name = {d["name"]: d for d in wanted}
    if len(set(names)) != len(names):
        return "/properties"
    for path, was, now in differences(before, after):
        parts = [p.replace("~1", "/").replace("~0", "~") for p in path.split("/") if p]
        if parts[:1] == ["properties"] and parts[1:2] and parts[1] in by_name and len(parts) == 2:
            if was is not ABSENT or not isinstance(now, dict):
                return path
        elif parts[:3] == ["properties", "@context", "properties"] and len(parts) == 4:
            declaration = by_name.get(parts[3])
            if declaration is None or was is not ABSENT \
                    or now != {"enum": [declaration["propertyIri"]]}:
                return path
        elif parts == ["required"]:
            if not isinstance(was, list) or now != was + names:
                return path
        elif parts == ["_ui", "order"]:
            if not isinstance(was, list) or now != was + names:
                return path
        elif parts[:2] in (["_ui", "propertyLabels"], ["_ui", "propertyDescriptions"]) \
                and len(parts) == 3 and parts[2] in by_name:
            if was is not ABSENT:
                return path
        else:
            return path or "/"
    return None


SCHEMA_CONTEXT_TYPES = frozenset(
    "https://schema.metadatacenter.org/core/" + name
    for name in ("Template", "TemplateElement", "TemplateField", "StaticTemplateField")
)
BIBO_NAMESPACE = "http://purl.org/ontology/bibo/"


def schema_context_nodes(node: Any, path: str = "") -> Iterator[tuple[str, dict]]:
    """Visit only schema declarations, never instance-context property schemas or annotations."""
    if not isinstance(node, dict):
        return
    if node.get("type") == "array":
        yield from schema_context_nodes(node.get("items"), path + "/items")
        return
    types = node.get("@type")
    types = types if isinstance(types, list) else [types]
    if not any(isinstance(t, str) and t in SCHEMA_CONTEXT_TYPES for t in types):
        return
    yield path, node
    properties = node.get("properties")
    if isinstance(properties, dict):
        for name, value in properties.items():
            yield from schema_context_nodes(value, path + "/properties/" + rest.json_pointer_component(name))


def complete_schema_bibo_context(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Supply Java's canonical prefix only where an existing schema context omits it."""
    result = copy.deepcopy(artifact)
    changes = []
    for path, node in schema_context_nodes(result):
        context = node.get("@context")
        if isinstance(context, dict) and "bibo" not in context:
            context["bibo"] = BIBO_NAMESPACE
            changes.append({"path": path + "/@context/bibo", "wrote": BIBO_NAMESPACE})
    return result, changes


def only_added_schema_bibo_context(before: Any, after: Any) -> Optional[str]:
    allowed = {
        path + "/@context/bibo"
        for path, node in schema_context_nodes(before)
        if isinstance(node.get("@context"), dict) and "bibo" not in node["@context"]
    }
    for path, was, now in differences(before, after):
        if path not in allowed or was is not ABSENT or now != BIBO_NAMESPACE:
            return path or "/"
    return None


REQUIRED_REMOVALS: dict[str, Any] = {}
# ModelNodeNames.TEMPLATE_SCHEMA_ARTIFACT_JSON_SCHEMA_REQUIRED / ELEMENT_... in Java.
PARENT_REQUIRED_BASE = {
    "https://schema.metadatacenter.org/core/Template": frozenset({
        "@context", "@id", "schema:isBasedOn", "schema:name", "schema:description",
        "pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy",
    }),
    ELEMENT_AT_TYPE: frozenset({"@context", "@id"}),
}


def artifact_fingerprint(artifact: Any) -> str:
    return hashlib.sha256(json.dumps(artifact, sort_keys=True, ensure_ascii=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def drop_reviewed_required_entries(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Apply an exact, Java-compared plan; refuse any source drift since the comparison."""
    plan = REQUIRED_REMOVALS.get(artifact.get("@id")) if isinstance(artifact, dict) else None
    if not isinstance(plan, dict):
        raise TransformRefused("no Java-reviewed required-removals plan for this artifact")
    digest = artifact_fingerprint(artifact)
    if digest == plan.get("afterSha256"):
        return copy.deepcopy(artifact), []
    if digest != plan.get("beforeSha256"):
        raise TransformRefused("source changed since Java required-list comparison; regenerate the plan")
    result = copy.deepcopy(artifact)
    changes = []
    for change in plan.get("changes", []):
        path = change["path"]
        if not path.endswith("/required"):
            raise TransformRefused("required-removals plan contains a non-required path")
        parent_path = path[:-len("/required")]
        parent = value_at(result, parent_path) if parent_path else result
        if not isinstance(parent, dict) or not json_equal(parent.get("required"), change["before"]):
            raise TransformRefused("required-removals plan does not match " + path)
        parent["required"] = copy.deepcopy(change["after"])
        changes.append({"path": path, "replaced": change["before"], "wrote": change["after"]})
    if artifact_fingerprint(result) != plan.get("afterSha256"):
        raise TransformRefused("required-removals candidate does not match the reviewed digest")
    return result, changes


def only_dropped_reviewed_required_entries(before: Any, after: Any) -> Optional[str]:
    """Permit only removal of noncanonical, non-child parent demands; preserve list order."""
    nodes = dict(schema_context_nodes(before))
    for path, old, new in differences(before, after):
        if not path.endswith("/required"):
            return path or "/"
        parent = nodes.get(path[:-len("/required")])
        kind = parent.get("@type") if parent else None
        if not isinstance(kind, str) or kind not in PARENT_REQUIRED_BASE:
            return path
        if not isinstance(old, list) or not isinstance(new, list) \
                or not all(isinstance(v, str) for v in old + new):
            return path
        preserved = PARENT_REQUIRED_BASE[kind] | {name for name, _, _ in container_children(parent)}
        removed = set(old) - set(new)
        if not removed or removed & preserved or new != [v for v in old if v not in removed]:
            return path
    return None


SCHEMA_SHAPE_PLANS: dict[str, Any] = {}


def apply_reviewed_schema_shapes(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Apply Java-reviewed nullable identifiers and stale UI-order removals to a pinned source."""
    plan = SCHEMA_SHAPE_PLANS.get(artifact.get("@id")) if isinstance(artifact, dict) else None
    if not isinstance(plan, dict):
        raise TransformRefused("no Java-reviewed schema-shape plan for this artifact")
    digest = artifact_fingerprint(artifact)
    if digest == plan.get("afterSha256"):
        return copy.deepcopy(artifact), []
    if digest != plan.get("beforeSha256"):
        raise TransformRefused("source changed since Java schema-shape comparison; regenerate the plan")
    result = copy.deepcopy(artifact)
    changes = []
    for change in plan.get("changes", []):
        path = change["path"]
        if not path.endswith(("/properties/@id/type", "/_ui/order")):
            raise TransformRefused("schema-shape plan contains an unsupported path")
        parent_path, key = path.rsplit("/", 1)
        parent = value_at(result, parent_path)
        if not isinstance(parent, dict) or not json_equal(parent.get(key), change["before"]):
            raise TransformRefused("schema-shape plan does not match " + path)
        parent[key] = copy.deepcopy(change["after"])
        changes.append({"path": path, "replaced": change["before"], "wrote": change["after"]})
    if artifact_fingerprint(result) != plan.get("afterSha256"):
        raise TransformRefused("schema-shape candidate does not match the reviewed digest")
    return result, changes


def only_reviewed_schema_shapes(before: Any, after: Any) -> Optional[str]:
    nodes = dict(schema_context_nodes(before))
    for path, old, new in differences(before, after):
        if path.endswith("/properties/@id/type"):
            if path[:-len("/properties/@id/type")] not in nodes \
                    or old != "string" or new != ["string", "null"]:
                return path
        elif path.endswith("/_ui/order"):
            node = nodes.get(path[:-len("/_ui/order")])
            if not node or not isinstance(node.get("@type"), str) \
                    or node["@type"] not in PARENT_REQUIRED_BASE \
                    or not isinstance(node.get("properties"), dict) \
                    or not isinstance(old, list) or not isinstance(new, list) \
                    or not all(isinstance(v, str) for v in old + new):
                return path
            removed = set(old) - set(new)
            if not removed or removed & set(node["properties"]) \
                    or new != [v for v in old if v not in removed]:
                return path
        else:
            return path or "/"
    return None


CONTEXT_OBJECT_PLANS: dict[str, Any] = {}
CONTEXT_OBJECT_DATATYPES = {
    "rdfs:label": "xsd:string", "schema:name": "xsd:string",
    "schema:description": "xsd:string", "skos:notation": "xsd:string",
    "pav:createdOn": "xsd:dateTime", "pav:lastUpdatedOn": "xsd:dateTime",
    "schema:isBasedOn": "@id", "pav:derivedFrom": "@id",
    "pav:createdBy": "@id", "oslc:modifiedBy": "@id",
}


def complete_reviewed_context_object_types(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Add object typing only after Java comparison and a complete dependent-instance check."""
    plan = CONTEXT_OBJECT_PLANS.get(artifact.get("@id")) if isinstance(artifact, dict) else None
    if not isinstance(plan, dict):
        raise TransformRefused("no instance-checked context-object plan for this template")
    check = plan.get("instanceCheck", {})
    if check.get("conflicts") != [] or check.get("indexed") != check.get("fetched") \
            or not isinstance(check.get("indexed"), int) or check["indexed"] < 0:
        raise TransformRefused("dependent-instance check is incomplete or reports conflicts")
    digest = artifact_fingerprint(artifact)
    if digest == plan.get("afterSha256"):
        return copy.deepcopy(artifact), []
    if digest != plan.get("beforeSha256"):
        raise TransformRefused("template changed since the instance check; regenerate the plan")
    result = copy.deepcopy(artifact)
    changes = []
    allowed = {"/properties/@context/properties/" + name + "/type" for name in CONTEXT_OBJECT_DATATYPES}
    for change in plan.get("changes", []):
        path = change["path"]
        if path not in allowed or change.get("wrote") != "object":
            raise TransformRefused("unsupported context-object addition")
        parent = value_at(result, path[:-len("/type")])
        if not isinstance(parent, dict) or "type" in parent:
            raise TransformRefused("context-object addition is not absent at " + path)
        parent["type"] = "object"
        changes.append({"path": path, "wrote": "object"})
    if artifact_fingerprint(result) != plan.get("afterSha256"):
        raise TransformRefused("context-object candidate differs from the instance-checked plan")
    return result, changes


def only_completed_context_object_types(before: Any, after: Any) -> Optional[str]:
    if not isinstance(before, dict) or before.get("@type") != "https://schema.metadatacenter.org/core/Template":
        return "/"
    allowed = {"/properties/@context/properties/" + name + "/type": datatype
               for name, datatype in CONTEXT_OBJECT_DATATYPES.items()}
    for path, old, new in differences(before, after):
        if path not in allowed or old is not ABSENT or new != "object":
            return path or "/"
        parent = value_at(before, path[:-len("/type")])
        expected = {"properties": {"@type": {"type": "string", "enum": [allowed[path]]}}}
        if not json_equal(parent, expected):
            return path
    return None


def restore_null_standard_context(instance: Any, template: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Restore explicitly approved null standard context definitions, using template-pinned datatypes."""
    if not isinstance(instance, dict) or not isinstance(template, dict) \
            or instance.get("schema:isBasedOn") != template.get("@id"):
        raise TransformRefused("instance does not name the supplied template")
    context = instance.get("@context")
    definitions = template.get("properties", {}).get("@context", {}).get("properties", {})
    if not isinstance(context, dict) or not isinstance(definitions, dict):
        raise TransformRefused("instance or template context is not an object")
    if context.get("xsd") != "http://www.w3.org/2001/XMLSchema#":
        raise TransformRefused("instance has a noncanonical xsd prefix")
    result = copy.deepcopy(instance)
    changes = []
    for name, datatype in CONTEXT_OBJECT_DATATYPES.items():
        if name not in context or context[name] is not None:
            continue
        definition = definitions.get(name)
        expected = {"properties": {"@type": {"type": "string", "enum": [datatype]}}}
        if not json_equal(definition, expected) and not json_equal(definition, {**expected, "type": "object"}):
            raise TransformRefused("template does not canonically pin " + name)
        value = {"@type": datatype}
        result["@context"][name] = value
        changes.append({"path": "/@context/" + name, "replaced": None, "wrote": value})
    return result, changes


def only_restored_null_standard_context(before: Any, after: Any, template: Any) -> Optional[str]:
    for path, old, new in differences(before, after):
        parts = path.split("/")
        if len(parts) != 3 or parts[1] != "@context" or parts[2] not in CONTEXT_OBJECT_DATATYPES \
                or old is not None or new != {"@type": CONTEXT_OBJECT_DATATYPES[parts[2]]}:
            return path or "/"
    return None


REPAIRS = {
    "restore-null-standard-context": Repair(
        name="restore-null-standard-context", condition="null-standard-context",
        summary="restore approved null metadata context definitions from the template's canonical datatypes",
        transform=restore_null_standard_context, invariant=only_restored_null_standard_context,
        needs_template=True,
    ),
    "complete-reviewed-context-object-types": Repair(
        name="complete-reviewed-context-object-types", condition="missing-context-object-type",
        summary="add Java's missing object type to standard instance-context term schemas after instance checks",
        transform=complete_reviewed_context_object_types, invariant=only_completed_context_object_types,
    ),
    "apply-reviewed-schema-shapes": Repair(
        name="apply-reviewed-schema-shapes", condition="reviewed-schema-shapes",
        summary="allow null identifiers and remove undeclared UI-order entries as confirmed by Java",
        transform=apply_reviewed_schema_shapes, invariant=only_reviewed_schema_shapes,
    ),
    "drop-reviewed-required-entries": Repair(
        name="drop-reviewed-required-entries", condition="unexpected-parent-required",
        summary="remove Java-reviewed legacy parent requirements without changing properties or values",
        transform=drop_reviewed_required_entries, invariant=only_dropped_reviewed_required_entries,
    ),
    "complete-schema-bibo-context": Repair(
        name="complete-schema-bibo-context", condition="schema-bibo-context-missing",
        summary="add Java's bibo prefix to existing schema contexts that omit it",
        transform=complete_schema_bibo_context, invariant=only_added_schema_bibo_context,
    ),
    "compact-blank-occurrences": Repair(
        name="compact-blank-occurrences", condition="",
        summary="put a multi-instance field's values first so the stored order is the order a round trip returns",
        transform=compact_blank_occurrences, invariant=only_compacted_blank_occurrences,
        needs_template=True,
    ),
    "normalize-instance-orcid-spacing": Repair(
        name="normalize-instance-orcid-spacing", condition="",
        summary="remove accidental ORCID host-path whitespace without changing the identifier",
        transform=normalize_instance_orcid_spacing, invariant=only_normalized_orcid_spacing,
        needs_template=True, error_pattern=r".*valid URI.*",
    ),
    "drop-empty-undeclared-instance-keys": Repair(
        name="drop-empty-undeclared-instance-keys", condition="",
        summary="remove undeclared empty slots without deleting entered values",
        transform=drop_empty_undeclared_keys, invariant=only_dropped_empty_undeclared_keys,
        needs_template=True, error_pattern=UNDECLARED_KEY_ERROR,
    ),
    "drop-unused-instance-context": Repair(
        name="drop-unused-instance-context", condition="",
        summary="remove undeclared context mappings with no references in their scope",
        transform=drop_unused_instance_context, invariant=only_dropped_unused_context,
        needs_template=True, error_pattern=UNDECLARED_KEY_ERROR,
    ),
    "complete-empty-literal": Repair(
        name="complete-empty-literal", condition="",
        summary="state explicit null in otherwise empty nullable literal slots",
        transform=complete_empty_literal, invariant=only_completed_empty_literals,
        needs_template=True, error_pattern=MISSING_CHILD_ERROR,
    ),
    "empty-derived-from": Repair(
        name="empty-derived-from",
        condition="derived-from-empty",
        summary="delete every pav:derivedFrom whose value is the empty string",
        transform=strip_empty_derived_from,
        invariant=only_removed_empty_derived_from,
    ),
    "drop-schema-keys-from-instance": Repair(
        name="drop-schema-keys-from-instance",
        condition="schema-only-key-on-instance",
        summary="remove artifact-level keys an instance may not carry",
        transform=drop_schema_keys_from_instance,
        invariant=only_dropped_schema_keys,
        needs_template=True,
        error_pattern=SCHEMA_ONLY_KEY_ERROR,
    ),
    "drop-superseded-instance-keys": Repair(
        name="drop-superseded-instance-keys",
        condition="",
        summary="remove an instance key the template dropped whose value it carries elsewhere",
        transform=drop_superseded_instance_keys,
        invariant=only_dropped_superseded_keys,
        needs_template=True,
        error_pattern=UNDECLARED_KEY_ERROR,
    ),
    "rename-instance-keys": Repair(
        name="rename-instance-keys",
        condition="",
        summary="carry an instance's values over to the names its template now declares",
        transform=rename_instance_keys,
        invariant=only_renamed_instance_keys,
        needs_template=True,
        error_pattern=UNDECLARED_KEY_ERROR,
    ),
    "stamp-instance-value-type": Repair(
        name="stamp-instance-value-type",
        condition="",
        summary="give a typed literal the datatype its field declares",
        transform=stamp_instance_value_type,
        invariant=only_stamped_value_types,
        needs_template=True,
        error_pattern=MISSING_CHILD_ERROR,
    ),
    "wrap-instance-occurrence": Repair(
        name="wrap-instance-occurrence",
        condition="",
        summary="put a lone occurrence in the list its template declares",
        transform=wrap_instance_occurrence,
        invariant=only_wrapped_occurrences,
        needs_template=True,
        error_pattern=ARRAY_EXPECTED_ERROR,
    ),
    "unwrap-instance-occurrence": Repair(
        name="unwrap-instance-occurrence",
        condition="",
        summary="take a lone occurrence out of a list its template does not declare",
        transform=unwrap_instance_occurrence,
        invariant=only_unwrapped_occurrences,
        needs_template=True,
        error_pattern=OBJECT_EXPECTED_ERROR,
    ),
    "declare-instance-field": Repair(
        name="declare-instance-field",
        condition="",
        summary="declare a field the template's instances already carry",
        transform=declare_instance_field,
        invariant=only_declared_fields,
        needs_template=False,
    ),
    "free-controlled-field": Repair(
        name="free-controlled-field",
        condition="",
        summary="let a named field hold free text instead of a term",
        transform=free_controlled_field,
        invariant=only_freed_controlled_fields,
        needs_template=False,
    ),
    "settle-instance-term-label": Repair(
        name="settle-instance-term-label",
        condition="",
        summary="put a controlled field's value behind the term its label names",
        transform=settle_instance_term_label,
        invariant=only_settled_term_labels,
        needs_template=True,
        error_pattern=VALUE_SHAPE_ERROR,
    ),
    "settle-instance-iri-value": Repair(
        name="settle-instance-iri-value",
        condition="",
        summary="take an @value out of a field whose schema admits only an IRI",
        transform=settle_instance_iri_value,
        invariant=only_settled_iri_values,
        needs_template=True,
        error_pattern=VALUE_SHAPE_ERROR,
    ),
    "settle-instance-empty-shape": Repair(
        name="settle-instance-empty-shape",
        condition="",
        summary="write an absent value in the form its own field takes",
        transform=settle_instance_empty_shape,
        invariant=only_settled_empty_shapes,
        needs_template=True,
        error_pattern=VALUE_SHAPE_ERROR,
    ),
    "complete-instance-context": Repair(
        name="complete-instance-context",
        condition="",
        summary="give an instance the @context entries its template requires and states",
        transform=complete_instance_context,
        invariant=only_added_context_entries,
        needs_template=True,
        error_pattern=MISSING_CHILD_ERROR,
    ),
    "restate-instance-literal": Repair(
        name="restate-instance-literal",
        condition="",
        summary="write a literal as the JSON type its field's schema states",
        transform=restate_instance_literal,
        invariant=only_restated_literals,
        needs_template=True,
        error_pattern=TYPE_EXPECTED_ERROR,
    ),
    "drop-static-field-from-instance": Repair(
        name="drop-static-field-from-instance",
        condition="",
        summary="remove a static field an instance was given",
        transform=drop_static_field_from_instance,
        invariant=only_dropped_static_fields,
        needs_template=True,
        error_pattern=MISSING_CHILD_ERROR,
    ),
    "complete-instance": Repair(
        name="complete-instance",
        condition="",
        summary="give an instance the shape its template declares, with nothing filled in",
        transform=complete_instance,
        invariant=only_completed_absences,
        needs_template=True,
        error_pattern=MISSING_CHILD_ERROR,
    ),
    "align-instance-context-iris": Repair(
        name="align-instance-context-iris",
        condition="",
        summary="rewrite an instance's @context property IRIs to the ones its template names",
        transform=align_instance_context_iris,
        invariant=only_aligned_context_iris,
        needs_template=True,
        error_pattern=CONTEXT_ENUM_ERROR,
    ),
    "drop-static-field-demands": Repair(
        name="drop-static-field-demands",
        condition="static-field-required",
        summary="stop a container demanding a static field its instances never carry",
        transform=drop_static_field_demands,
        invariant=only_dropped_static_demands,
    ),
    "drop-instance-demands-from-element": Repair(
        name="drop-instance-demands-from-element",
        condition="",
        summary="stop an element declaration demanding the members only an instance root carries",
        transform=drop_instance_demands_from_element,
        invariant=only_dropped_instance_demands,
        error_pattern=MISSING_CHILD_ERROR,
    ),
    "complete-context-required": Repair(
        name="complete-context-required",
        condition="child-context-required-missing",
        summary="list in @context.required every child the container already maps",
        transform=complete_context_required,
        invariant=only_completed_context_required,
    ),
    "wrap-inherently-multiple": Repair(
        name="wrap-inherently-multiple",
        condition="inherently-multiple-child-object",
        summary="deploy an inherently multiple child as the array it always serializes to",
        transform=wrap_inherently_multiple,
        invariant=only_wrapped_inherently_multiple,
    ),
    "name-controlled-term-field": Repair(
        name="name-controlled-term-field",
        condition="input-type-unknown",
        summary="write controlled-term as the textfield the model actually has",
        transform=name_a_controlled_term_field_as_it_is_modelled,
        invariant=only_named_controlled_term_fields,
    ),
    "drop-unresolvable-default": Repair(
        name="drop-unresolvable-default",
        condition="default-value-kind-mismatch",
        summary="remove a default naming a term the field offers no way to reach",
        transform=drop_unresolvable_default,
        invariant=only_dropped_unresolvable_defaults,
    ),
    "derive-absent-provenance": Repair(
        name="derive-absent-provenance",
        condition="provenance-absent",
        summary="fill a null creation date or author from what the last change records",
        transform=derive_absent_provenance,
        invariant=only_derived_absent_provenance,
    ),
    "state-temporal-precision": Repair(
        name="state-temporal-precision",
        condition="temporal-precision-absent",
        summary="say what precision a temporal field is read at, where it says nothing",
        transform=state_temporal_precision,
        invariant=only_stated_temporal_precision,
    ),
    "present-choices-as-a-list": Repair(
        name="present-choices-as-a-list",
        condition="field-offers-choices-it-cannot-present",
        summary="make a field that lists permitted values a single-select list",
        transform=present_choices_as_a_list,
        invariant=only_presented_choices_as_a_list,
    ),
    "drop-blank-literal": Repair(
        name="drop-blank-literal",
        condition="literal-label-blank",
        summary="remove a permitted value that has no label",
        transform=drop_blank_literal,
        invariant=only_dropped_blank_literals,
    ),
    "drop-unresolved-class-constraint": Repair(
        name="drop-unresolved-class-constraint",
        condition="class-constraint-unresolved",
        summary="remove a class constraint whose URI is the empty string",
        transform=drop_unresolved_class_constraint,
        invariant=only_dropped_unresolved_class_constraints,
    ),
    "default-unreadable-version": Repair(
        name="default-unreadable-version",
        condition="artifact-version-unreadable",
        summary="give a draft whose version carries no version the default a new artifact gets",
        transform=default_unreadable_version,
        invariant=only_defaulted_unreadable_version,
    ),
    "settle-prerelease-version": Repair(
        name="settle-prerelease-version",
        condition="artifact-version-prerelease",
        summary="write a draft's prerelease version as its release, discarding the tag",
        transform=settle_prerelease_version,
        invariant=only_settled_prerelease_version,
    ),
    "canonicalise-iri-field-required": Repair(
        name="canonicalise-iri-field-required",
        condition="iri-field-required",
        summary="remove legacy IRI-field presence requirements to match the Java model",
        transform=canonicalise_iri_field_required,
        invariant=only_canonicalised_iri_field_required,
    ),
    "drop-noncanonical-context-demands": Repair(
        name="drop-noncanonical-context-demands", condition="noncanonical-context-demands",
        summary="stop demanding context entries for absent children or attribute-value groups",
        transform=drop_noncanonical_context_demands,
        invariant=only_dropped_noncanonical_context_demands,
    ),
    "canonicalise-field-required": Repair(
        name="canonicalise-field-required",
        condition="required-names-undeclared-key",
        summary="give a field the `required` its declared shape calls for",
        transform=canonicalise_field_required,
        invariant=only_canonicalised_field_required,
    ),
    "drop-empty-instance-iri": Repair(
        name="drop-empty-instance-iri",
        condition="empty-instance-iri",
        summary="take an empty @id out of a field that holds no IRI",
        transform=drop_empty_instance_iri,
        invariant=only_dropped_empty_instance_iri,
        error_pattern=EMPTY_IRI_ERROR,
    ),
    "compose-artifact-title": Repair(
        name="compose-artifact-title",
        condition="title-not-composed",
        summary="write the title an artifact's name and kind compose, where it holds another",
        transform=compose_artifact_title,
        invariant=only_composed_artifact_title,
    ),
    "decode-constraint-iri": Repair(
        name="decode-constraint-iri",
        condition="uri-unexpected",
        summary="write a constraint's address as the IRI it is, not as an escaped copy of one",
        transform=decode_constraint_iri,
        invariant=only_decoded_constraint_iri,
    ),
    "resolve-constraint-source": Repair(
        name="resolve-constraint-source",
        condition="acronym-unexpected",
        summary="write the address a constraint's vocabulary is reached by, where one was confirmed",
        transform=resolve_constraint_source,
        invariant=only_resolved_constraint_source,
    ),
    "narrow-ontology-constraint-to-branch": Repair(
        name="narrow-ontology-constraint-to-branch",
        condition="ontology-constraint-too-broad",
        summary="constrain a field to the branch its author meant, not to the whole ontology",
        transform=narrow_ontology_constraint_to_branch,
        invariant=only_narrowed_ontology_constraint,
    ),
    "drop-unusable-previous-version": Repair(
        name="drop-unusable-previous-version",
        condition="pav:previousVersion-unexpected",
        summary="stop an artifact naming a predecessor by something that is not one",
        transform=drop_unusable_previous_version,
        invariant=only_dropped_unusable_previous_version,
    ),
    "drop-blank-unit-of-measure": Repair(
        name="drop-blank-unit-of-measure",
        condition="unitOfMeasure-unexpected",
        summary="stop a field stating a unit of measure that names no unit",
        transform=drop_blank_unit_of_measure,
        invariant=only_dropped_blank_unit_of_measure,
    ),
    "narrow-multi-select-value": Repair(
        name="narrow-multi-select-value",
        condition="multi-select-value-typed-as-array",
        summary="type one answer of a multi-select as the string it is, not as another array",
        transform=narrow_multi_select_value,
        invariant=only_narrowed_multi_select_value,
    ),
    "pad-artifact-version": Repair(
        name="pad-artifact-version",
        condition="artifact-version-unpadded",
        summary="write a short numeric pav:version as the three-part version it means",
        transform=pad_artifact_version,
        invariant=only_padded_artifact_version,
    ),
    "stamp-static-field-model-version": Repair(
        name="stamp-static-field-model-version",
        condition="model-version-absent",
        summary="declare the current model version on a static field that states none",
        transform=stamp_static_field_model_version,
        invariant=only_stamped_static_field_model_version,
    ),
    "stamp-model-version": Repair(
        name="stamp-model-version",
        condition="schema-version-stale",
        also_conditions=("schema-version-nested-stale",),
        summary="write the current model version on every definition that already conforms to it",
        transform=stamp_model_version,
        invariant=only_stamped_model_version,
    ),
    "complete-ui-order": Repair(
        name="complete-ui-order",
        condition="ui-order-missing-child",
        summary="append to _ui.order the children a container declares but does not list",
        transform=complete_ui_order,
        invariant=only_appended_ui_order,
    ),
    "drop-unusable-order-entries": Repair(
        name="drop-unusable-order-entries",
        condition="ui-order-orphan-entry",
        summary="remove the _ui.order entries that name no child and never could",
        transform=drop_unusable_order_entries,
        invariant=only_dropped_unusable_order_entries,
    ),
    "require-context": Repair(
        name="require-context",
        condition="",
        summary="put @context back at the head of a container's required array",
        transform=require_context,
        invariant=only_required_context,
        error_pattern=MISSING_CONTEXT_REQUIRED_ERROR,
    ),
    "rename-legacy-temporal-input-type": Repair(
        name="rename-legacy-temporal-input-type",
        condition="",
        summary="give a field declared date the name the model now uses for a temporal field",
        transform=rename_legacy_temporal_input_type,
        invariant=only_renamed_legacy_temporal_input_types,
        error_pattern=LITERAL_INPUT_TYPE_ERROR,
    ),
    "settle-controlled-term-field": Repair(
        name="settle-controlled-term-field",
        condition="",
        summary="declare as a controlled-term field one whose value and constraints already are",
        transform=settle_controlled_term_field,
        invariant=only_settled_controlled_term_fields,
        error_pattern=IRI_INPUT_TYPE_ERROR,
    ),
    "drop-blank-orphan-property-label": Repair(
        name="drop-blank-orphan-property-label",
        condition="",
        summary="remove a blank property label left behind by a child that no longer exists",
        transform=drop_blank_orphan_property_labels,
        invariant=only_dropped_blank_orphan_property_labels,
        error_pattern=BLANK_PROPERTY_LABEL_ERROR,
    ),
    "settle-constraint-actions": Repair(
        name="settle-constraint-actions",
        condition="",
        summary="give a value-constraint action the source it names, or drop it where it names nothing",
        transform=settle_constraint_actions,
        invariant=only_settled_constraint_actions,
        error_pattern=MISSING_ACTION_SOURCE_ERROR,
    ),
    "reclassify-static-field": Repair(
        name="reclassify-static-field",
        condition="",
        summary="give a definition that is a static field in all but its @type that type",
        transform=reclassify_static_field,
        invariant=only_reclassified_static_fields,
        error_pattern=STATIC_INPUT_TYPE_ERROR,
    ),
    "drop-zero-term-count": Repair(
        name="drop-zero-term-count",
        condition="num-terms-zero",
        summary="delete a numTerms written as zero, which claims a constraint matches nothing",
        transform=drop_zero_term_count,
        invariant=only_dropped_zero_term_counts,
    ),
    "drop-stray-cardinality-keys": Repair(
        name="drop-stray-cardinality-keys",
        condition="stray-cardinality-keys",
        summary="delete minItems and maxItems from a child deployed as a single object",
        transform=drop_stray_cardinality_keys,
        invariant=only_dropped_stray_cardinality_keys,
    ),
    "settle-temporal-type": Repair(
        name="settle-temporal-type",
        condition="temporal-type-absent",
        summary="write the temporal type a field's own granularity already settles",
        transform=settle_temporal_type,
        invariant=only_settled_temporal_types,
    ),
    "derive-title": Repair(
        name="derive-title",
        condition="title-not-canonical",
        also_conditions=("title-not-canonical-nested",),
        summary="compose every definition's title from its own name, as an ordinary write does",
        transform=derive_title,
        invariant=only_derived_title,
    ),
    "mint-property-iris": Repair(
        name="mint-property-iris",
        condition="child-property-iri-unusable",
        summary="replace a child's property IRI where the stored one is not an absolute IRI",
        transform=mint_property_iris,
        invariant=only_minted_property_iris,
    ),
    "mint-child-ids": Repair(
        name="mint-child-ids",
        condition="child-id-unusable",
        summary="give every child whose own @id is missing or not an absolute IRI a fresh one",
        transform=mint_child_ids,
        invariant=only_minted_child_ids,
    ),
}


# --------------------------------------------------------------------------------------------------
# A client that may also write, under the audit's transport discipline
# --------------------------------------------------------------------------------------------------


class RepairClient(rest.GetOnlyClient):
    """The audit's client, plus the one write this tool performs.

    Inherits its TLS handling, its refusal to follow a redirect with the API key attached, and its
    origin check, so a repair cannot send credentials anywhere the audit would not.
    """

    def put_verbatim(self, path: str, body: Any, etag: Optional[str]) -> tuple[int, Optional[str]]:
        if not etag or etag.startswith("W/"):
            raise ValueError("a strong ETag from the current stored body is required")
        if not path.startswith("/"):
            raise ValueError("request path must start with /")
        url = self.server + path + "?verbatim=true"
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme, parsed.netloc) != self.origin:
            raise ValueError("refusing to send the API key outside the configured origin")
        headers = {
            "Authorization": f"apiKey {self.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if etag:
            headers["If-Match"] = etag
        request = urllib.request.Request(
            url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers, method="PUT",
        )
        if self.delay:
            time.sleep(self.delay)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return response.status, response.headers.get("ETag")
        except urllib.error.HTTPError as error:
            detail = error.read(600).decode("utf-8", errors="replace")
            raise rest.ResponseError(f"PUT {path} returned {error.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as error:
            raise rest.ResponseError(f"PUT {path} failed: {type(error).__name__}: {error}") from None

    def get_with_etag(self, path: str) -> tuple[Any, Optional[str]]:
        """The audit's GET returns only the body; a conditional write needs the revision with it."""
        url = self.server + path
        request = urllib.request.Request(
            url, headers={"Authorization": f"apiKey {self.api_key}", "Accept": "application/json"},
            method="GET",
        )
        if self.delay:
            time.sleep(self.delay)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.load(response), response.headers.get("ETag")
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise rest.AuthenticationError("401 Unauthorized; check CEDAR_API_KEY") from None
            detail = error.read(300).decode("utf-8", errors="replace")
            raise rest.ResponseError(f"GET {path} returned {error.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise rest.ResponseError(f"GET {path} failed: {type(error).__name__}: {error}") from None


# --------------------------------------------------------------------------------------------------
# Targets, pre-images and progress
# --------------------------------------------------------------------------------------------------


def conditions_named_by(path: Path, sample: int = 5000) -> list[str]:
    """The conditions a records file measures, from its opening lines.

    Only the error path asks, so the cost is paid where the run is ending anyway, and a sample is
    enough to say which rules the file knows about.
    """
    found: set[str] = set()
    try:
        with path.open(encoding="utf-8") as stream:
            for number, line in enumerate(stream):
                if number >= sample:
                    break
                try:
                    found.update(normalized_target_record(json.loads(line)).get("conditionRules") or {})
                except (ValueError, AttributeError):
                    continue
    except OSError:
        return []
    return sorted(found)


def normalized_target_record(record: Any) -> dict:
    """One target row, whichever inventory wrote it.

    ``cedar_artifact_validation_audit.py`` writes a record per artifact carrying every condition it
    met; ``cedar_artifact_rest_audit.py`` writes a finding per defect naming one rule. Both are
    inventories a repair draws targets from, so a finding is read as the single-condition record it
    already is rather than needing a conversion step between the two tools.
    """
    if not isinstance(record, dict) or "conditionRules" in record or "artifactId" in record:
        return record if isinstance(record, dict) else {}
    if not {"rule", "artifact_id", "artifact_type"} <= set(record):
        return record
    return {
        "artifactType": record["artifact_type"],
        "artifactId": record["artifact_id"],
        "artifactName": record.get("artifact_name", ""),
        "conditionRules": {record["rule"]: 1},
    }


def targets_from_records(path: Path, conditions: list[str], patterns: list[str],
                         parser: argparse.ArgumentParser) -> list[rest.ArtifactRef]:
    """Every artifact the audit found carrying one of these conditions, or failing in one of these ways.

    Most defects are inventory conditions the audit names. Some are only a verdict: the validator
    rejects the artifact and no condition describes why, so the repair says which complaint is its own.
    """
    refs: list[rest.ArtifactRef] = []
    seen: set[tuple[str, str]] = set()
    wanted = {condition for condition in conditions if condition}
    expressions = [re.compile(pattern) for pattern in patterns]
    try:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if wanted and not any(condition in line for condition in wanted) and not expressions:
                    continue
                record = normalized_target_record(json.loads(line))
                matched = bool(wanted & set(record.get("conditionRules") or {}))
                if not matched and expressions:
                    errors = ((record.get("validation") or {}).get("errors") or [])
                    matched = any(expression.match(str(error.get("message", "")))
                                  for error in errors for expression in expressions)
                if not matched:
                    continue
                key = (record["artifactType"], record["artifactId"])
                if key in seen:
                    continue
                seen.add(key)
                refs.append(rest.ArtifactRef(record["artifactType"], record["artifactId"],
                                             record.get("artifactName", "")))
    except (OSError, ValueError) as error:
        parser.error(f"cannot read --from-records {path}: {error}")
    if not refs:
        # A records file written before a rule existed names nothing it measures, which looks exactly
        # like a clean deployment. Say so, since the two are worth telling apart.
        seen = conditions_named_by(path)
        parser.error(
            f"no artifact in {path} carries any of {sorted(wanted)}"
            + (f" or fails in the way {arguments_repair_names(patterns)} repairs" if patterns else "")
            + (f"; that file measures {seen}, so it may predate the rule this repair selects on, in "
               "which case a fresh audit run is what is missing rather than the defect"
               if seen else "; that file records no conditions at all"))
    return refs


def arguments_repair_names(patterns: list[str]) -> str:
    return ", ".join(name for name, repair in sorted(REPAIRS.items()) if repair.error_pattern in patterns)


def preimage_path(folder: Path, ref: rest.ArtifactRef) -> Path:
    """One file per artifact, named by type and the last path segment of its IRI."""
    tail = ref.artifact_id.rstrip("/").rsplit("/", 1)[-1]
    safe = "".join(character if character.isalnum() or character in "-_." else "_" for character in tail)
    return folder / ref.artifact_type / f"{safe or 'artifact'}.json"


def save_preimage(folder: Path, ref: rest.ArtifactRef, artifact: Any, etag: Optional[str]) -> Path:
    path = preimage_path(folder, ref)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"artifactType": ref.artifact_type, "artifactId": ref.artifact_id,
                "etag": etag, "capturedAt": audit.utc_now(), "artifact": artifact}
    # Never overwrite the recovery body from a previous attempt, including a timed-out PUT.
    if path.exists():
        path = path.with_name(f"{path.stem}-{uuid.uuid4()}.json")
    with path.open("x", encoding="utf-8") as stream:
        json.dump(document, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    return path


@dataclass
class Progress:
    total: int
    started: float = field(default_factory=time.monotonic)
    last_report: float = field(default_factory=time.monotonic)
    done: int = 0
    outcomes: collections.Counter = field(default_factory=collections.Counter)
    paths_removed: int = 0

    def note(self, outcome: str, removed: int = 0) -> None:
        self.done += 1
        self.outcomes[outcome] += 1
        if outcome in {"repaired", "would-repair"}:
            self.paths_removed += removed

    def due(self, every: int, seconds: float) -> bool:
        return self.done % every == 0 or time.monotonic() - self.last_report >= seconds

    def report(self, final: bool = False, applied: bool = True) -> None:
        self.last_report = time.monotonic()
        elapsed = time.monotonic() - self.started
        timing = f"elapsed={rest.format_duration(elapsed)}"
        if not final and self.done and self.done < self.total:
            timing += f", eta={rest.format_duration((self.total - self.done) * elapsed / self.done)}"
        counts = " ".join(f"{name}={self.outcomes[name]}" for name in OUTCOMES if self.outcomes[name])
        print(f"[{'final' if final else 'progress'} {self.done}/{self.total} "
              f"{rest.completion_percent(self.done, self.total):.1f}%] {counts or 'none'}; "
              f"paths {'cleared' if applied else 'to clear'}={self.paths_removed}; {timing}", flush=True)


# --------------------------------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------------------------------


def validate(bridge: audit.ValidationBridge, resolver: audit.TemplateResolver,
             ref: rest.ArtifactRef, artifact: Any) -> tuple[bool, str]:
    """The library's verdict on the repaired body, as (valid, explanation)."""
    template_id = None
    if ref.artifact_type == "instance":
        template_id = artifact.get("schema:isBasedOn") if isinstance(artifact, dict) else None
        if not rest.is_absolute_iri(template_id):
            return False, "instance names no absolute template IRI"
    answer = bridge.validate(ref.artifact_type, artifact, template_id)
    if answer.get("status") == "template-missing":
        if not resolver.ensure_cached_in_bridge(template_id):
            return False, f"template {template_id} could not be read"
        answer = bridge.validate(ref.artifact_type, artifact, template_id)
    status = answer.get("status")
    if status == "valid":
        return True, ""
    if status == "invalid":
        messages = "; ".join(error.get("message", "") for error in (answer.get("errors") or [])[:3])
        return False, f"{len(answer.get('errors') or [])} error(s): {messages}"
    return False, f"{answer.get('exception') or 'bridge'}: {answer.get('message') or status}"


def apply_repairs(repairs: list[Repair], stored: Any,
                  template: Any = None) -> tuple[Any, list[dict[str, Any]]]:
    """Run each repair over the output of the one before, verifying every stage as it goes.

    An artifact carrying two defects cannot be fixed by either repair alone: the first leaves the
    artifact invalid, and the second cannot be written while the first defect still blocks it. Applied
    together they make one write that is still provably narrow, because each stage answers to its own
    invariant against its own input.
    """
    current = stored
    changes: list[dict[str, Any]] = []
    for repair in repairs:
        if repair.needs_template:
            result, staged = repair.transform(current, template)
            difference = repair.invariant(current, result, template)
        else:
            result, staged = repair.transform(current)
            difference = repair.invariant(current, result)
        if difference is not None:
            raise InvariantFailed(f"{repair.name} made an unexpected difference at {difference}")
        for change in staged:
            changes.append({**change, "repair": repair.name})
        current = result
    return current, changes


class InvariantFailed(Exception):
    """A transform changed something it does not speak for."""


def repair_one(arguments: argparse.Namespace, repairs: list[Repair], client: RepairClient,
               bridge: audit.ValidationBridge, resolver: audit.TemplateResolver,
               ref: rest.ArtifactRef) -> dict[str, Any]:
    record: dict[str, Any] = {"artifactType": ref.artifact_type, "artifactId": ref.artifact_id,
                              "artifactName": ref.name,
                              "repair": ",".join(r.name for r in repairs), "at": audit.utc_now()}
    path = rest.typed_artifact_path(ref)
    template: Any = None
    try:
        stored, etag = client.get_with_etag(path)
    except rest.AuthenticationError:
        raise
    except Exception as error:  # noqa: BLE001 - one unreadable artifact must not end the run
        record.update(outcome="fetch-failed", detail=str(error))
        return record
    record["etag"] = etag

    if any(repair.needs_template for repair in repairs):
        based_on = stored.get("schema:isBasedOn") if isinstance(stored, dict) else None
        if not rest.is_absolute_iri(based_on):
            record.update(outcome="transform-refused", detail="artifact names no absolute template IRI")
            return record
        record["templateId"] = based_on
        template = resolver.fetch_body(based_on)
        if template is None:
            record.update(outcome="transform-refused",
                          detail=f"template could not be read: "
                                 f"{resolver.unresolved.get(based_on, {}).get('error', '')}")
            return record

    try:
        repaired, changes = apply_repairs(repairs, stored, template)
    except TransformRefused as refusal:
        record.update(outcome="transform-refused", detail=str(refusal))
        return record
    except InvariantFailed as failure:
        record.update(outcome="invariant-failed", detail=str(failure))
        return record
    record["changes"] = changes
    record["pathsRemoved"] = [change["path"] for change in changes]
    if not changes:
        valid, explanation = validate(bridge, resolver, ref, stored)
        record.update(outcome="already-clean" if valid else "still-invalid")
        if not valid:
            record["detail"] = explanation
        return record

    valid, explanation = validate(bridge, resolver, ref, repaired)
    if not valid:
        record.update(outcome="still-invalid", detail=explanation)
        return record

    if not arguments.apply:
        record.update(outcome="would-repair")
        return record

    record["preimage"] = str(save_preimage(Path(arguments.preimages), ref, stored, etag))
    try:
        status, new_etag = client.put_verbatim(path, repaired, etag)
    except Exception as error:  # noqa: BLE001 - a refused write is reported, not fatal
        record.update(outcome="write-failed", detail=str(error))
        return record
    record.update(outcome="repaired", status=status, newEtag=new_etag)

    if arguments.verify:
        try:
            back, _ = client.get_with_etag(path)
            difference = next(differences(repaired, back), None)
            valid_back, explanation = validate(bridge, resolver, ref, back)
            record["verified"] = difference is None and valid_back
            if difference is not None:
                record["detail"] = f"stored body differs from the submitted candidate at {difference[0]}"
            elif not valid_back:
                record["detail"] = f"stored body does not validate: {explanation}"
        except Exception as error:  # noqa: BLE001
            record["verified"] = False
            record["detail"] = f"read-back failed: {error}"
    return record


def already_done(path: Path, parser: argparse.ArgumentParser) -> set[tuple[str, str]]:
    done: set[tuple[str, str]] = set()
    if not path.exists():
        return done
    try:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                record = json.loads(line)
                if record.get("outcome") in {"repaired", "already-clean"}:
                    done.add((record["artifactType"], record["artifactId"]))
    except (OSError, ValueError) as error:
        parser.error(f"cannot read --out for --resume: {error}")
    return done


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Repair one narrowly defined defect across stored CEDAR artifacts, verbatim.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Dry run by default. --apply writes, saving every artifact's stored body first.",
    )
    parser.add_argument("--repair", default="empty-derived-from",
                        help="repair to perform, or several comma separated to apply in one write; "
                             f"choose from {', '.join(sorted(REPAIRS))} (default: empty-derived-from)")
    parser.add_argument("--mapping",
                        help="JSON of confirmed renames, {templateId: {oldKey: newKey}}, which "
                             "rename-instance-keys applies; nothing is renamed without it")
    parser.add_argument("--required-removals",
                        help="Java-reviewed parent required-list removals keyed by artifact IRI, "
                             "with beforeSha256, afterSha256 and changes (path, before, after)")
    parser.add_argument("--schema-shape-plan",
                        help="Java-reviewed nullable @id/UI-order changes keyed by artifact IRI, "
                             "with beforeSha256, afterSha256 and changes (path, before, after)")
    parser.add_argument("--context-object-plan",
                        help="Java-reviewed context object additions with pinned before/after hashes "
                             "and complete, conflict-free dependent-instance check results")
    parser.add_argument("--declare-fields",
                        help="JSON: template IRI -> the field declarations to add, for "
                             "declare-instance-field; nothing is declared without it")
    parser.add_argument("--free-fields",
                        help="JSON of fields to make free text, {templateId: [fieldName]}, which "
                             "free-controlled-field applies; nothing is freed without it")
    parser.add_argument("--acronyms",
                        help="JSON of confirmed vocabulary addresses, "
                             "{storedValue: {acronym, name, uri}}, from acronym_sheet.py, which "
                             "resolve-constraint-source applies; nothing is rewritten without it")
    parser.add_argument("--branches",
                        help="JSON of confirmed narrowings, {artifactId: {entryPath: branchEntry}}, "
                             "which narrow-ontology-constraint-to-branch applies; nothing is "
                             "narrowed without it")
    parser.add_argument("--terms",
                        help="JSON of resolved terms, {templateId: {fieldRoute: {label: term}}}, which "
                             "settle-instance-term-label applies; a term of null empties the field")
    parser.add_argument("--condition",
                        help="audit condition naming the targets (default: any condition the repairs name)")
    parser.add_argument("--from-records", required=True,
                        help="records JSONL from cedar_artifact_validation_audit.py, the target list")
    parser.add_argument("--server", default=rest.DEFAULT_SERVER,
                        help=f"resource server origin (default: {rest.DEFAULT_SERVER})")
    parser.add_argument("--api-key-file", help="read the API key from this one-line file")
    parser.add_argument("--apply", action="store_true", help="write; otherwise report what would change")
    parser.add_argument("--allow-context-migration", action="store_true",
                        help="approve property-IRI migration for the explicit --only-ids scope")
    parser.add_argument("--limit", type=int, help="stop after this many artifacts")
    parser.add_argument("--types", help="restrict to these artifact types, comma separated")
    parser.add_argument("--exclude-ids",
                        help="JSON list of artifact IDs to leave alone, for artifacts whose instances "
                             "rely on a value a repair would change")
    parser.add_argument("--only-ids",
                        help="JSON list of artifact IDs to restrict the run to, for trialling a repair "
                             "on artifacts chosen deliberately rather than on whichever come first")
    parser.add_argument("--out", default="cedar-artifact-repair.jsonl",
                        help="one record per artifact (default: cedar-artifact-repair.jsonl)")
    parser.add_argument("--summary", help="summary JSON path (default: <out without suffix>-summary.json)")
    parser.add_argument("--preimages", help="directory for stored bodies (default: <out without suffix>-preimages)")
    parser.add_argument("--java-log", help="the JVM's stderr (default: <out without suffix>-java.log)")
    parser.add_argument("--resume", action="store_true", help="skip artifacts already repaired or clean in --out")
    parser.add_argument("--no-verify", dest="verify", action="store_false",
                        help="do not read each artifact back after writing it")
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY,
                        help=f"report every N artifacts (default: {DEFAULT_PROGRESS_EVERY})")
    parser.add_argument("--progress-seconds", type=float, default=DEFAULT_PROGRESS_SECONDS,
                        help=f"also report every N seconds (default: {DEFAULT_PROGRESS_SECONDS})")
    parser.add_argument("--bridge-max-restarts", type=int, default=audit.DEFAULT_BRIDGE_MAX_RESTARTS,
                        help="JVM restarts tolerated before the run stops "
                             f"(default: {audit.DEFAULT_BRIDGE_MAX_RESTARTS})")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                        help="artifacts repaired in parallel. Each costs three round trips and almost "
                             "no local work, so the run is latency-bound and this is what makes it "
                             f"quick (default: {DEFAULT_WORKERS}; 1 restores the serial order)")
    parser.add_argument("--delay-ms", type=int, default=0, help="polite delay before every request")
    parser.add_argument("--timeout", type=float, default=90, help="per-request timeout (default: 90)")
    parser.add_argument("--retries", type=int, default=5, help="attempts for transient GET failures")
    parser.add_argument("--java", help="java binary (default: what cedar_validate.sh java resolves)")
    parser.add_argument("--classpath", help="validation classpath (default: cedar_validate.sh classpath)")
    parser.add_argument("--jvm-heap", default="2g", help="JVM maximum heap (default: 2g)")
    parser.add_argument("--ca-file", help="additional CA bundle")
    parser.add_argument("--allow-http", action="store_true", help="allow plain HTTP, for a local test server")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    names = [name.strip() for name in arguments.repair.split(",") if name.strip()]
    unknown = [name for name in names if name not in REPAIRS]
    if unknown or not names:
        parser.error(f"unknown repair {unknown or ['(none given)']}; choose from {sorted(REPAIRS)}")
    if len(set(names)) != len(names):
        parser.error("each repair may appear only once in a chain")
    repairs = [REPAIRS[name] for name in names]
    if "drop-reviewed-required-entries" in names and not arguments.required_removals:
        parser.error("drop-reviewed-required-entries requires --required-removals")
    if "apply-reviewed-schema-shapes" in names and not arguments.schema_shape_plan:
        parser.error("apply-reviewed-schema-shapes requires --schema-shape-plan")
    if "complete-reviewed-context-object-types" in names and not arguments.context_object_plan:
        parser.error("complete-reviewed-context-object-types requires --context-object-plan")
    if arguments.apply and not arguments.verify:
        parser.error("production writes require read-back verification; --no-verify is dry-run only")
    if arguments.apply and ({"align-instance-context-iris", "restore-null-standard-context"} & set(names)) \
            and not (arguments.allow_context_migration and arguments.only_ids):
        parser.error("context alignment changes meaning; applying it requires "
                     "--allow-context-migration and an explicit --only-ids scope")
    conditions = [arguments.condition] if arguments.condition \
        else [c for r in repairs for c in r.conditions]
    patterns = [] if arguments.condition else [r.error_pattern for r in repairs if r.error_pattern]
    if arguments.limit is not None and arguments.limit <= 0:
        parser.error("--limit must be positive")
    if arguments.workers <= 0:
        parser.error("--workers must be positive")
    if arguments.bridge_max_restarts <= 0:
        parser.error("--bridge-max-restarts must be positive")
    api_key = rest.resolve_api_key(arguments, parser)

    records_path = Path(arguments.out).expanduser()
    stem = records_path.stem
    summary_path = Path(arguments.summary).expanduser() if arguments.summary \
        else records_path.with_name(stem + "-summary.json")
    preimages = Path(arguments.preimages).expanduser() if arguments.preimages \
        else records_path.with_name(stem + "-preimages")
    java_log = Path(arguments.java_log).expanduser() if arguments.java_log \
        else records_path.with_name(stem + "-java.log")
    arguments.preimages = str(preimages)
    arguments.server = arguments.server.rstrip("/")
    records_path.parent.mkdir(parents=True, exist_ok=True)

    refs = targets_from_records(Path(arguments.from_records).expanduser(), conditions, patterns, parser)
    if arguments.types:
        wanted = {kind.strip() for kind in arguments.types.split(",") if kind.strip()}
        unknown = wanted - set(rest.ARTIFACT_PATHS)
        if unknown:
            parser.error(f"unknown artifact types {sorted(unknown)}")
        refs = [ref for ref in refs if ref.artifact_type in wanted]
    if arguments.only_ids:
        try:
            wanted_ids = set(json.loads(Path(arguments.only_ids).expanduser().read_text(encoding="utf-8")))
        except (OSError, ValueError) as error:
            parser.error(f"cannot read --only-ids: {error}")
        refs = [ref for ref in refs if ref.artifact_id in wanted_ids]
        if not refs:
            parser.error(f"no target is named by {arguments.only_ids}")
        print(f"Restricted to {len(refs)} artifact(s) named by {arguments.only_ids}")
    if arguments.exclude_ids:
        try:
            excluded = set(json.loads(Path(arguments.exclude_ids).expanduser().read_text(encoding="utf-8")))
        except (OSError, ValueError) as error:
            parser.error(f"cannot read --exclude-ids: {error}")
        before = len(refs)
        refs = [ref for ref in refs if ref.artifact_id not in excluded]
        print(f"Excluded {before - len(refs)} artifact(s) named by {arguments.exclude_ids}")
    done = already_done(records_path, parser) if arguments.resume else set()
    pending = [ref for ref in refs if (ref.artifact_type, ref.artifact_id) not in done]
    if arguments.limit is not None:
        pending = pending[:arguments.limit]
    by_type = collections.Counter(ref.artifact_type for ref in pending)

    for repair in repairs:
        print(f"Repair: {repair.name} ({repair.summary})")
    print(f"Targets named by: {', '.join([c for c in conditions if c] + patterns) or 'nothing'}")
    print(f"Server: {arguments.server}")
    print(f"Targets: {len(pending)} artifacts ({audit.counts_text(by_type)}) "
          f"from {arguments.from_records}" + (f", {len(done)} already done" if done else ""))
    print(f"Mode: {'APPLY, writing with PUT ?verbatim=true' if arguments.apply else 'dry run, no writes'}"
          + (f"; {arguments.workers} workers" if arguments.workers > 1 else "; serial"))
    print(f"Records: {records_path}; summary: {summary_path}")
    if arguments.apply:
        print(f"Pre-images: {preimages}")
    if not pending:
        print("nothing to do")
        return 0

    for flag, supplied, into in (("--mapping", arguments.mapping, RENAMES),
                                 ("--required-removals", arguments.required_removals, REQUIRED_REMOVALS),
                                 ("--schema-shape-plan", arguments.schema_shape_plan, SCHEMA_SHAPE_PLANS),
                                 ("--context-object-plan", arguments.context_object_plan, CONTEXT_OBJECT_PLANS),
                                 ("--acronyms", arguments.acronyms, ACRONYMS),
                                 ("--branches", arguments.branches, BRANCHES),
                                 ("--terms", arguments.terms, TERMS),
                                 ("--free-fields", arguments.free_fields, FREE_FIELDS),
                                 ("--declare-fields", arguments.declare_fields, DECLARED_FIELDS)):
        if not supplied:
            continue
        try:
            into.update(json.loads(Path(supplied).expanduser().read_text(encoding="utf-8")))
        except (OSError, ValueError) as error:
            parser.error(f"cannot read {flag} {supplied}: {error}")
    java, classpath = audit.resolve_toolchain(arguments, parser)
    try:
        client = RepairClient(arguments.server, api_key, timeout=arguments.timeout, retries=arguments.retries,
                              delay_ms=arguments.delay_ms, ca_file=arguments.ca_file,
                              allow_http=arguments.allow_http)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    bridge = audit.ValidationBridge(java, classpath, audit.BRIDGE_SOURCE, 200, arguments.jvm_heap,
                                    java_log, 120)
    try:
        hello = bridge.start()
    except (audit.BridgeError, TimeoutError, OSError) as error:
        parser.error(f"cannot start the validation bridge: {error} (see {java_log})")
    print(f"Validator: {hello.get('validator')} on Java {hello.get('java')}", flush=True)

    guarded_bridge = GuardedBridge(bridge, arguments.bridge_max_restarts)
    # The resolver talks to the bridge too, to hand it a template it has not cached. Through the
    # guard, or its write lands in the middle of another worker's request and each reads the
    # other's answer.
    resolver = GuardedResolver(audit.TemplateResolver(client, guarded_bridge, 200))
    progress = Progress(total=len(pending))
    status = "COMPLETE"
    details: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    bookkeeping = threading.Lock()
    REPORTABLE = {"still-invalid", "invariant-failed", "transform-refused", "fetch-failed",
                  "write-failed"}
    try:
        with rest.open_private_text_file(records_path, append=arguments.resume) as stream:

            def record_outcome(ref: rest.ArtifactRef, record: dict[str, Any]) -> None:
                with bookkeeping:
                    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                    stream.flush()
                    progress.note(record["outcome"], len(record.get("pathsRemoved") or []))
                    if record["outcome"] == "repaired" and record.get("verified") is False:
                        details["unverified"].append({"artifactId": ref.artifact_id,
                                                      "artifactType": ref.artifact_type,
                                                      "detail": record.get("detail", "")})
                    if record["outcome"] in REPORTABLE:
                        details[record["outcome"]].append(
                            {"artifactId": ref.artifact_id, "artifactType": ref.artifact_type,
                             "detail": record.get("detail", "")})
                        print(f"! {record['outcome']} {ref.artifact_type} {ref.artifact_id}: "
                              f"{record.get('detail', '')[:200]}", file=sys.stderr)
                    if progress.due(arguments.progress_every, arguments.progress_seconds):
                        progress.report(applied=arguments.apply)

            if arguments.workers <= 1:
                for ref in pending:
                    record_outcome(ref, repair_one(arguments, repairs, client, guarded_bridge,
                                                   resolver, ref))
            else:
                # Each artifact is independent and appears once, and every write carries If-Match, so
                # workers cannot race one another onto the same document.
                with ThreadPoolExecutor(max_workers=arguments.workers) as pool:
                    futures = {pool.submit(repair_one, arguments, repairs, client, guarded_bridge,
                                           resolver, ref): ref for ref in pending}
                    try:
                        for future in as_completed(futures):
                            record_outcome(futures[future], future.result())
                    except BaseException:
                        for pending_future in futures:
                            pending_future.cancel()
                        raise
    except KeyboardInterrupt:
        status = "INTERRUPTED"
    except rest.AuthenticationError as error:
        status = "AUTHENTICATION_ERROR"
        print(f"! {error}", file=sys.stderr)
    except audit.BridgeError as error:
        status = "BRIDGE_FAILURE"
        print(f"! {error}", file=sys.stderr)
    finally:
        guarded_bridge.close()
        progress.report(final=True, applied=arguments.apply)

    summary = {
        "tool": {"script": Path(__file__).name, "scriptSha256": audit.file_sha256(Path(__file__)),
                 "repairs": [r.name for r in repairs], "conditions": conditions,
                 "summaries": [r.summary for r in repairs]},
        "status": status,
        "mode": "apply" if arguments.apply else "dry-run",
        "server": arguments.server,
        "finishedAt": audit.utc_now(),
        "elapsedSeconds": round(time.monotonic() - progress.started, 3),
        "targets": len(pending),
        "targetsByType": dict(sorted(by_type.items())),
        "outcomes": {name: progress.outcomes[name] for name in OUTCOMES if progress.outcomes[name]},
        "pathsCleared": progress.paths_removed,
        "repairedButUnverified": len(details.get("unverified", [])),
        "problems": {name: values[:200] for name, values in details.items()},
        "files": {"records": str(records_path), "preimages": str(preimages) if arguments.apply else None},
    }
    rest.atomic_write_json(summary_path, summary)

    print("\n=== Summary ===")
    print(f"status: {status}; mode: {'apply' if arguments.apply else 'dry run'}")
    for name in OUTCOMES:
        if progress.outcomes[name]:
            print(f"  {name:<16} {progress.outcomes[name]}")
    print(f"paths {'cleared' if arguments.apply else 'to clear'}: {progress.paths_removed}")
    print(f"records: {records_path}")
    print(f"summary: {summary_path}")
    if arguments.apply:
        print(f"pre-images: {preimages}")
    else:
        print("no writes were issued; re-run with --apply to repair")
    if details.get("unverified"):
        print(f"  repaired but read-back could not confirm: {len(details['unverified'])}")
    failed = sum(progress.outcomes[name] for name in ("write-failed", "invariant-failed", "fetch-failed")) \
        + len(details.get("unverified", []))
    if status != "COMPLETE":
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
