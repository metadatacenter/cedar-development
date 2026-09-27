"""Synthetic, non-production RDF contract cases with independently authored N-Quads.

Expected datasets describe statements, not a particular processor's formatting.
Some cases intentionally expose unsupported or lossy input; a failure is a finding.
"""
import copy
import json

S = 'https://example.org/instance'
P = 'https://example.org/p/'
X = 'http://www.w3.org/2001/XMLSchema#'
R = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
CASES = []


def literal(value, datatype=None, language=None):
    text = json.dumps(value, ensure_ascii=False)
    return text + ('@' + language if language else '^^<' + datatype + '>' if datatype else '')


def quad(predicate, obj, subject=S, graph=None):
    subject = subject if subject.startswith('_:') else '<' + subject + '>'
    return f'{subject} <{predicate}> {obj}' + (f' <{graph}>' if graph else '') + ' .\n'


def case(name, source, expected=None, why=''):
    CASES.append(dict(id=name, source=source, expectedNquads=expected,
                      expect='reject' if expected is None else 'dataset', rationale=why))


def field(name, value, obj, definition=None):
    case(name, {'@context': {'xsd': X, 'Field': definition or P+'field'}, '@id': S,
                'Field': value}, quad(P+'field', obj))


for name, value in [('plain', 'hello'), ('empty-string', ''), ('unicode', 'Français 中文 🧪'),
                    ('escaped-string', 'quote " slash \\ tab\t newline\n'), ('controls', '\x00\x01\x1f')]:
    field(name, {'@value': value}, literal(value))
for name, value, datatype in [('integer', '003', 'integer'), ('decimal', '1.20', 'decimal'),
                               ('boolean-lexical', 'true', 'boolean'), ('date', '2026-09-26', 'date'),
                               ('time', '12:34:56', 'time'), ('year-month', '2026-09', 'gYearMonth'),
                               ('datetime', '2026-09-26T12:34:56Z', 'dateTime')]:
    field(name, {'@value': value, '@type': 'xsd:'+datatype}, literal(value, X+datatype))
field('language', {'@value': 'bonjour', '@language': 'fr'}, literal('bonjour', language='fr'))
field('language-case', {'@value': 'Hello', '@language': 'EN-us'}, literal('Hello', language='en-us'))
field('native-integer', {'@value': 3}, literal('3', X+'integer'))
field('native-boolean', {'@value': True}, literal('true', X+'boolean'))
field('native-double', {'@value': 1.5}, literal('1.5E0', X+'double'))
# JSON-LD 1.1 Object-to-RDF steps 10/11 canonicalize numbers, not string-valued literals.
field('typed-double-string', {'@value': '120', '@type': 'xsd:double'}, literal('120', X+'double'))
field('typed-double-number', {'@value': 120, '@type': 'xsd:double'}, literal('1.2E2', X+'double'))
field('small-double', {'@value': 1.2e-20}, literal('1.2E-20', X+'double'))
field('typed-float-string', {'@value': '120', '@type': 'xsd:float'}, literal('120', X+'float'))
field('custom-datatype', {'@value': 'abc', '@type': 'https://example.org/custom'},
      literal('abc', 'https://example.org/custom'))
for name, iri in [('link', 'https://example.org/link'), ('unicode-iri', 'https://example.org/é'),
                   ('nbsp-iri', 'https://example.org/a\u00a0b')]:
    field(name, {'@id': iri}, '<'+iri+'>')
field('context-iri-coercion', 'https://example.org/link', '<https://example.org/link>',
      {'@id': P+'field', '@type': '@id'})
field('context-datatype', '9', literal('9', X+'int'), {'@id': P+'field', '@type': 'xsd:int'})
field('context-language', 'salut', literal('salut', language='fr'),
      {'@id': P+'field', '@language': 'fr'})
