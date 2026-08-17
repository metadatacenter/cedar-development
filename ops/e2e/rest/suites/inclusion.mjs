// Element inclusion and its propagation subgraph: POST /command/inclusions-subgraph-{preview,update}.
//
// When a template embeds an element, a change to the element affects the template. On create the
// resource server records an inclusion arc template -> element; these two endpoints compute the tree of
// affected artifacts (preview) and propagate a change across it (update). Nothing exercised them before.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN, RESOURCE } from '../lib.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export const name = 'inclusion';

/**
 * A template that embeds the given element object under one property — which is how a real template
 * carries an element, and what makes the resource server record the inclusion arc on create. Built from
 * the minimal template with the element inlined, registered in `@context`, `_ui.order` and `required`.
 */
function templateEmbedding(elementObject, name) {
  const tmpl = JSON.parse(readFileSync(resolve(FIXTURES, 'minimal-template.json'), 'utf8'));
  tmpl['@id'] = null;
  tmpl['schema:name'] = name;
  const field = 'embeddedElement';
  tmpl.properties[field] = elementObject;
  tmpl.required = Array.isArray(tmpl.required) ? [...tmpl.required, field] : [field];
  tmpl._ui = tmpl._ui || {};
  tmpl._ui.order = [...(tmpl._ui.order || []), field];
  tmpl._ui.propertyLabels = { ...(tmpl._ui.propertyLabels || {}), [field]: 'Embedded Element' };
  tmpl._ui.propertyDescriptions = { ...(tmpl._ui.propertyDescriptions || {}), [field]: 'embedded by the REST suites' };
  if (tmpl.properties['@context']?.properties) {
    tmpl.properties['@context'].properties[field] = { enum: ['https://schema.metadatacenter.org/properties/' + field] };
    if (Array.isArray(tmpl.properties['@context'].required)) tmpl.properties['@context'].required.push(field);
  }
  return tmpl;
}

