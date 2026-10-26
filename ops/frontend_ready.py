"""Decide whether each native frontend serves a page a browser can load, not merely whether it listens.

A development server opens its port before it can serve the page behind it. Gulp answers from the
moment it listens, even while its own tasks are still writing the files the page names, and answers a
missing script with the index rather than a 404. Vite answers the index at once and then holds every
request for a prebundled dependency until its optimizer finishes. A page load arriving in that window
waits, and the smoke's thirty-second navigation can run out. A check that asks only whether the root
answers therefore reports ready too early.

This check fetches what a browser fetches before the page is usable: each page, every same-origin
script, module preload and stylesheet the page names, and the static imports of every module script.
It requests them from the origin it is given. Given the origin a browser uses, nginx and its
certificate become part of what it proves. A request still waiting on a compiler or an optimizer
runs out of time, and the next pass asks again.

Usage:
    frontend_ready.py [--cafile FILE] [--deadline EPOCH] [--request-timeout SECONDS]
                      --frontend NAME ORIGIN ENTRIES [--frontend ...]

ENTRIES is a space-separated list of kind:path items. A page item is fetched and parsed for the assets
it names; a script, module or style item is fetched as an asset of that kind, and a module item's
static imports are fetched as well. Prints one tab-separated line per frontend: its name, `ready` or
`waiting`, and the reason it is waiting, or `-`. Exits 0 whatever the verdicts are.

Each request may take --request-timeout seconds, or what remains before --deadline when that is less,
but never less than MINIMUM_REQUEST seconds. A pass that starts just before the deadline therefore
still asks something rather than reporting nothing, and overruns the deadline by at most that much for
each round of requests: the pages, their assets, then the modules those import.
"""
import argparse
import concurrent.futures
import html.parser
import http.client
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KINDS = ('page', 'script', 'module', 'style')
CLASSIC_SCRIPT_TYPES = ('', 'text/javascript', 'application/javascript')
# A static import or re-export at the start of a statement. Bare specifiers such as `@angular/core`
# are left out because a browser cannot load them without an import map, so nothing fetches them.
STATIC_IMPORT = re.compile(
    r'''(?:^|[;}\n])\s*(?:import|export)\s*(?:[\w$\s{},*]+?\s*from\s*)?["']((?:\.{1,2})?/[^"'\s]*)["']''')
ASSET_WORKERS = 6
MINIMUM_REQUEST = 1.0
READ_CHUNK = 1 << 16


class NotServed(Exception):
    """The reason a frontend is not ready yet, phrased for the operator."""


