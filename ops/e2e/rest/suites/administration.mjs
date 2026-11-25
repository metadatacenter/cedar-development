// What an ordinary signed-in user may not reach: the administrative reports, every server's insight
// routes, and the commands that rebuild or reset shared state.
//
// The errors suite asks every operation without credentials, which shows that a credential is
// demanded, not that an administrative permission is. These routes hand out configuration, the
// environment, logs and thread dumps, or start work over the whole repository, so each must refuse
// the first test user, who holds no administrative role, with 403.
//
// The commands are sent only because each must be refused before it starts. A server that accepted
// one would begin rebuilding or resetting what the rest of the run relies on, which is the defect
// these checks exist to show.
import { suite, check, call, MONITOR, RESOURCE, WORKER } from '../lib.mjs';
import { SERVERS, readSpec } from './errors.mjs';

export const name = 'administration';

// The monitor routes an ordinary user may read, each with the reason. Every other monitor
// operation is administrative.
const OPEN_MONITOR_ROUTES = new Map([
  ['GET /', 'the service banner, which every server answers to anyone'],
]);

/** A path parameter filled with something the route accepts, so the permission is all that refuses. */
const filled = path => path.replace('{server}', 'resource').replace('{column}', 'service')
  .replace(/\{[^}]+\}/g, '00000000-0000-0000-0000-000000000000');

/** Each request an ordinary user sends, and the answers that are not 403. */
async function refusals(auth, base, requests) {
  const wrong = [];
  for (const { method, path, body } of requests) {
    const res = await call(auth, method, path, body, { base });
    if (res.status !== 403) wrong.push(`${method} ${path}: ${res.status} ${(res.text ?? '').slice(0, 120)}`);
  }
  return wrong;
}

export async function run({ user1 }) {
  const auth = user1.auth;

  suite('administration: every server refuses its insight routes to an ordinary user');

  // Thread dumps, memory and system details. Every server serves the same six routes, read here from
  // each committed document so that a server gaining one is held to the same rule. The artifact
  // server is asked with the installation's service key beside the user's credential, as the
  // resource server asks it, so the user's missing permission is all that refuses.
  for (const { server, base } of SERVERS) {
    const { spec, file, error } = readSpec(server);
    if (!check(!!spec, `${server}: the committed OpenAPI document is read`, `${file}: ${error}`)) continue;
    const routes = Object.keys(spec.paths ?? {}).filter(path => path.startsWith('/insight/') && spec.paths[path].get);
    const wrong = await refusals(auth, base, routes.map(path => ({ method: 'GET', path })));
    check(routes.length > 0 && wrong.length === 0, `${server}: every insight route refuses an ordinary user`,
        routes.length ? wrong.join('\n        ') : 'the document declares no insight route');
  }

  suite('administration: the monitor refuses its reports to an ordinary user');

  // Configuration, environment, build and host reports, logs, counts and job status. Read from the
  // monitor's document, so a new report is refused or named in OPEN_MONITOR_ROUTES.
  const { spec } = readSpec('monitor');
  const reports = [];
  for (const [path, operations] of Object.entries(spec?.paths ?? {})) {
    for (const method of ['get', 'post']) {
      // The index rebuild is a command, not a report; the commands section below sends it.
      if (!operations[method] || path === '/search-index/regenerate') continue;
      if (OPEN_MONITOR_ROUTES.has(`${method.toUpperCase()} ${path}`)) continue;
      reports.push({ method: method.toUpperCase(), path: filled(path), body: method === 'post' ? {} : undefined });
    }
  }
  const wrongReports = await refusals(auth, MONITOR, reports);
  check(reports.length > 0 && wrongReports.length === 0, 'every monitor report refuses an ordinary user',
      `${wrongReports.length} of ${reports.length}:\n        ${wrongReports.join('\n        ')}`);

  suite('administration: commands over shared state refuse an ordinary user');

  const commands = [
    [RESOURCE, '/jobs/00000000-0000-0000-0000-000000000000/reset', 'the resource server refuses to reset a job'],
    [WORKER, '/command/regenerate-inclusion-subgraph', 'the worker refuses to regenerate the inclusion subgraph'],
    [MONITOR, '/search-index/regenerate', 'the monitor refuses to rebuild the search index'],
  ];
  for (const [base, path, what] of commands) {
    const res = await call(auth, 'POST', path, undefined, { base });
    check(res.status === 403, what, `expected 403, got ${res.status}: ${(res.text ?? '').slice(0, 160)}`);
  }
  return {};
}
