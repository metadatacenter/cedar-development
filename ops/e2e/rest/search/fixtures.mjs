import assert from 'node:assert/strict';
import { artifact, collections, definitions, baseBody, byAlias, instanceContext } from './corpus.mjs';

const enc = encodeURIComponent;
const status = (result, expected, what) => {
  assert.ok([expected].flat().includes(result.status), `${what}: ${result.status}: ${result.text ?? ''}`);
  return result;
};

// request is injected. Importing this module never imports authentication or makes a network call.
export class Fixtures {
  constructor({ request, owner, reader, scope, report, checkpoint = () => {} }) {
    Object.assign(this, { request, owner, reader, scope, report, checkpoint });
    this.bodies = new Map();
    this.created = [];
  }
  id(alias) { assert.ok(this.bodies.has(alias), `Missing fixture ${alias}`); return this.bodies.get(alias)['@id']; }
  path(alias) {
    const item = this.created.find(item => item.alias === alias);
    assert.ok(item, `No created fixture ${alias}`);
    return `/${item.collection}/${enc(item.id)}`;
  }
  async create(alias, collection, body, { folder, server = 'resource' } = {}) {
    assert.ok(!this.bodies.has(alias), `Duplicate create ${alias}`);
    const intent = { alias, collection, body: structuredClone(body), state: 'requested' };
    this.report.fixtures.push(intent);
    this.checkpoint();
    const path = `/${collection}${folder ? '?folder_id=' + enc(folder) : ''}`;
    const response = await this.request('owner', 'POST', path, body, { server });
    if ([400, 401, 403, 404, 405, 415, 422].includes(response.status)) {
      Object.assign(intent, { state: 'rejected', status: response.status });
      this.checkpoint();
    }
    status(response, 201, `create ${alias}`);
    assert.ok(response.body?.['@id'], `Create ${alias} omitted its identity`);
    const id = response.body['@id'];
    // Register before readback so a refused/lost read still cleans up the accepted create.
    this.created.push({ alias, collection, id, server });
    Object.assign(intent, { state: 'created', id });
    this.checkpoint();
    const read = status(await this.request('owner', 'GET', `/${collection}/${enc(id)}`, undefined, { server }), 200, `read ${alias}`);
    this.bodies.set(alias, read.body);
    intent.stored = read.body;
    this.checkpoint();
    return id;
  }
  async folder(alias, parent) {
    return this.create(alias, 'folders', { folderId: parent, name: `${this.scope || 'SearchCorpus'} ${alias}`,
      description: this.scope });
  }
  async permissions(alias, { direct, group, everybody } = {}) {
    const body = { owner: { '@id': this.owner },
      userPermissions: direct ? [{ user: { '@id': this.reader }, role: direct }] : [],
      groupPermissions: [
        ...(group ? [{ group: { '@id': this.id('readers-group') }, role: group }] : []),
        ...(everybody ? [{ group: { '@id': this.everybody }, role: everybody }] : []),
      ] };
    status(await this.request('owner', 'PUT', this.path(alias) + '/permissions', body, { conditional: true }), 200, `permissions ${alias}`);
  }
  async membership(member) {
    const users = [{ user: { '@id': this.owner }, administrator: true, member: true },
      ...(member ? [{ user: { '@id': this.reader }, administrator: false, member: true }] : [])];
    status(await this.request('owner', 'PUT', this.path('readers-group') + '/users', { users },
      { server: 'group', conditional: true }), 200, 'group membership');
  }
  async provision(home) {
    await this.folder('root', home);
    await this.folder('inherited-parent', this.id('root'));
    await this.folder('inherited-child', this.id('inherited-parent'));
    await this.create('readers-group', 'groups', { 'schema:name': `${this.scope || 'SearchCorpus'} readers`,
      'schema:description': 'Temporary search corpus group' }, { server: 'group' });
    await this.membership(true);
    const groups = status(await this.request('owner', 'GET', '/groups', undefined, { server: 'group' }), 200, 'everybody lookup');
    this.everybody = groups.body.groups?.find(group => group.specialGroup === 'EVERYBODY')?.['@id'];
    assert.ok(this.everybody, 'Missing everybody group');
    await this.permissions('inherited-parent', { direct: 'viewer' });
    for (const spec of definitions) {
      const body = artifact(spec.alias, alias => this.bodies.get(alias), this.scope);
      await this.create(spec.alias, collections[spec.kind], body,
        { folder: this.id(spec.access === 'inherited' ? 'inherited-child' : 'root') });
      if (spec.kind !== 'instance') {
        if (!spec.private) await this.permissions(spec.alias, { direct: 'viewer' });
      } else if (spec.access === 'direct') await this.permissions(spec.alias, { direct: 'viewer' });
      else if (spec.access === 'group') await this.permissions(spec.alias, { group: 'viewer' });
      else if (spec.access === 'everybody') await this.permissions(spec.alias, { everybody: 'viewer' });
      else if (spec.access === 'editor' || spec.access === 'manager') await this.permissions(spec.alias, { direct: spec.access });
      else if (spec.access === 'overlap') await this.permissions(spec.alias, { direct: 'viewer', group: 'viewer' });
    }
  }
  async mutable(alias, folder = this.id('root')) {
    const body = baseBody('instance', `${this.scope} ${alias}`, this.scope);
    body['schema:isBasedOn'] = this.id('catalog-template');
    Object.assign(body['@context'], instanceContext(byAlias.get('catalog-template')));
    body['@context']['pav:derivedFrom'] = { '@type': '@id' };
    body.Notes = { '@value': alias };
    await this.create(alias, 'template-instances', body, { folder });
    return this.id(alias);
  }
  async update(alias, transform) {
    const read = status(await this.request('owner', 'GET', this.path(alias)), 200, `read before update ${alias}`);
    const body = structuredClone(read.body);
    transform(body);
    status(await this.request('owner', 'PUT', this.path(alias), body, { conditional: true, current: read }), 200, `update ${alias}`);
    const stored = status(await this.request('owner', 'GET', this.path(alias)), 200, `updated read ${alias}`);
    this.bodies.set(alias, stored.body);
    this.report.mutations.push({ alias, body: stored.body });
    this.checkpoint();
  }
  async move(alias, folder) {
    const detail = status(await this.request('owner', 'GET', this.path(alias) + '/details'), 200, 'move revision');
    assert.ok(detail.headers?.get('etag'), 'Move requires its source revision');
    status(await this.request('owner', 'POST', '/command/move-resource-to-folder',
      { '@id': this.id(alias), targetFolderId: this.id(folder) }, { headers: { 'If-Match': detail.headers.get('etag') } }),
    [200, 201, 204], 'move');
  }
  async remove(alias) {
    status(await this.request('owner', 'DELETE', this.path(alias), undefined, { conditional: true }), [200, 204], `delete ${alias}`);
  }
  async cleanup() {
    const failures = [];
    for (const item of [...this.created].reverse()) {
      const path = `/${item.collection}/${enc(item.id)}`;
      try {
        const read = await this.request('owner', 'GET', path, undefined, { server: item.server });
        if (read.status === 404) continue;
        status(read, 200, `cleanup read ${item.alias}`);
        status(await this.request('owner', 'DELETE', path, undefined, { server: item.server, conditional: true, current: read }),
          [200, 204, 404], `cleanup ${item.alias}`);
        status(await this.request('owner', 'GET', path, undefined, { server: item.server }), 404, `cleanup verify ${item.alias}`);
      } catch (error) { failures.push({ alias: item.alias, id: item.id, message: error.message }); }
    }
    for (const intent of this.report.fixtures.filter(item => item.state === 'requested'))
      failures.push({ alias: intent.alias, message: 'Create outcome unresolved; inspect this run root before retrying' });
    return failures;
  }
}
