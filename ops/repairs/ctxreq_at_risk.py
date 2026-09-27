#!/usr/bin/env python3
"""GET-only impact of completing context.required, using a fresh dependent inventory.

The legacy --records input is accepted for command compatibility but never used to
infer a complete dependent population. Unreadable or unvalidated dependencies can
never enter the -safe.json output. All outcomes concern only API-key-visible data.
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import cedar_artifact_validation_audit as audit
import cedar_template_impact as impact
import cedar_artifact_repair as repair


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api-key-file', type=pathlib.Path, required=True)
    parser.add_argument('--templates', type=pathlib.Path, required=True)
    parser.add_argument('--records', help='Deprecated: dependencies are now enumerated live')
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--server', default=impact.rest.DEFAULT_SERVER)
    parser.add_argument('--java-log', type=pathlib.Path, default=pathlib.Path('/tmp/ctxreq-at-risk-java.log'))
    parser.add_argument('--java')
    parser.add_argument('--classpath')
    args = parser.parse_args()
    wanted = sorted(set(json.loads(args.templates.read_text())))
    client = impact.rest.GetOnlyClient(args.server, args.api_key_file.expanduser().read_text().strip())
    java, classpath = audit.resolve_toolchain(args, parser)
    bridge = audit.ValidationBridge(java, classpath, audit.BRIDGE_SOURCE, 4, '2g', args.java_log, 180)
    safe = []
    safe_path = args.out.with_name(args.out.stem + '-safe.json')
    # Do not leave a previous run's safe list in place if this run is interrupted.
    safe_path.write_text('[]\n')
    try:
        bridge.start()
        with args.out.open('w') as out:
            for number, template_id in enumerate(wanted, 1):
                try:
                    stored = client.get_json(impact.rest.typed_artifact_path(impact.rest.ArtifactRef('template', template_id)))
                    proposed, changes = repair.complete_context_required(stored)
                    row = impact.check_template(client, bridge, template_id, proposed, stored=stored)
                    row['paths'] = len(changes)
                    if row['complete'] and row['outcome'] == 'no-new-invalid-instances':
                        safe.append(template_id)
                except Exception as error:
                    row = {'templateId': template_id, 'outcome': 'inconclusive', 'complete': False, 'error': str(error)}
                out.write(json.dumps(row) + '\n')
                out.flush()
                print(f'[{number}/{len(wanted)}] {row["outcome"]}', flush=True)
    finally:
        bridge.close()
    safe_path.write_text(json.dumps(safe, indent=2) + '\n')
    return 0 if len(safe) == len(wanted) else 1


if __name__ == '__main__':
    raise SystemExit(main())
