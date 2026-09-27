"""Narrow, schema-checked repairs for mixed instance values and obvious URI paste errors."""
import copy
import re


def repair(source, template):
    result = copy.deepcopy(source)
    changes, unresolved = [], []

    def record(node, key, new, path, reason, delete=False):
        old = node[key]
        changes.append({'path': path + [key], 'before': old, 'after': new, 'delete': delete, 'reason': reason})
        if delete:
            del node[key]
        else:
            node[key] = new

    def walk(node, schema, path):
        if isinstance(node, list):
            child_schema = schema.get('items', schema) if isinstance(schema, dict) else {}
            for i, child in enumerate(node):
                walk(child, child_schema, path + [i])
            return
        if not isinstance(node, dict):
            return
        props = schema.get('properties', {}) if isinstance(schema, dict) else {}
        field = '@value' in props or '@id' in props and '@context' not in props
        iri_field = field and '@id' in props and '@value' not in props
        if '@id' in node and '@value' in node:
            if iri_field and (node['@value'] is None or node['@value'] == node['@id']):
                record(node, '@value', None, path, 'Remove null or exact duplicate literal from schema-declared IRI field', True)
            elif field and '@value' in props and '@id' not in props and node['@id'] in (None, ''):
                record(node, '@id', None, path, 'Remove empty identifier from schema-declared literal field', True)
            else:
                unresolved.append({'path': path, 'reason': 'Mixed values are conflicting or the template does not establish a safe deletion'})
        if iri_field and isinstance(node.get('@id'), str):
            value = node['@id']
            trimmed = value.strip()
            if not trimmed:
                if '@id' not in schema.get('required', []):
                    record(node, '@id', None, path, 'Remove empty optional IRI', True)
                else:
                    unresolved.append({'path': path + ['@id'], 'reason': 'Required IRI is empty'})
            elif trimmed != value and not re.search(r'\s', trimmed) and re.match(r'^https?://[^/]+/', trimmed):
                record(node, '@id', trimmed, path, 'Remove surrounding clipboard whitespace from a single URL')
            else:
                # ORCID's identifier grammar and checksum establish the missing whitespace boundary.
                candidate = re.sub(r'\s+', '', value)
                m = re.fullmatch(r'https://orcid.org/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])', candidate)
                if m and candidate != value:
                    digits = m[1].replace('-', '')
                    total = 0
                    for digit in digits[:-1]: total = (total + int(digit)) * 2
                    check = (12 - total % 11) % 11
                    if digits[-1] == ('X' if check == 10 else str(check)):
                        record(node, '@id', candidate, path, 'Remove pasted whitespace from a checksum-valid ORCID URL')
        for name, child in list(node.items()):
            if name in props and not name.startswith('@') and name != '_annotations':
                walk(child, props[name], path + [name])
    walk(result, template, [])
    # Replay every declared change against the original: no undeclared alteration may escape.
    expected = copy.deepcopy(source)
    for change in changes:
        node = expected
        for key in change['path'][:-1]: node = node[key]
        key = change['path'][-1]
        assert type(node[key]) is type(change['before']) and node[key] == change['before']
        if change['delete']: del node[key]
        else: node[key] = change['after']
    assert expected == result
    return result, changes, unresolved
