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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as audit  # noqa: E402

DERIVED_FROM = "pav:derivedFrom"
AT_ID = "@id"
AT_TYPE = "@type"
ELEMENT_AT_TYPE = "https://schema.metadatacenter.org/core/TemplateElement"
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
# What a container's own title is composed from, by the same rule the artifact server applies on every
# ordinary write. A static field is a field here, as it is everywhere identifiers and titles are formed.
KIND_WORD = {
    "https://schema.metadatacenter.org/core/Template": "template",
    ELEMENT_AT_TYPE: "element",
    "https://schema.metadatacenter.org/core/TemplateField": "field",
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
    """
    changes: list[dict[str, Any]] = []

    def walk(container: Any, path: str) -> Any:
        if not isinstance(container, dict):
            return container
        result = copy.deepcopy(container)
        mapped = mapped_serializing_children(result)
        properties = result.get("properties")
        context = properties.get("@context") if isinstance(properties, dict) else None
        if mapped and isinstance(context, dict) and isinstance(context.get("required"), list):
            listed = [entry for entry in context["required"] if isinstance(entry, str)]
            omitted = [name for name in
                       (n for n, _child, _multiple in container_children(result)) if
                       name in mapped and name not in listed]
            if omitted:
                context["required"] = list(context["required"]) + omitted
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
        if not isinstance(new, dict) or set(old) != set(new):
            return path
        for name in old:
            here = f"{path}/{rest.json_pointer_component(name)}"
            if name == "required" and isinstance(old[name], list) and isinstance(new.get(name), list):
                kept, appended = new[name][:len(old[name])], new[name][len(old[name]):]
                if kept != old[name]:
                    return here
                if any(entry not in mapped or entry in old[name] for entry in appended):
                    return here
                continue
            if type(old[name]) is not type(new[name]) or old[name] != new[name]:
                return here
        return None

    return walk(before, after, "")


def wrap_inherently_multiple(artifact: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Deploy an inherently multiple child as the array it always serializes to.

    Checkbox, attribute-value and multiple-choice list fields emit arrays whenever they are deployed,
    so a container describing one as an object rejects every populated instance of itself. The field's
    own metadata stays on the inner definition and cardinality moves to the array envelope, which is
    the same repair the patch tool makes. A standalone field artifact is excluded: it is the reusable
    inner definition and is correctly object-shaped, so only children under a container are examined.
    """
    changes: list[dict[str, Any]] = []

    def inherently_multiple(field: Any) -> bool:
        ui = field.get("_ui") if isinstance(field, dict) else None
        if not isinstance(ui, dict):
            return False
        if ui.get("inputType") in {"checkbox", "attribute-value"}:
            return True
        constraints = field.get("_valueConstraints")
        return ui.get("inputType") == "list" and isinstance(constraints, dict) \
            and constraints.get("multipleChoice") is True

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


CONTEXT_ENUM_ERROR = r"^/@context/.+: does not have a value in the enumeration"


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


REPAIRS = {
    "empty-derived-from": Repair(
        name="empty-derived-from",
        condition="derived-from-empty",
        summary="delete every pav:derivedFrom whose value is the empty string",
        transform=strip_empty_derived_from,
        invariant=only_removed_empty_derived_from,
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
                    found.update(json.loads(line).get("conditionRules") or {})
                except (ValueError, AttributeError):
                    continue
    except OSError:
        return []
    return sorted(found)


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
                record = json.loads(line)
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
    rest.atomic_write_json(path, document)
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
        record.update(outcome="already-clean")
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
            still = apply_repairs(repairs, back, template)[1]  # a repaired artifact offers nothing
            record["verified"] = not still
            if still:
                record["detail"] = f"{len(still)} path(s) still present after the write"
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
    parser.add_argument("--condition",
                        help="audit condition naming the targets (default: any condition the repairs name)")
    parser.add_argument("--from-records", required=True,
                        help="records JSONL from cedar_artifact_validation_audit.py, the target list")
    parser.add_argument("--server", default=rest.DEFAULT_SERVER,
                        help=f"resource server origin (default: {rest.DEFAULT_SERVER})")
    parser.add_argument("--api-key-file", help="read the API key from this one-line file")
    parser.add_argument("--apply", action="store_true", help="write; otherwise report what would change")
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
    resolver = GuardedResolver(audit.TemplateResolver(client, bridge, 200))
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