export async function run({ user1, user2, folderId }) {
  const auth = user1.auth;

  suite('inclusion: the affected-tree preview finds templates that embed an element');

  const elLabel = `Inclusion Element ${RUN}`;
  const el = await call(auth, 'POST', `/template-elements?folder_id=${enc(folderId)}`, artifactBody('element', elLabel));
  if (!checkStatus(el, 201, 'an element is created')) return {};
  const eid = el.body['@id'];
  cleanup('element', `/template-elements/${enc(eid)}`, elLabel);
  const elementObject = (await call(auth, 'GET', `/template-elements/${enc(eid)}`)).body;

  const tLabel = `Inclusion Template ${RUN}`;
  const embed = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, templateEmbedding(elementObject, tLabel));
  if (!checkStatus(embed, 201, 'a template embedding that element is created')) return {};
  const tid = embed.body['@id'];
  cleanup('template', `/templates/${enc(tid)}`, tLabel);

  // Previewing the tree affected by a change to the element must list the embedding template.
  const preview = await call(auth, 'POST', '/command/inclusions-subgraph-preview', { '@id': eid });
  if (checkStatus(preview, 200, 'previewing the element\'s affected tree returns')) {
    check(preview.body?.['@id'] === eid && !!preview.body?.templates && !!preview.body?.elements,
        'the response echoes the id and carries the affected elements and templates',
        `body was ${JSON.stringify(preview.body).slice(0, 200)}`);
    check(Object.keys(preview.body?.templates ?? {}).includes(tid),
        'the embedding template is among the affected templates',
        `affected templates were ${Object.keys(preview.body?.templates ?? {}).join(', ') || '(none)'}`);
  }

  // Applying the update propagates the change across that tree and answers 200.
  checkStatus(await call(auth, 'POST', '/command/inclusions-subgraph-update', { '@id': eid }),
      200, 'applying the inclusion-subgraph update succeeds');

  suite('inclusion: an artifact that nothing embeds has an empty affected tree');

  // A standalone template embeds no element, so its affected tree is empty — but the call still answers
  // 200 with the shape rather than an error.
  const soloName = `Inclusion Solo ${RUN}`;
  const solo = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', soloName));
  if (checkStatus(solo, 201, 'a standalone template is created')) {
    cleanup('template', `/templates/${enc(solo.body['@id'])}`, soloName);
    const empty = await call(auth, 'POST', '/command/inclusions-subgraph-preview', { '@id': solo.body['@id'] });
    if (checkStatus(empty, 200, 'previewing a standalone artifact returns')) {
      check(Object.keys(empty.body?.templates ?? {}).length === 0 && Object.keys(empty.body?.elements ?? {}).length === 0,
          'and its affected tree is empty', `it was ${JSON.stringify(empty.body).slice(0, 160)}`);
    }
  }

  suite('inclusion: the affected tree carries only what the caller may read');

  // The graph query behind the tree matches on the inclusion arc, which says nothing about who may see
  // the artifacts it finds. Two templates embed the same element and only one is shared, so what the
  // second user gets back separates "everything that embeds it" from "everything they may read".
  const privateLabel = `Inclusion Private ${RUN}`;
  const priv = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, templateEmbedding(elementObject, privateLabel));
  if (checkStatus(priv, 201, 'a second template embedding the same element is created')) {
    const pid = priv.body['@id'];
    cleanup('template', `/templates/${enc(pid)}`, privateLabel);

    const shareRead = at => call(auth, 'PUT', `${at}/permissions`, {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [{ user: { '@id': user2.profile['@id'] }, permission: 'read' }],
      groupPermissions: [],
    });
    // Read on the element, because previewing it requires it; read on one template and nothing on the
    // other, which is the whole of the fixture.
    checkStatus(await shareRead(`/template-elements/${enc(eid)}`), 200, 'the element is shared with the second user');
    checkStatus(await shareRead(`/templates/${enc(tid)}`), 200, 'one of the two embedding templates is shared with them');

    const theirs = await call(user2.auth, 'POST', '/command/inclusions-subgraph-preview', { '@id': eid });
    if (checkStatus(theirs, 200, 'the second user can preview the element shared with them')) {
      const seen = Object.keys(theirs.body?.templates ?? {});
      check(seen.includes(tid), 'the template shared with them is in their affected tree',
          `they saw ${seen.join(', ') || '(none)'}`);
      check(!seen.includes(pid), 'the template they have no grant on is not',
          `they saw ${seen.join(', ') || '(none)'}`);
    }

    // The owner still sees both, so the filtering above is the caller's access rather than a tree that
    // lost an entry for some other reason.
    const mine = await call(auth, 'POST', '/command/inclusions-subgraph-preview', { '@id': eid });
    if (checkStatus(mine, 200, 'the owner previews the same element')) {
      const seen = Object.keys(mine.body?.templates ?? {});
      check(seen.includes(tid) && seen.includes(pid), 'and sees both embedding templates',
          `the owner saw ${seen.join(', ') || '(none)'}`);
    }

    // Reading a target is not authority to rewrite it.
    checkStatus(await call(user2.auth, 'POST', '/command/inclusions-subgraph-update',
        { '@id': eid, templates: { [tid]: { operation: 'update' } } }), 403,
        'propagating into a template they may read but not write is refused');

    // And a target they cannot see is not a target: it never enters their tree, so nothing is planned
    // for it and nothing is written.
    const unseen = await call(user2.auth, 'POST', '/command/inclusions-subgraph-update',
        { '@id': eid, templates: { [pid]: { operation: 'update' } } });
    if (checkStatus(unseen, 200, 'naming a template they cannot see succeeds')) {
      check((unseen.body?.outcomes ?? []).length === 0, 'having planned no work at all',
          `outcomes were ${JSON.stringify(unseen.body?.outcomes ?? []).slice(0, 200)}`);
    }
  }

  suite('inclusion: the requests the endpoints must refuse');

  checkStatus(await call(auth, 'POST', '/command/inclusions-subgraph-preview', {}), 400,
      'a preview with no @id is refused with 400');
  checkStatus(await call(auth, 'POST', '/command/inclusions-subgraph-update', {}), 400,
      'an update with no @id is refused with 400');
  const anon = await fetch(`${RESOURCE}/command/inclusions-subgraph-preview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ '@id': eid }) });
  check(anon.status === 401, 'an anonymous caller is refused with 401', `got ${anon.status}`);

  return {};
}
