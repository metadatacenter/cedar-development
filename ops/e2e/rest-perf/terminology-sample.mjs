// Draw the terms the terminology and authoring profiles ask about from the index the terminology
// server serves, and keep only those the server answers from its local store.
//
// Two rules shape this file. Query text comes from the served index, so a lookup under load always
// matches something and the timing is of real work. And the load never reaches BioPortal: the
// terminology server falls back to it for whatever the local store does not implement, silently,
// so every kind of lookup is tried once here and the server's own log is read for upstream calls.
// A source that caused one is dropped before k6 starts.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { request } from './lib.mjs';

const UPSTREAM = /https?:\/\/data\.bioontology\.org\/[^\s;]*/g;

export function logSize(path) {
  return path && existsSync(path) ? statSync(path).size : null;
}

/**
 * The BioPortal addresses the terminology server logged after `offset`. Returns null when the log
 * cannot be read, which a caller must treat as "unknown" rather than as "none".
 */
export function upstreamCallsSince(path, offset) {
  if (offset === null || !path || !existsSync(path)) return null;
  const size = statSync(path).size;
  // A rotated log starts again from nothing, so everything in it is newer than the offset.
  const start = size < offset ? 0 : offset;
  const buffer = Buffer.alloc(size - start);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, buffer, 0, buffer.length, start);
  } finally {
    closeSync(descriptor);
  }
  return buffer.toString('utf8').match(UPSTREAM) ?? [];
}

function ontologyConstraint(acronym) {
  return { uri: `https://data.bioontology.org/ontologies/${acronym}`, acronym, numTerms: 0, name: acronym };
}

function spread(database, acronym, where, limit) {
  const { total } = database.prepare('SELECT COUNT(*) AS total FROM term WHERE acronym = ?').get(acronym);
  if (!total) return { total: 0, rows: [] };
  const eligible = `acronym = ? AND obsolete = 0 AND pref_label IS NOT NULL
      AND LENGTH(pref_label) BETWEEN 5 AND 40 AND ${where}`;
  const { matching } = database.prepare(`SELECT COUNT(*) AS matching FROM term WHERE ${eligible}`).get(acronym);
  // Every nth eligible row rather than the first rows, which all sit in one corner of the source.
  const stride = Math.max(1, Math.floor(matching / limit));
  const rows = database.prepare(
      `SELECT iri, label, parentIri FROM (
         SELECT iri, pref_label AS label, parent_iri AS parentIri,
                ROW_NUMBER() OVER (ORDER BY term_id) AS position
         FROM term WHERE ${eligible})
       WHERE position % ? = 0 LIMIT ?`).all(acronym, stride, limit);
  return { total, rows: rows.map(row => ({ ...row })) };
}

async function post(base, token, path, body) {
  return request(token, 'POST', path, body, { base });
}

/**
 * Sample one source and keep what the server confirms. Returns null when the source is not served
 * locally or has too little to ask about.
 */
async function sampleSource(database, base, token, acronym, perSource) {
  const scoped = await post(base, null, '/search', {
    query: acronym, pageSize: 1, sources: [{ sourceAcronym: acronym }],
  });
  const served = scoped.status === 200 && (scoped.body?.sources ?? []).length > 0
      && scoped.body.sources.every(entry => entry.served === 'local');
  if (!served) return { skipped: `POST /search does not answer for it from the local store (${scoped.status})` };

  const candidates = spread(database, acronym, '1 = 1', perSource * 2);
  const terms = [];
  for (const term of candidates.rows) {
    if (terms.length === perSource) break;
    const found = await post(base, token, '/bioportal/integrated-search', {
      parameterObject: {
        valueConstraints: { ontologies: [ontologyConstraint(acronym)], branches: [], classes: [], valueSets: [] },
        inputText: term.label,
      },
      page: 1,
      pageSize: 25,
    });
    const listed = found.status === 200 && (found.body?.collection ?? []).some(entry => entry['@id'] === term.iri);
    if (!listed) continue;
    const verdict = await post(base, token, '/bioportal/validate-term',
        { iri: term.iri, valueConstraints: { ontologies: [ontologyConstraint(acronym)] } });
    if (verdict.status === 200 && verdict.body?.status === 'passed') terms.push({ iri: term.iri, label: term.label });
  }

  const children = [];
  for (const term of spread(database, acronym, 'parent_iri IS NOT NULL', perSource).rows) {
    if (children.length === Math.ceil(perSource / 2)) break;
    const verdict = await post(base, token, '/bioportal/validate-term', {
      iri: term.iri,
      valueConstraints: {
        branches: [{ source: acronym, acronym, uri: term.parentIri, name: 'branch', maxDepth: 0 }],
      },
    });
    if (verdict.status === 200 && verdict.body?.status === 'passed') {
      children.push({ iri: term.iri, label: term.label, parentIri: term.parentIri });
    }
  }

  const parents = [];
  for (const term of spread(database, acronym, 'has_children = 1', perSource).rows) {
    if (parents.length === Math.ceil(perSource / 2)) break;
    const classPath = `/bioportal/ontologies/${acronym}/classes/${encodeURIComponent(term.iri)}`;
    const record = await request(token, 'GET', classPath, undefined, { base });
    const listing = await request(token, 'GET', `${classPath}/children`, undefined, { base });
    if (record.status === 200 && record.body?.['@id'] === term.iri
        && listing.status === 200 && (listing.body?.collection ?? []).length > 0) {
      parents.push({ iri: term.iri, label: term.label });
    }
  }

  const hierarchy = terms.length ? await request(null, 'GET',
      `/search/hierarchy?sourceAcronym=${encodeURIComponent(acronym)}&termIri=${encodeURIComponent(terms[0].iri)}`,
      undefined, { base }) : null;
  if (terms.length < 3 || !children.length || !parents.length || hierarchy?.status !== 200) {
    return {
      skipped: `too little to ask about: ${terms.length} terms, ${children.length} branch members, `
          + `${parents.length} parents, hierarchy ${hierarchy?.status ?? 'not tried'}`,
    };
  }
  return { size: candidates.total, terms, children, parents };
}

/**
 * Sample every requested source. The result maps each kept acronym to its terms, smallest source
 * first, and lists what was dropped and why.
 */
export async function sampleTerminology({ indexPath, base, token, acronyms, perSource, logPath }) {
  if (!indexPath || !existsSync(indexPath)) {
    throw new Error(`the terminology index ${indexPath ?? '(CEDAR_TERMINOLOGY_STORE_INDEX is unset)'} does not exist`);
  }
  const database = new DatabaseSync(indexPath, { readOnly: true });
  const kept = [];
  const dropped = [];
  try {
    for (const acronym of acronyms) {
      const before = logSize(logPath);
      const sample = await sampleSource(database, base, token, acronym, perSource);
      // The server writes its log through a buffer; give the last line time to land.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
      const upstream = upstreamCallsSince(logPath, before);
      if (sample.skipped) {
        dropped.push({ acronym, reason: sample.skipped });
      } else if (upstream === null) {
        dropped.push({ acronym, reason: `the terminology log ${logPath} cannot be read, so local service is unproven` });
      } else if (upstream.length) {
        dropped.push({ acronym, reason: `the server asked BioPortal ${upstream.length} time(s), first ${upstream[0]}` });
      } else {
        kept.push([acronym, sample]);
      }
    }
  } finally {
    database.close();
  }
  kept.sort((left, right) => left[1].size - right[1].size);
  return { sources: Object.fromEntries(kept), dropped };
}
