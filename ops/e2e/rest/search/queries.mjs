// Expected matches are hand-authored. Never evaluate query text against the fixture builder to
// manufacture an oracle: extraction, naming, Boolean rewriting and permissions are under test.
const stats = ['ny-stats', 'boston-stats', 'private-twin', 'phrase-gap', 'public-stats', 'folder-stats'];
const ny = ['ny-stats', 'ny-math', 'private-twin'];
const publishers = ['ny-stats', 'boston-stats', 'ny-math', 'private-twin', 'swapped', 'phrase-gap',
  'phrase-reversed', 'public-stats', 'folder-stats', 'nested-match', 'unicode', 'named'];
// Unquoted field-name terms also match words in multiword names such as Publisher Name.
const titleValues = [...stats, 'ny-math', 'swapped', 'punctuation'];
const add = (id, query, matches, family, extra = {}) => ({ id, query, matches, family, types: ['instance'], ...extra });
export const queries = [
  add('field-literal', 'title:Statistics', stats, 'field-value'),
  add('field-phrase', 'publisher:"City of New York"', ny, 'field-value'),
  add('preferred-label', '"publishing institution":"City of New York"', ny, 'names'),
  add('field-existence', 'publisher:*', publishers, 'existence'),
  add('field-existence-shorthand', 'publisher:', publishers, 'existence'),
  add('title-existence', 'title:*', titleValues, 'existence'),
  add('any-field-phrase', '*:"City of New York"', [...ny, 'swapped'], 'field-value'),
  add('any-field-shorthand', ':"City of New York"', [...ny, 'swapped'], 'field-value'),
  add('and-fields', 'title:Statistics AND publisher:"City of New York"', ['ny-stats', 'private-twin'], 'boolean'),
  add('or-fields', 'title:Statistics OR title:Mathematics', [...stats, 'ny-math'], 'boolean'),
  add('implicit-or', 'title:Statistics title:Mathematics', [...stats, 'ny-math'], 'boolean'),
  add('grouped-field', 'title:(Statistics OR Mathematics)', [...stats, 'ny-math'], 'boolean'),
  add('nested-boolean', 'title:Mathematics OR (title:Statistics AND publisher:"City of New York")', ny, 'boolean'),
  add('documented-and-precedence', 'title:Mathematics OR title:Statistics AND publisher:"City of New York"', ny, 'boolean'),
  add('not-field', 'title:Statistics NOT publisher:"City of New York"', ['boston-stats', 'phrase-gap', 'public-stats', 'folder-stats'], 'boolean'),
  add('parenthesized-or-and', '(title:Statistics OR title:Mathematics) AND publisher:"City of New York"', ny, 'boolean'),
  add('and-nonmatch', 'title:Statistics AND title:Mathematics', [], 'boolean'),
  add('cross-field-nonmatch', 'title:Boston', [], 'field-value'),
  add('value-prefix', 'title:stat*', stats, 'wildcards'),
  add('value-single-character', 'title:stat?stics', stats, 'wildcards'),
  add('field-prefix', 'Publish*:"City of New York"', ny, 'wildcards'),
  add('field-single-character', 'publ?sher:"City of New York"', ny, 'wildcards'),
  add('quoted-field', '"Contact Email":"research@example.org"', ['ny-stats'], 'names'),
  add('term-label', 'topic:statistics', ['ny-stats', 'private-twin', 'term-other-uri'], 'ontology'),
  add('term-uri', 'topic:http://edamontology.org/topic_2269', ['ny-stats', 'private-twin', 'term-other-label'], 'ontology'),
  add('term-uri-and-label', 'topic:http://edamontology.org/topic_2269 AND topic:data', ['term-other-label'], 'ontology'),
  add('term-different-uri', 'topic:https://example.org/terms/statistics-other', ['term-other-uri'], 'ontology'),
  add('term-uri-without-label', 'topic:https://example.org/terms/unlabelled', ['term-no-label'], 'ontology'),
  add('term-phrase', 'topic:"data analysis"', ['term-other-label'], 'ontology'),
  add('term-wildcard-name', 'to?ic:statistics', ['ny-stats', 'private-twin', 'term-other-uri'], 'wildcards'),
  add('link-uri', 'url:https://catalog.data.gov/dataset/demographic-statistics-by-zip-code-acfc9', ['ny-stats'], 'url'),
  add('link-encoded-components', 'url:https://example.org/data?x=1&y=two#part', ['encoded-url'], 'url'),
  add('link-wrong-field', 'topic:https://example.org/data?x=1&y=two#part', [], 'url'),
  add('repeated-alpha', 'Tags:alpha', ['repeated-values'], 'repeated'),
  add('repeated-beta', 'Tags:beta', ['repeated-values'], 'repeated'),
  add('repeated-both', 'Tags:alpha AND Tags:beta', ['repeated-values'], 'repeated'),
  add('repeated-missing-conjunction', 'Tags:alpha AND Tags:gamma', [], 'repeated'),
  add('repeated-or', 'Tags:alpha OR Tags:gamma', ['repeated-values', 'other-values'], 'repeated'),
  add('repeated-not', 'Tags:alpha NOT Tags:gamma', ['repeated-values'], 'repeated'),
  add('numeric-value', 'Age:42', ['typed-values'], 'typed'),
  add('numeric-nonmatch', 'Age:24', [], 'typed'),
  add('date-value', 'SampleDate:"2024-02-29"', ['typed-values'], 'typed'),
  add('date-nonmatch', 'SampleDate:"2024-02-28"', [], 'typed'),
  add('value-colon', 'Notes:"stage: II"', ['punctuation'], 'escaping'),
  add('value-apostrophe', 'title:"O\'Brien cohort"', ['punctuation'], 'escaping'),
  add('schema-name', '"Publisher Name":"Named Institute"', ['named'], 'names'),
  add('alternate-preferred-label', '"Publishing organisation":"Named Institute"', ['named'], 'names'),
  add('unicode-field-and-value', 'Étude:café', ['unicode'], 'names'),
  add('unicode-phrase', '"Publisher Name":"Université de Montréal"', ['unicode'], 'names'),
  add('nested-disease', 'Disease:CRC', ['nested-match', 'nested-cross'], 'nested'),
  add('nested-tissue', 'Tissue:colon', ['nested-match', 'nested-cross'], 'nested'),
  add('nested-wrong-field', 'Disease:colon', ['nested-swapped'], 'nested'),
  add('nested-contact', 'publisher:"Nested Institute"', ['nested-match'], 'nested'),
  add('nested-cross-field-nonmatch', 'publisher:"nested@example.org"', [], 'nested'),
  add('nested-repeated-value', 'Disease:asthma', ['nested-cross'], 'nested'),
  add('metadata-title-or-description', 'Astronomy', ['title-only', 'description-only'], 'metadata'),
  add('metadata-phrase', '"Astronomy register"', ['title-only', 'description-only'], 'metadata'),
  add('metadata-substring', 'stronom', ['title-only', 'description-only'], 'metadata'),
  add('metadata-prefix', 'Astron*', ['title-only', 'description-only'], 'wildcards'),
  add('metadata-single-character', 'Astron?my', ['title-only', 'description-only'], 'wildcards'),
  add('content-only', 'Notes:Astronomy', ['value-only'], 'metadata'),
  add('metadata-and-content', 'Astronomy AND Notes:Astronomy', [], 'metadata'),
  add('metadata-or-content', 'Astronomy OR Notes:Astronomy', ['title-only', 'description-only', 'value-only'], 'metadata'),
  add('metadata-nonmatch', 'NobodyShouldMatchThisCorpus', [], 'metadata'),
  add('schema-independent-permission', 'Notes:Independentpermission', ['shared-private-schema', 'private-public-schema'], 'permissions'),
  add('roles-read-content', 'Notes:Rolepermission', ['editor-record', 'manager-record', 'overlap-record'], 'permissions'),
  add('public-view-with-term', 'title:Statistics', ['public-stats'], 'sharing', { parameters: { sharing: 'shared-with-everybody' } }),
  add('shared-view-with-term', 'title:Statistics', ['ny-stats', 'boston-stats', 'phrase-gap', 'folder-stats'], 'sharing',
    { parameters: { sharing: 'shared-with-me' }, matchesByActor: { owner: [] } }),
  add('private-twin-phrase', 'title:Statistics AND publisher:"City of New York" AND topic:statistics', ['ny-stats', 'private-twin'], 'permissions'),
  add('schema-title-exists', 'title:', ['title-field', 'catalog-template'], 'schema', { types: ['template', 'element', 'field'] }),
  add('schema-publisher-exists', 'publisher:', ['publisher-field', 'catalog-template', 'contact-element', 'nested-template', 'named-field', 'names-template'], 'schema', { types: ['template', 'element', 'field'] }),
  add('schema-preferred-label', '"publishing institution":', ['publisher-field', 'catalog-template', 'contact-element', 'nested-template'], 'schema', { types: ['template', 'element', 'field'] }),
  add('schema-contact-exists', '"Contact Email":', ['contact-field', 'catalog-template', 'contact-element', 'nested-template'], 'schema', { types: ['template', 'element', 'field'] }),
  add('schema-topic-wildcard', 'to?ic:', ['topic-field', 'catalog-template'], 'schema', { types: ['template', 'element', 'field'] }),
  add('schema-has-no-instance-value', 'publisher:"City of New York"', [], 'schema', { types: ['template', 'element', 'field'] }),
  add('schema-nested-field', 'Disease:', ['disease-field', 'visit-element', 'nested-template'], 'schema', { types: ['template', 'element', 'field'] })
];