for name, key in [('slash-name', 'Date (month/year)'), ('colon-name', 'Time: start'),
                  ('url-name', 'https://example.org/name'), ('yaml-keyword', 'type')]:
    case(name, {'@context': {key: P+'field'}, '@id': S, key: {'@value': 'kept'}},
         quad(P+'field', literal('kept')))
case('empty-fields', {'@context': {'A': P+'a', 'B': P+'b', 'C': P+'c'}, '@id': S,
                     'A': {}, 'B': {'@value': None}, 'C': []}, '')
case('empty-occurrences', {'@context': {'A': P+'a'}, '@id': S,
                          'A': [{}, {'@value': None}, {'@value': 'kept'}]}, quad(P+'a', literal('kept')))
case('root-blank', {'@context': {'A': P+'a'}, '@id': None, 'A': {'@value': 'kept'}},
     quad(P+'a', literal('kept'), '_:root'))
case('repeated-nodes', {'@context': {'Sample': P+'sample'}, '@id': S, 'Sample': [
    {'@id': None, '@context': {'Label': P+'label'}, 'Label': {'@value': label}}
    for label in ['first', 'second']]}, ''.join(
        quad(P+'sample', '_:'+label) + quad(P+'label', literal(label), '_:'+label)
        for label in ['first', 'second']))
case('distinct-equal-blank-nodes', {'@context': {'Sample': P+'sample', 'Label': P+'label'}, '@id': S,
     'Sample': [{'Label': {'@value': 'same'}}, {'Label': {'@value': 'same'}}]},
     ''.join(quad(P+'sample', '_:'+n)+quad(P+'label', literal('same'), '_:'+n) for n in ['a', 'b']))
case('nested-override', {'@context': {'Sample': P+'sample', 'Name': P+'outer'}, '@id': S,
     'Name': {'@value': 'root'}, 'Sample': {'@id': 'https://example.org/child',
     '@context': {'Name': P+'inner'}, 'Name': {'@value': 'child'}}},
     quad(P+'outer', literal('root'))+quad(P+'sample', '<https://example.org/child>')+
     quad(P+'inner', literal('child'), 'https://example.org/child'))
case('attribute-group', {'@context': {'colour': P+'colour', 'size': P+'size'}, '@id': S,
     'Attributes': ['colour', 'size'], 'colour': {'@value': 'blue'}, 'size': {'@value': 'large'}},
     quad(P+'colour', literal('blue'))+quad(P+'size', literal('large')))
case('annotations-nest', {'@context': {'_annotations': '@nest', 'note': P+'note'}, '@id': S,
     '_annotations': {'note': [{'@value': 'reviewed'}, {'@id': 'https://example.org/ref'}]}},
     quad(P+'note', literal('reviewed'))+quad(P+'note', '<https://example.org/ref>'))
case('controlled-term-labels', {'@context': {'Term': P+'term', 'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
     'skos': 'http://www.w3.org/2004/02/skos/core#'}, '@id': S, 'Term': {'@id': 'https://example.org/term',
     'rdfs:label': 'label', 'skos:notation': 'CODE'}}, quad(P+'term', '<https://example.org/term>')+
     quad('http://www.w3.org/2000/01/rdf-schema#label', literal('label'), 'https://example.org/term')+
     quad('http://www.w3.org/2004/02/skos/core#notation', literal('CODE'), 'https://example.org/term'))
case('provenance', {'@context': {'pav': 'http://purl.org/pav/', 'xsd': X,
     'pav:derivedFrom': {'@type': '@id'}, 'pav:createdOn': {'@type': 'xsd:dateTime'}}, '@id': S,
     'pav:derivedFrom': 'https://example.org/original', 'pav:createdOn': '2026-09-26T00:00:00Z'},
     quad('http://purl.org/pav/derivedFrom', '<https://example.org/original>')+
     quad('http://purl.org/pav/createdOn', literal('2026-09-26T00:00:00Z', X+'dateTime')))
case('rdf-types', {'@id': S, '@type': ['https://example.org/A', 'https://example.org/B']},
     quad(R+'type', '<https://example.org/A>')+quad(R+'type', '<https://example.org/B>'))
