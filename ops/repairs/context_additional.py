"""Plan narrow, Java-confirmed instance-context additionalProperties repairs.

Callers must validate complete schema candidates and all dependent instances before writes.
No instance data, schema-owned context, or container-level additionalProperties is changed.
"""
import copy
import cedar_artifact_repair as repair
import cedar_artifact_rest_audit as rest

TEMPLATE = 'https://schema.metadatacenter.org/core/Template'
URI_MAPPING = {'type': 'string', 'format': 'uri'}


def canonical_rule(container):
    return copy.deepcopy(URI_MAPPING) if any(
        child.get('_ui', {}).get('inputType') == 'attribute-value'
        for _, child, _ in repair.container_children(container)
    ) else False


def known_rule(value):
    return value is False or repair.json_equal(value, URI_MAPPING)


def plan_schema(source, canonical):
    candidate = copy.deepcopy(source)
    changes = []

    def walk(node, java, path):
        if node.get('@type') not in (TEMPLATE, rest.TEMPLATE_ELEMENT):
            return
        context = node['properties']['@context']
        old = context['additionalProperties']
        wanted = java['properties']['@context']['additionalProperties']
        if not known_rule(old) or not known_rule(wanted):
            raise ValueError('unreviewed context rule at ' + path)
        if not repair.json_equal(wanted, canonical_rule(node)):
            raise ValueError('Java rule differs from direct attribute-value children at ' + path)
        if not repair.json_equal(old, wanted):
            context['additionalProperties'] = copy.deepcopy(wanted)
            changes.append({'path': path, 'before': old, 'after': wanted,
                            'direction': 'tighten' if wanted is False else 'relax'})
        for name, child, multiple in repair.container_children(node):
            if not repair.is_element(child):
                continue
            ptr = '/properties/' + rest.json_pointer_component(name)
            other = java['properties'][name]
            if multiple:
                ptr += '/items'
                other = other['items']
            walk(child, other, path + ptr)
    walk(candidate, canonical, '')
    assert_only_context_rules(source, candidate, changes)
    return candidate, changes


def assert_only_context_rules(before, after, changes):
    restored = copy.deepcopy(after)
    seen = set()
    for change in changes:
        path = change['path']
        assert path not in seen
        seen.add(path)
        old = repair.value_at(before, path)
        new = repair.value_at(restored, path)
        assert old.get('@type') in (TEMPLATE, rest.TEMPLATE_ELEMENT)
        was = old['properties']['@context']['additionalProperties']
        now = new['properties']['@context']['additionalProperties']
        assert known_rule(was) and known_rule(now)
        assert repair.json_equal(was, change['before'])
        assert repair.json_equal(now, change['after'])
        assert not repair.json_equal(was, now)
        assert repair.json_equal(now, canonical_rule(old))
        new['properties']['@context']['additionalProperties'] = copy.deepcopy(was)
    assert repair.json_equal(before, restored), 'unexpected schema change'


def is_pure_relaxation(before, after, changes):
    """A verified false → URI-rule change cannot reject any previously valid instance."""
    assert_only_context_rules(before, after, changes)
    return bool(changes) and all(change['before'] is False for change in changes)
