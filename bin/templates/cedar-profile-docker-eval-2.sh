#!/bin/bash

#------------------------------------------------------
# CEDAR Overwrite Docker host IPs
export CEDAR_KEYCLOAK_MYSQL_HOST=192.168.17.101
export CEDAR_LOG_MYSQL_HOST=192.168.17.101
export CEDAR_MESSAGING_MYSQL_HOST=192.168.17.101

export CEDAR_MONGO_HOST=192.168.17.102
export CEDAR_REDIS_PERSISTENT_HOST=192.168.17.103
export CEDAR_OPENSEARCH_HOST=192.168.17.104
export CEDAR_NEO4J_HOST=192.168.17.105
export CEDAR_KEYCLOAK_HOST=192.168.17.106
export CEDAR_NGINX_HOST=192.168.17.107

#------------------------------------------------------
# CEDAR Docker BuildKit behavior
export DOCKER_BUILDKIT=0
export COMPOSE_DOCKER_CLI_BUILD=0

#------------------------------------------------------
# CEDAR Docker aliases
source ${CEDAR_DOCKER_HOME}/cedar-docker-deploy/bin/util/set-docker-aliases.sh

#----------------------------------------------------------
