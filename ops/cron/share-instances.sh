#!/bin/bash
# Production cron job, every ten minutes: give groups access to the instances of particular
# templates. Each rule names a template, a group and the role the group gets on every instance of
# that template; cedar_share_instances.py leaves alone an instance that already names the group.
# The roles were "read" and "write" before CEDAR modelled permissions as roles, and are now viewer
# and editor.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

share() {
  python3 "$SCRIPT_DIR/cedar_share_instances.py" "$1" "$2" "$3"
}

# Share instances of the 'CCP Digital Object' template
share https://repo.metadatacenter.org/templates/62c8b5f2-7dc9-4fff-9008-07c95a746411 https://repo.metadatacenter.org/groups/fd473979-33ab-4154-a316-de828dcf8cc0 viewer
# Share instances of 'COVID Project Admin' template with 'CEDAR Dev Team' group
share https://repo.metadatacenter.org/templates/eb3f3015-f776-4fc7-a074-7c113c4d0c0c https://repo.metadatacenter.net/groups/295c93d3-0c9b-430c-ba25-82f98ced501a viewer
share https://repo.metadatacenter.org/templates/3258a592-a0a0-4822-9eda-5cd757e28926 https://repo.metadatacenter.net/groups/295c93d3-0c9b-430c-ba25-82f98ced501a viewer
# Share instances of 'COVID Project Admin' template with 'ZonMW COVID Metadata' group
share https://repo.metadatacenter.org/templates/eb3f3015-f776-4fc7-a074-7c113c4d0c0c https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/337cb6f3-eef6-4b2f-9ffb-3f6d6cc9b9ac https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
# Share instances of 'COVID Project Content' template (different versions/copies of it) with 'ZonMW COVID Metadata' group
share https://repo.metadatacenter.org/templates/3258a592-a0a0-4822-9eda-5cd757e28926 https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/1c645834-e593-479e-9e2a-026b858cb58a https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/f697ab8d-7b71-4d48-9caf-8c256eb8ee13 https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/8bcd40b3-ddb3-4b1f-af77-b3fe034c3db3 https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/908e33e2-9485-4a93-ab22-1688dc5819dc https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/28d58a30-1a42-4715-a742-d2f46690563e https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/22925909-9fb2-4ac8-a986-6db5ae7049e7 https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
share https://repo.metadatacenter.org/templates/de169781-7f75-4aef-a0cb-ac435fe3a4c7 https://repo.metadatacenter.org/groups/89ae032c-48e1-4448-8c42-ca39c72f900b editor
# Share instances of 'Virtual Fly Brain Neuron' template with 'vfb crawler' group.
share https://repo.metadatacenter.org/templates/3179bbc0-8956-4ac5-9107-9cfa5ee3c7ee https://repo.metadatacenter.org/groups/6d7003fb-2a11-4077-b1fa-1a9b5a667a23 viewer
# Share instances of 'Virtual Fly Brain Dataset' template with 'vfb crawler' group.
share https://repo.metadatacenter.org/templates/24d95aea-88c2-477f-855c-42c1a0051289 https://repo.metadatacenter.org/groups/6d7003fb-2a11-4077-b1fa-1a9b5a667a23 viewer
# Share instances of 'ADVANCE metadata templateV3' template with 'ADVANCE' group.
share https://repo.metadatacenter.org/templates/6530ee0d-23cc-4680-b368-76881372e514 https://repo.metadatacenter.org/groups/992a9fe3-891f-4640-b83b-86d8f17af87c viewer
