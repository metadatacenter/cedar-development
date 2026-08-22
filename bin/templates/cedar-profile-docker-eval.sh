#!/bin/bash

#------------------------------------------------------
# CEDAR Docker Development Util home folder
export CEDAR_DEVELOP_HOME=${CEDAR_HOME}/cedar-development

#------------------------------------------------------
# CEDAR custom environment variables
# These live at ${CEDAR_HOME}, copied from bin/templates and filled in for this installation.
# Reading the templates directly would run the stack on their "changeme" placeholders.
source ${CEDAR_HOME}/set-env-external.sh
source ${CEDAR_HOME}/set-env-internal.sh

#------------------------------------------------------
# CEDAR network settings
export CEDAR_NET_GATEWAY=192.168.17.1
export CEDAR_NET_SUBNET=192.168.17.0

#------------------------------------------------------
# CEDAR generic environment variables
source ${CEDAR_DEVELOP_HOME}/bin/util/set-env-generic.sh

#------------------------------------------------------
# CEDAR aliases and colors for Local Development
source ${CEDAR_DEVELOP_HOME}/bin/util/set-dev-aliases.sh

#------------------------------------------------------
# CEDAR Overwrite Docker host IPs
export CEDAR_KEYCLOAK_MYSQL_HOST=192.168.17.201
export CEDAR_LOG_MYSQL_HOST=192.168.17.201
export CEDAR_MESSAGING_MYSQL_HOST=192.168.17.201

export CEDAR_MONGO_HOST=192.168.17.202
export CEDAR_REDIS_PERSISTENT_HOST=192.168.17.203
export CEDAR_OPENSEARCH_HOST=192.168.17.204
export CEDAR_NEO4J_HOST=192.168.17.205
export CEDAR_KEYCLOAK_HOST=192.168.17.206
export CEDAR_NGINX_HOST=192.168.17.207

#------------------------------------------------------
# Where a container resolves auth.<host>, which is how every server reaches the realm to verify a
# bearer token. This is deliberately not CEDAR_NGINX_HOST: that is the nginx *container's* address on
# cedarnet, and the two are only the same when nginx runs as a container. Native nginx owns 80/443
# here, so the servers must reach the host instead, and `host-gateway` is how a container names it.
#
# Set it to ${CEDAR_NGINX_HOST} when the whole estate runs in Docker and infra-nginx serves 443.
# Getting this wrong is silent until a token is verified: the request reaches the server, the server
# cannot fetch the realm's signing keys, and a valid token comes back 500.
export CEDAR_AUTH_HOST_TARGET=host-gateway

#------------------------------------------------------
# The terminology store is read where it is mounted inside the container, not where it lives on the
# host. Everything else about the store — which vocabularies it serves, and whether exclusively — is
# inherited from set-env-generic.sh, because only the path differs between the two paths.
#
# Blank turns the local store off and serves every ontology through BioPortal, which is what
# cedar-main.yml ships as the default:
#   export CEDAR_TERMINOLOGY_STORE_CATALOG=""
# The read-only bind mount stays either way, so switching is this line and a container recreate.
export CEDAR_TERMINOLOGY_STORE_CATALOG=/cedar/term/prod/catalog.sqlite

export CEDAR_ARTIFACT_SERVER_HOST=192.168.17.101
export CEDAR_BRIDGE_SERVER_HOST=192.168.17.115
export CEDAR_GROUP_SERVER_HOST=192.168.17.109
export CEDAR_IMPEX_SERVER_HOST=192.168.17.108
export CEDAR_MONITOR_SERVER_HOST=192.168.17.114
export CEDAR_MESSAGING_SERVER_HOST=192.168.17.112
export CEDAR_OPENVIEW_SERVER_HOST=192.168.17.113
export CEDAR_REPO_SERVER_HOST=192.168.17.102
export CEDAR_RESOURCE_SERVER_HOST=192.168.17.107
export CEDAR_SCHEMA_SERVER_HOST=192.168.17.103
export CEDAR_SUBMISSION_SERVER_HOST=192.168.17.110
export CEDAR_TERMINOLOGY_SERVER_HOST=192.168.17.104
export CEDAR_USER_SERVER_HOST=192.168.17.105
export CEDAR_VALUERECOMMENDER_SERVER_HOST=192.168.17.106
export CEDAR_WORKER_SERVER_HOST=192.168.17.111

export CEDAR_FRONTEND_EDITOR_HOST=192.168.17.151
export CEDAR_FRONTEND_CONTENT_HOST=192.168.17.152
export CEDAR_FRONTEND_OPENVIEW_HOST=192.168.17.153
export CEDAR_FRONTEND_MONITORING_HOST=192.168.17.154
export CEDAR_FRONTEND_BRIDGING_HOST=192.168.17.156
export CEDAR_FRONTEND_WORKSPACE_HOST=192.168.17.157
export CEDAR_FRONTEND_DESIGNER_HOST=192.168.17.158

#------------------------------------------------------
# CEDAR admin stack host ports
# The admin containers have no native counterpart, so these live here rather than in
# set-env-generic.sh. Without them the cedar-admin stack publishes on blank ports.
export CEDAR_REDIS_COMMANDER_PORT=8081
export CEDAR_PHPMYADMIN_PORT=8082
export CEDAR_KIBANA_PORT=5601

#------------------------------------------------------
# CEDAR Docker BuildKit behavior
# BuildKit is the default and the only builder CI uses. The legacy builder these two selected still
# runs on Docker 29 but warns that it is deprecated and due for removal, so stop asking for it.
# Set both to 0 if a build turns out to depend on legacy behaviour, and say why here.

#------------------------------------------------------
# Unit test settings
#Test user 1
export CEDAR_TEST_USER1_ID="https://metadatacenter.org/users/11111111-2222-3333-4444-555555555555"

#Test user 2
export CEDAR_TEST_USER2_ID="https://metadatacenter.org/users/66666666-7777-8888-9999-000000000000"
#----------------------------------------------------------