class PageAssets(html.parser.HTMLParser):
    """The scripts, module preloads and stylesheets a page names, and its base address."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.base = None
        self.assets = []

    def handle_starttag(self, tag, attrs):
        values = {key.lower(): (value or '').strip() for key, value in attrs}
        if tag == 'base' and self.base is None and values.get('href'):
            self.base = values['href']
        elif tag == 'script' and values.get('src'):
            kind = values.get('type', '').lower()
            if kind == 'module':
                self.assets.append(('module', values['src']))
            elif kind in CLASSIC_SCRIPT_TYPES:
                self.assets.append(('script', values['src']))
        elif tag == 'link' and values.get('href'):
            relations = values.get('rel', '').lower().split()
            if 'stylesheet' in relations:
                self.assets.append(('style', values['href']))
            elif 'modulepreload' in relations:
                self.assets.append(('module', values['href']))


def same_origin(url, origin):
    first, second = urllib.parse.urlsplit(url), urllib.parse.urlsplit(origin)
    return (first.scheme, first.netloc) == (second.scheme, second.netloc)


def page_assets(url, text):
    """The same-origin assets a page names, in document order, resolved as a browser resolves them."""
    parser = PageAssets()
    parser.feed(text)
    parser.close()
    base = urllib.parse.urljoin(url, parser.base) if parser.base else url
    found = []
    for kind, reference in parser.assets:
        resolved = urllib.parse.urldefrag(urllib.parse.urljoin(base, reference))[0]
        if same_origin(resolved, url):
            found.append((kind, resolved))
    return found


def module_imports(url, text):
    """The same-origin modules a module imports statically. Dynamic imports load later, on demand."""
    found = []
    for specifier in STATIC_IMPORT.findall(text):
        resolved = urllib.parse.urldefrag(urllib.parse.urljoin(url, specifier))[0]
        if same_origin(resolved, url):
            found.append(('module', resolved))
    return found


def is_html(content_type):
    return content_type.split(';')[0].strip().lower() == 'text/html'


def describe(error):
    """One line naming why a request failed, in the terms an operator acts on."""
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLCertVerificationError):
        detail = reason.verify_message or str(reason)
        hint = '; `cedarcli cert domains` re-issues the local certificates' if 'expired' in detail else ''
        return 'presented a certificate that failed verification ({}){}'.format(detail, hint)
    if isinstance(reason, ConnectionRefusedError):
        return 'refused the connection'
    if isinstance(reason, socket.gaierror):
        return 'has a host name that does not resolve'
    return str(reason) or type(reason).__name__


class Frontend:
    """One frontend's readiness check: its origin, its entries, and the clock it must finish by."""

    def __init__(self, origin, entries, stop, request_timeout, context):
        self.origin = origin.rstrip('/')
        self.entries = entries
        self.stop = stop
        self.request_timeout = request_timeout
        # nginx and the development servers are on this host, so no proxy may stand between them.
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))

    def fetch(self, url, accept):
        """The status, content type and body of a GET, read in full before the request's deadline."""
        started = time.monotonic()
        allowed = min(self.request_timeout, max(self.stop - started, MINIMUM_REQUEST))
        finish = started + allowed
        late = ('{} did not finish within {:g}s'.format(url, self.request_timeout)
                if allowed == self.request_timeout else
                '{} was still loading when the readiness budget ran out'.format(url))
        request = urllib.request.Request(url, headers={
            'Accept': accept, 'Cache-Control': 'no-cache', 'User-Agent': 'cedar-frontend-ready'})
        try:
            with self.opener.open(request, timeout=allowed) as response:
                chunks = []
                while True:
                    chunk = response.read(READ_CHUNK)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    if time.monotonic() > finish:
                        raise socket.timeout()
                return response.status, response.headers.get('Content-Type', ''), b''.join(chunks)
        except urllib.error.HTTPError as error:
            return error.code, error.headers.get('Content-Type', '') if error.headers else '', b''
        except urllib.error.URLError as error:
            if isinstance(error.reason, (socket.timeout, TimeoutError)):
                raise NotServed(late)
            raise NotServed('{} {}'.format(url, describe(error)))
        except (socket.timeout, TimeoutError):
            raise NotServed(late)
        except (OSError, http.client.HTTPException, ValueError) as error:
            raise NotServed('{} {}'.format(url, describe(error)))

    def page(self, url):
        status, content_type, body = self.fetch(url, 'text/html,application/xhtml+xml,*/*;q=0.8')
        if status != 200:
            raise NotServed('{} answered {}'.format(url, status))
        text = body.decode('utf-8', 'replace')
        if not is_html(content_type) or not re.search(r'<!doctype\s+html|<html[\s>]', text, re.I):
            raise NotServed('{} answered {} with {}, not a page'.format(
                url, status, content_type or 'no content type'))
        return page_assets(url, text)

    def asset(self, kind, url):
        """Fetches one asset and returns the modules it imports, which a browser fetches next."""
        status, content_type, body = self.fetch(url, '*/*')
        if status != 200:
            raise NotServed('{} answered {}'.format(url, status))
        if is_html(content_type):
            # Gulp and other single-page servers answer a missing file with the index.
            raise NotServed('{} answered with a page in place of a {}, so the file is missing'.format(
                url, 'stylesheet' if kind == 'style' else 'script'))
        return module_imports(url, body.decode('utf-8', 'replace')) if kind == 'module' else []

    def fetch_assets(self, assets):
        """Fetches the assets together and returns their imports; the first failure in order wins."""
        if not assets:
            return []
        with concurrent.futures.ThreadPoolExecutor(max_workers=ASSET_WORKERS) as pool:
            futures = [pool.submit(self.asset, kind, url) for kind, url in assets]
            imports, failure = [], None
            for future in futures:
                try:
                    imports.extend(future.result())
                except NotServed as error:
                    failure = failure or error
        if failure:
            raise failure
        return imports

    def check(self):
        """The verdict, and the reason the frontend is not ready or `-` when it is."""
        try:
            assets = []
            for kind, path in self.entries:
                url = self.origin + path
                if kind == 'page':
                    assets.extend(self.page(url))
                else:
                    assets.append((kind, url))
            seen = set()
            imports = self.fetch_assets(unseen(assets, seen))
            # One level of imports is enough. The modules a module imports come from the same build
            # or the same optimizer run, so answering for the first level proves that it finished.
            self.fetch_assets([('script', url) for _, url in unseen(imports, seen)])
            return 'ready', '-'
        except NotServed as error:
            return 'waiting', str(error)


def unseen(assets, seen):
    """The assets not fetched yet, each once, in order. Records them in `seen`."""
    found = []
    for kind, url in assets:
        if url not in seen:
            seen.add(url)
            found.append((kind, url))
    return found


def parse_entries(text):
    entries = []
    for item in text.split():
        kind, separator, path = item.partition(':')
        if not separator or kind not in KINDS or not path.startswith('/'):
            raise ValueError('an entry is kind:/path with kind one of {}, not {!r}'.format(
                ', '.join(KINDS), item))
        entries.append((kind, path))
    if not entries:
        raise ValueError('a frontend needs at least one entry')
    return entries


def tls_context(cafile):
    context = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    # Python 3.13 made the default context strict about RFC 5280, and the local CEDAR CA predates
    # that: it carries no key usage extension. Browsers, curl and Node accept it, so the check that
    # stands for them accepts it too, and still verifies the chain, expiry and host name.
    context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return context


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--cafile', help='the CA that signed the local nginx certificates')
    parser.add_argument('--deadline', type=float,
                        help='epoch seconds by which every request must have finished')
    parser.add_argument('--request-timeout', type=float, default=10.0,
                        help='seconds one request may take, read in full (default 10)')
    parser.add_argument('--frontend', nargs=3, action='append', default=[],
                        metavar=('NAME', 'ORIGIN', 'ENTRIES'))
    arguments = parser.parse_args(argv)
    budget = (arguments.deadline - time.time()) if arguments.deadline else arguments.request_timeout
    stop = time.monotonic() + budget
    context = tls_context(arguments.cafile)
    checks = []
    for name, origin, entries in arguments.frontend:
        try:
            checks.append((name, Frontend(origin, parse_entries(entries), stop,
                                          arguments.request_timeout, context)))
        except ValueError as error:
            parser.error('{}: {}'.format(name, error))
    verdicts = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(checks))) as pool:
        futures = {name: pool.submit(check.check) for name, check in checks}
        for name, future in futures.items():
            verdicts[name] = future.result()
    for name, _ in checks:
        verdict, reason = verdicts[name]
        print('{}\t{}\t{}'.format(name, verdict, ' '.join(reason.split())))
    return 0


if __name__ == '__main__':
    sys.exit(main())
