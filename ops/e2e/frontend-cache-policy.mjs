// What a frontend origin's responses must say about caching, by the kind of path requested.
//
// Two policies apply. A local development stack serves source trees and development servers
// whose files keep stable names, so every response is no-store. A deployed origin follows the
// policy the os-mirror vhosts carry: an entry page, a deep link and everything under /config/ are
// no-store, a bundle whose name carries its content hash is immutable for a year, and every other
// file revalidates, so a browser may keep it but must ask before reusing it.

/** A bundle esbuild names name-XXXXXXXX.js, the hash being eight upper-case base32 characters. */
export const HASHED_BUNDLE = /-[A-Z2-7]{8}\.(?:js|css)$/;

/** A year, the shortest lifetime an immutable bundle may declare. */
export const IMMUTABLE_MAX_AGE = 31_536_000;

/** Which rule a path falls under: an entry page or deep link, a deployment file, a hashed bundle, or a stable-name file. */
export function kindOf(pathname) {
  if (pathname === '/' || pathname.endsWith('/index.html')) return 'entry';
  if (pathname.startsWith('/config/')) return 'config';
  if (HASHED_BUNDLE.test(pathname)) return 'hashed';
  // A path with no file extension is a route the application answers with its entry page.
  if (!/\.[A-Za-z0-9]+$/.test(pathname.split('/').at(-1))) return 'entry';
  return 'stable';
}

/** The directives of a Cache-Control header, lower-cased, with max-age as a number. */
export function directives(header) {
  const parsed = { names: new Set(), maxAge: undefined };
  for (const part of (header ?? '').split(',')) {
    const [name, value] = part.trim().toLowerCase().split('=');
    if (!name) continue;
    parsed.names.add(name);
    if (name === 'max-age') parsed.maxAge = Number(value);
  }
  return parsed;
}

/**
 * Why a response breaks the policy, or null when it keeps it.
 *
 * @param {'development' | 'deployment'} policy
 * @param {'entry' | 'config' | 'hashed' | 'stable'} kind
 * @param {string | null} header the response's Cache-Control header
 */
export function violation(policy, kind, header) {
  const { names, maxAge } = directives(header);
  const shown = header || 'no header';
  if (policy === 'development' || kind === 'entry' || kind === 'config')
    return names.has('no-store') ? null : `expected no-store, got ${shown}`;
  if (kind === 'hashed') {
    if (!names.has('immutable')) return `expected immutable, got ${shown}`;
    if (!(maxAge >= IMMUTABLE_MAX_AGE)) return `expected max-age of at least ${IMMUTABLE_MAX_AGE}, got ${shown}`;
    return null;
  }
  // A stable-name file may be kept, but only if the browser asks before reusing it.
  return names.has('no-cache') || names.has('no-store') ? null : `expected no-cache, got ${shown}`;
}

/** The policy an origin's host implies: development on a local .orgx stack, deployment anywhere else. */
export function policyFor(host, override) {
  if (override === 'development' || override === 'deployment') return override;
  if (override) throw new Error(`CEDAR_CACHE_POLICY must be development or deployment, not ${override}`);
  return host.endsWith('.orgx') ? 'development' : 'deployment';
}
