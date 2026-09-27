"""Plan narrowly scoped child property-IRI additions and matching instance contexts.

The repository owns missing identities. Reuse an unambiguous existing instance IRI before
minting a UUID in its namespace. Attribute-value groups and display-only fields do not
have a fixed child property IRI. This module never sends HTTP requests.
"""
import copy
import uuid

import cedar_artifact_repair as repair


class Conflict(ValueError):
    pass


def occurrences(instance, route):
    """Yield existing container occurrences, preserving array indexes in JSON pointers."""
    pending = [(instance, "")]
    for name in route:
        following = []
        for container, path in pending:
            if not isinstance(container, dict):
                raise Conflict(f"Non-object container at {path or '/'}")
            if name not in container:
                continue
            child = container[name]
            here = path + "/" + repair.rest.json_pointer_component(name)
            if isinstance(child, list):
                following.extend((item, here + "/" + str(i)) for i, item in enumerate(child))
            elif isinstance(child, dict):
                following.append((child, here))
            elif child is not None:
                raise Conflict(f"Non-object element at {here}")
        pending = following
    for container, path in pending:
        if not isinstance(container, dict):
            raise Conflict(f"Non-object container at {path or '/'}")
        yield container, path


def existing_iri(context, name):
    if context is None:
        return None
    if not isinstance(context, dict):
        raise Conflict("Instance context is not an object")
    if name not in context or context[name] in (None, ""):
        return None
    value = context[name]
    if not isinstance(value, str) or not repair.rest.is_absolute_iri(value):
        raise Conflict(f"Unsupported existing context mapping for {name}: {value!r}")
    return value


def resolve_slots(slots, instances):
    result = copy.deepcopy(slots)
    for slot in result:
        values = set()
        for instance in instances:
            for container, _ in occurrences(instance, slot['route']):
                value = existing_iri(container.get('@context'), slot['name'])
                if value is not None:
                    values.add(value)
        if len(values) > 1:
            raise Conflict(f"Conflicting instance IRIs at {slot['path']}/{slot['name']}: {sorted(values)}")
        slot['iri'] = next(iter(values)) if values else repair.PROPERTY_IRI_PREFIX + str(uuid.uuid4())
        slot['origin'] = 'existing-instance' if values else 'generated'
    return result


def patch_schema(source, slots):
    candidate = copy.deepcopy(source)
    for slot in slots:
        container = repair.value_at(candidate, slot['path'])
        child = container['properties'][slot['name']]
        child = child.get('items', child)
        if child.get('_ui', {}).get('inputType') in {
            'attribute-value', 'richtext', 'image', 'youtube', 'section-break', 'page-break'
        }:
            raise Conflict('Child does not take a fixed property IRI')
        context = container['properties']['@context']
        mapping = context['properties']
        if slot['name'] in mapping:
            raise Conflict('Refusing to replace an existing schema mapping')
        if not repair.rest.is_absolute_iri(slot['iri']):
            raise Conflict('Property IRI must be absolute')
        mapping[slot['name']] = {'enum': [slot['iri']]}
        required = context.setdefault('required', [])
        if not isinstance(required, list):
            raise Conflict('Context required is not an array')
        if slot['name'] not in required:
            required.append(slot['name'])
    return candidate


def patch_instance(source, slots):
    candidate = copy.deepcopy(source)
    for slot in slots:
        for container, _ in occurrences(candidate, slot['route']):
            value = existing_iri(container.get('@context'), slot['name'])
            if value is not None and value != slot['iri']:
                raise Conflict('Refusing to change an existing property identity')
            if '@context' not in container or container['@context'] is None:
                container['@context'] = {}
            container['@context'][slot['name']] = slot['iri']
    return candidate


def assert_only_context_changes(before, after, slots, schema=False):
    """Independent mask comparison proves entered values and other schema declarations unchanged."""
    masked = copy.deepcopy(after)
    if schema:
        for path in {slot['path'] for slot in slots}:
            old = repair.value_at(before, path)['properties']['@context']
            new = repair.value_at(masked, path)['properties']['@context']
            names = [slot['name'] for slot in slots if slot['path'] == path]
            for name in names:
                if name in old['properties']:
                    raise Conflict('Schema mapping was already present')
                iri = next(s['iri'] for s in slots if s['path'] == path and s['name'] == name)
                if new['properties'].get(name) != {'enum': [iri]}:
                    raise Conflict('Unexpected property IRI definition')
                new['properties'].pop(name)
            if 'required' in old:
                expected = old['required'] + [name for name in names if name not in old['required']]
                if new['required'] != expected:
                    raise Conflict('Unexpected required-list change')
                new['required'] = copy.deepcopy(old['required'])
            else:
                if new['required'] != names:
                    raise Conflict('Unexpected required-list creation')
                del new['required']
    else:
        seen = set()
        for slot in slots:
            for _, path in occurrences(before, slot['route']):
                if path in seen:
                    continue
                seen.add(path)
                old = repair.value_at(before, path)
                new = repair.value_at(masked, path)
                changed_names = [s['name'] for s in slots if s['route'] == slot['route']]
                for s in slots:
                    if s['route'] == slot['route'] and (new.get('@context') or {}).get(s['name']) != s['iri']:
                        raise Conflict('Unexpected instance property IRI')
                for name in set(old.get('@context') or {}) | set(new.get('@context') or {}):
                    if name not in changed_names and (old.get('@context') or {}).get(name) != (new.get('@context') or {}).get(name):
                        raise Conflict('Unrelated instance context changed')
                if '@context' in old:
                    new['@context'] = copy.deepcopy(old['@context'])
                else:
                    new.pop('@context', None)
    if not repair.json_equal(before, masked):
        raise Conflict('Unexpected change outside the approved mappings')


def missing_slots(schema):
    """Locate genuine missing mappings, including children embedded below repeated elements."""
    slots = []
    def walk(container, path, route):
        for name, child, multiple, error in repair.rest.direct_schema_children(container):
            if error or child is None:
                continue
            kind = child.get('_ui', {}).get('inputType', 'element')
            mapping = repair.context_properties(container)
            present, iri = repair.mapped_property_iri(mapping.get(name) if mapping else None)
            if (not present or not repair.rest.is_absolute_iri(iri)) and kind not in {
                'attribute-value', 'richtext', 'image', 'youtube', 'section-break', 'page-break'
            }:
                slots.append({'path': path, 'route': route, 'name': name, 'inputType': kind})
            walk(child, path + '/properties/' + repair.rest.json_pointer_component(name)
                 + ('/items' if multiple else ''), route + [name])
    walk(schema, '', [])
    return slots