case('rdf-list', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@list': ['first', 'second']}},
     quad(P+'a', '_:a')+quad(R+'first', literal('first'), '_:a')+quad(R+'rest', '_:b', '_:a')+
     quad(R+'first', literal('second'), '_:b')+quad(R+'rest', '<'+R+'nil>', '_:b'))
case('named-graph', {'@id': 'https://example.org/graph', '@graph': [
     {'@id': S, P+'field': {'@value': 'kept'}}]}, quad(P+'field', literal('kept'), graph='https://example.org/graph'),
     'JSON-LD dataset probe; Turtle cannot preserve named graphs.')
case('duplicate-rdf-statements', {'@context': {'A': P+'a'}, '@id': S,
     'A': [{'@value': 'same'}, {'@value': 'same'}]}, quad(P+'a', literal('same')))
case('alias-collision', {'@context': {'Date/year': P+'date', 'cee-term-0': P+'other'}, '@id': S,
     'Date/year': {'@value': '2026'}, 'cee-term-0': {'@value': 'other'}},
     quad(P+'date', literal('2026'))+quad(P+'other', literal('other')),
     'Aliasing must not overwrite a real child named cee-term-0.')
case('literal-array-matches-child-names', {'@context': {'A': P+'a', 'B': P+'b'}, '@id': S,
     'A': ['B'], 'B': {'@value': 'kept'}}, quad(P+'a', literal('B'))+quad(P+'b', literal('kept')),
     'General JSON-LD boundary probe: string arrays are not always CEDAR attribute groups.')
