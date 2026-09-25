"""Plan additive child-presence repairs against Java-rendered schema requirements.

No network or writes. Callers must validate whole candidates and check every dependent
instance before tightening a template. Existing values and declarations are immutable.
"""
import copy
import cedar_artifact_repair as repair
import cedar_artifact_rest_audit as rest


def plan_schema(source, canonical):
    candidate = copy.deepcopy(source)
    changes = []

    def walk(node, java, path):
        if node.get('@type') not in ("https://schema.metadatacenter.org/core/Template", rest.TEMPLATE_ELEMENT):
            return
        declared = {name: (child, multiple) for name, child, multiple in repair.container_children(node)}
        old = node.get('required', [])
        wanted = java.get('required', [])
        if not isinstance(old, list) or not isinstance(wanted, list):
            raise ValueError('non-array required at ' + path)
        add = [name for name in wanted if name in declared and name not in old]
        if add:
            node['required'] = old + add
            changes.append({'path': path, 'names': add})
        for name, (child, multiple) in declared.items():
            if not repair.is_element(child):
                continue
            ptr = '/properties/' + rest.json_pointer_component(name)
            other = java['properties'][name]
            if multiple:
                other = other['items']
                ptr += '/items'
            walk(child, other, path + ptr)
    walk(candidate, canonical, '')
    assert_schema_additions(source, candidate, changes)
    return candidate, changes


def assert_schema_additions(before, after, changes):
    restored = copy.deepcopy(after)
    for change in changes:
        old = repair.value_at(before, change['path'])
        new = repair.value_at(restored, change['path'])
        children = {name: child for name, child, multiple in repair.container_children(old)}
        names = change['names']
        assert len(set(names)) == len(names)
        assert all(name in children and children[name].get('@type') != repair.STATIC_AT_TYPE
                   and name not in old.get('required', []) for name in names)
        assert new['required'] == old.get('required', []) + names
        if 'required' in old:
            new['required'] = old['required']
        else:
            new.pop('required')
    assert repair.json_equal(before, restored), 'unexpected schema change'


def complete_instance(source, template):
    """Add empty shapes only for absent required children; never rewrite existing data."""
    candidate = copy.deepcopy(source)

    def walk(node, schema):
        if not isinstance(node, dict):
            return
        for name, child, multiple in repair.container_children(schema):
            if child.get('@type') == repair.STATIC_AT_TYPE:
                continue
            if name not in node and name in schema.get('required', []):
                declaration = schema['properties'][name]
                minimum = declaration.get('minItems', 0)
                node[name] = repair.empty_instance_value(child, multiple, minimum)
                iri = repair.declared_context_iris(schema).get(name)
                if iri:
                    context = node.setdefault('@context', {})
                    if not isinstance(context, dict):
                        raise ValueError('non-object instance context')
                    if name in context and context[name] != iri:
                        raise ValueError('conflicting property IRI for ' + name)
                    context[name] = iri
            if name in node and repair.is_element(child):
                value = node[name]
                for occurrence in value if multiple and isinstance(value, list) else [value]:
                    walk(occurrence, child)
    walk(candidate, template)
    assert_instance_additions(source, candidate, template)
    return candidate


def assert_preserved(before, after):
    """Independent guard: every pre-existing key, array occurrence and scalar is unchanged."""
    if isinstance(before, dict):
        assert isinstance(after, dict) and before.keys() <= after.keys()
        for key, value in before.items():
            assert_preserved(value, after[key])
    elif isinstance(before, list):
        assert isinstance(after, list) and len(before) == len(after)
        for old, new in zip(before, after):
            assert_preserved(old, new)
    else:
        assert repair.json_equal(before, after), 'existing value changed'


def assert_instance_additions(before, after, schema):
    assert_preserved(before, after)
    if not isinstance(before, dict):
        return
    children = {name: (child, multiple) for name, child, multiple in repair.container_children(schema)}
    added = after.keys() - before.keys()
    for name in added - {'@context'}:
        assert name in children and name in schema.get('required', [])
        assert repair.only_completed_absences({}, {name: after[name]}, schema) is None
    old_context = before.get('@context', {})
    new_context = after.get('@context', {})
    if not repair.json_equal(old_context, new_context):
        assert isinstance(old_context, dict) and isinstance(new_context, dict)
        iris = repair.declared_context_iris(schema)
        expected = copy.deepcopy(old_context)
        for name in new_context.keys() - old_context.keys():
            assert name in added and new_context[name] == iris[name]
            expected[name] = iris[name]
        assert repair.json_equal(expected, new_context), 'existing context mapping changed'
    for name in before.keys() - {'@context'}:
        if name not in children or not repair.is_element(children[name][0]):
            assert repair.json_equal(before[name], after[name]), 'existing field changed'
    for name, (child, multiple) in children.items():
        if name in before and repair.is_element(child):
            old, new = before[name], after[name]
            if multiple and isinstance(old, list):
                for a, b in zip(old, new):
                    assert_instance_additions(a, b, child)
            elif not multiple and isinstance(old, dict):
                assert_instance_additions(old, new, child)
            else:
                assert repair.json_equal(old, new), 'malformed occurrence changed'
