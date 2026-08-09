#!/usr/bin/env python3
"""Check that each locked server version still pairs with the client CEDAR ships against it.

The version lock is not really a list of servers. It is a set of pairs: a server version and the
client library that talks to it are locked *to each other*, and only one half of each pair has ever
been written where a check could read it. `cedar-parent` declares the client versions as POM
properties; `cedar-docker-build/bin/cedar-images-base.sh` declares the server versions the images
are built against. Nothing compared them, and they drifted — the Docker OpenSearch server sat at
1.3.6 for years while the servers shipped the 2.19 client, which is not a supported combination.

No dependency bot can catch this. Renovate keeps each side current against its own upstream and has
no way to know the two are related, so the invariant has to be stated somewhere executable. That is
this file.

    ops/check_version_pairing.py

Exits non-zero if a pair has come apart.
"""

import os
import re
import sys
import xml.etree.ElementTree as ET

MAVEN_NS = {'m': 'http://maven.apache.org/POM/4.0.0'}

# Each entry is one locked pair: the server version declared for the images, the client property
# declared in cedar-parent, and how much of the version has to agree. Comparing whole versions
# would be wrong — a client and a server are not released in lockstep — so each pair names the
# number of leading components that constitute the compatibility contract.
PAIRS = [
    {
        'server_var': 'OPENSEARCH_VERSION',
        'client_property': 'opensearch.version',
        'components': 2,
        'why': 'the high-level REST client speaks its own major.minor to the server',
    },
]


def cedar_home():
    home = os.environ.get('CEDAR_HOME')
    if not home:
        sys.exit('CEDAR_HOME is not set')
    return home


def server_versions(path):
    """The server versions the images are built against, read from the build manifest."""
    with open(path) as handle:
        text = handle.read()
    found = re.findall(r'^export ([A-Z0-9_]+_VERSION)=(\S+)', text, re.M)
    return {name: value for name, value in found if name != 'IMAGE_VERSION'}


def client_properties(path):
    """The client library versions, read from cedar-parent's properties block."""
    root = ET.parse(path).getroot()
    properties = root.find('m:properties', MAVEN_NS)
    if properties is None:
        sys.exit(f'{path} declares no properties block')
    return {child.tag.split('}')[-1]: (child.text or '').strip() for child in properties}


def series(version, components):
    return '.'.join(version.split('.')[:components])


def main():
    home = cedar_home()
    manifest = os.path.join(home, 'cedar-docker-build', 'bin', 'cedar-images-base.sh')
    pom = os.path.join(home, 'cedar-parent', 'pom.xml')

    for path in (manifest, pom):
        if not os.path.exists(path):
            sys.exit(f'not found: {path}\nThis check needs cedar-docker-build and cedar-parent beside each other.')

    servers = server_versions(manifest)
    clients = client_properties(pom)

    failed = 0
    for pair in PAIRS:
        server = servers.get(pair['server_var'])
        client = clients.get(pair['client_property'])
        if server is None:
            print(f"FAIL {pair['server_var']} is not declared in the build manifest")
            failed = 1
            continue
        if client is None:
            print(f"FAIL {pair['client_property']} is not declared in cedar-parent")
            failed = 1
            continue

        n = pair['components']
        if series(server, n) == series(client, n):
            print(f"OK   {pair['server_var']}={server} pairs with {pair['client_property']}={client}")
        else:
            print(f"FAIL {pair['server_var']}={server} against {pair['client_property']}={client}")
            print(f"       the first {n} components have to agree: {pair['why']}")
            print(f"       move one side, or change the pair in {os.path.basename(__file__)} if the")
            print(f"       compatibility contract itself has changed")
            failed = 1

    sys.exit(failed)


if __name__ == '__main__':
    main()