for name, source in [
    ('remote-context', {'@context': 'https://example.org/never-fetch', '@id': S}),
    ('unmapped-field', {'@context': {}, '@id': S, 'Unmapped': {'@value': 'lost'}}),
    ('unmapped-attribute', {'@context': {}, '@id': S, 'Attributes': ['colour'], 'colour': {'@value': 'blue'}}),
    ('mixed-id-value', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@id': 'https://example.org/a', '@value': 'text'}}),
    ('multiple-datatypes', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@value': '3', '@type': [X+'int', X+'string']}}),
    ('relative-value-id', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@id': 'relative'}}),
    ('malformed-value-id', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@id': 'https://example.org/a b'}}),
    ('empty-value-id', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@id': ''}}),
    ('null-context-term', {'@context': {'A': None}, '@id': S, 'A': {'@value': 'lost'}}),
    ('literal-with-label', {'@context': {'A': P+'a', 'label': P+'label'}, '@id': S,
                            'A': {'@value': 'text', 'label': 'label'}}),
    ('null-literal-with-label', {'@context': {'A': P+'a', 'label': P+'label'}, '@id': S,
                                 'A': {'@value': None, 'label': 'kept label'}}),
    ('mixed-id-null-value', {'@context': {'A': P+'a'}, '@id': S,
                             'A': {'@id': 'https://example.org/keep', '@value': None}}),
]:
    case(name, source, why='Reject rather than silently discard populated information or an invalid identifier.')

# Keep an independent populated sibling so safe-mode rejection of an otherwise
# empty root cannot hide that preparation already discarded the problematic value.
for original in list(CASES):
    if original['id'] in {'null-literal-with-label', 'mixed-id-null-value'}:
        source = copy.deepcopy(original['source'])
        source['@context']['Keep'] = P+'keep'
        source['Keep'] = {'@value': 'unrelated'}
        case(original['id']+'-with-sibling', source, why=original['rationale'])
case('nested-alias-scope', {'@context': {'Part': P+'part', 'Date/year': P+'outer'}, '@id': S,
     'Date/year': {'@value': 'outer'}, 'Part': {'@id': 'https://example.org/part',
     '@context': {'Date/year': P+'inner'}, 'Date/year': {'@value': 'inner'}}},
     quad(P+'outer', literal('outer'))+quad(P+'part', '<https://example.org/part>')+
     quad(P+'inner', literal('inner'), 'https://example.org/part'))
case('inherited-alias', {'@context': {'Part': P+'part', 'Date/year': P+'date'}, '@id': S,
     'Part': {'@id': 'https://example.org/part', 'Date/year': {'@value': 'inner'}}},
     quad(P+'part', '<https://example.org/part>')+quad(P+'date', literal('inner'), 'https://example.org/part'))
case('blank-node-cycle', {'@context': {'Next': P+'next'}, '@id': '_:a',
     'Next': {'@id': '_:b', 'Next': {'@id': '_:a'}}},
     quad(P+'next', '_:b', '_:a')+quad(P+'next', '_:a', '_:b'))
case('shared-blank-node', {'@context': {'A': P+'a', 'B': P+'b', 'Name': P+'name'}, '@id': S,
     'A': {'@id': '_:shared', 'Name': {'@value': 'shared'}}, 'B': {'@id': '_:shared'}},
     quad(P+'a', '_:shared')+quad(P+'b', '_:shared')+quad(P+'name', literal('shared'), '_:shared'))
case('annotation-language', {'@context': {'_annotations': '@nest', 'note': P+'note'}, '@id': S,
     '_annotations': {'note': {'@value': 'bonjour', '@language': 'fr'}}},
     quad(P+'note', literal('bonjour', language='fr')))

case('array-context-alias', {'@context': [{'Date/year': P+'date'}, {'A': P+'a'}], '@id': S,
     'Date/year': {'@value': '2026'}, 'A': {'@value': 'kept'}},
     quad(P+'date', literal('2026'))+quad(P+'a', literal('kept')))
case('context-reset', {'@context': [{'A': P+'old'}, None, {'A': P+'a'}], '@id': S,
     'A': {'@value': 'kept'}}, quad(P+'a', literal('kept')))
case('mapped-attribute-group', {'@context': {'Attributes': P+'group', 'colour': P+'colour'}, '@id': S,
     'Attributes': ['colour'], 'colour': {'@value': 'blue'}}, quad(P+'colour', literal('blue')))
CASES[-1]['template'] = {'properties': {'Attributes': {'_ui': {'inputType': 'attribute-value'}}}}
field('token-looking-datatype', {'@value': 42, '@type': 'urn:cedar:rdf:0'}, literal('42', 'urn:cedar:rdf:0'))
field('token-looking-literal', {'@value': 'urn:cedar:rdf:0'}, literal('urn:cedar:rdf:0'))
field('singleton-datatype', {'@value': '003', '@type': [X+'integer']}, literal('003', X+'integer'))
for name, value in [('invalid-escape', 'https://example.org/%ZZ'),
                    ('invalid-bracket', 'https://example.org/a[b]'),
                    ('invalid-ip', 'https://[broken]/'),
                    ('multiple-fragments', 'https://example.org/a#b#c')]:
    case(name, {'@context': {'A': P+'a'}, '@id': S, 'A': {'@id': value}})

case('invalid-language', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@value': 'kept', '@language': 'not valid'}})
case('blank-datatype', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@value': 'kept', '@type': '_:bad'}})
case('index-metadata', {'@context': {'A': P+'a'}, '@id': S, 'A': {'@value': 'kept', '@index': 'lost'}})
case('prototype-field-name', {'@context': {'__proto__': P+'proto', 'constructor': P+'constructor'}, '@id': S,
     '__proto__': {'@value': 'first'}, 'constructor': {'@value': 'second'}},
     quad(P+'proto', literal('first'))+quad(P+'constructor', literal('second')))
case('explicit-prefix-flag', {'@context': {'pre': {'@id': P, '@prefix': True}, 'pre:A': {'@type': '@id'}},
     '@id': S, 'pre:A': P+'value'}, quad(P+'A', '<'+P+'value>'))


def cases():
    return copy.deepcopy(CASES)