// Independent access expectation. Schemas are shared except private-template; two instances remain
// private even though their common template is readable. Do not infer this from observed GETs.
export const hiddenFromReader = new Set(['private-twin', 'private-public-schema', 'private-template']);
export const expectedAliases = (test, actor) => (test.matchesByActor?.[actor] ?? test.matches)
  .filter(alias => actor !== 'reader' || !hiddenFromReader.has(alias));

// These contracts need a product decision or a wider corpus. They remain visible in every plan and
// report, never silently skipped or recorded as passing checks. No generated baseline blesses them.
export const openContracts = [
  { id: 'field-key-versus-name', query: 'publisherCode:"Named Institute"', question: 'Does internal field name mean the JSON property key or schema:name when they differ?' },
  { id: 'display-override', query: '"Public facing label":"Named Institute"', question: 'Should a template UI override be a searchable alias?' },
  { id: 'same-repeat-correlation', query: 'Disease:CRC AND Tissue:colon', question: 'May separate repeated Visits satisfy the two clauses, or must one Visit satisfy both?' },
  { id: 'literal-uri-value', query: 'Notes:http://edamontology.org/topic_2269', question: 'Must a URL stored as a literal match this syntax as well as a linked term URI?' },
  { id: 'post-revoke-count', question: 'Are continuation totals historical snapshot counts or current readable counts after revocation?' },
];

export const journeyScenarios = [
  { id: 'quoted-value', case: 'field-phrase', promise: 'Quoted field values reach search unchanged and render exactly the permitted instances' },
  { id: 'compound-query', case: 'and-fields', promise: 'A compound field-value expression excludes wrong-field, wrong-value and private distractors' },
  { id: 'reload-back', promise: 'Reload and browser Back restore the expression and its exact results' },
  { id: 'type-filter', promise: 'Selecting Instance retains the expression and sends the selected resource type' },
  { id: 'open-identity', promise: 'Opening a matching row loads that exact instance, despite an identically named private instance' },
  { id: 'public-sharing', case: 'public-view-with-term', promise: 'Search and reload retain Shared with Everyone and render only public matches' },
  { id: 'personal-sharing', case: 'shared-view-with-term', promise: 'Search retains Shared with Me, including shared-folder descendants and excluding public matches' }
];
