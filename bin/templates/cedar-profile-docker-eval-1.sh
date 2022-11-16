#!/bin/bash

#------------------------------------------------------
# CEDAR Docker Development Util home folder
export CEDAR_DEVELOP_HOME=${CEDAR_DOCKER_HOME}/cedar-development

#------------------------------------------------------
# CEDAR custom environment variables
source ${CEDAR_DEVELOP_HOME}/bin/templates/set-env-external.sh
source ${CEDAR_DEVELOP_HOME}/bin/templates/set-env-internal.sh

#------------------------------------------------------
# CEDAR network settings
export CEDAR_NET_GATEWAY=192.168.17.1
export CEDAR_NET_SUBNET=192.168.17.0

export CEDAR_NET_IP_MYSQL=192.168.17.101
export CEDAR_NET_IP_MONGO=192.168.17.102
export CEDAR_NET_IP_REDIS_PERSISTENT=192.168.17.103
export CEDAR_NET_IP_ELASTICSEARCH=192.168.17.104
export CEDAR_NET_IP_NEO4J=192.168.17.105
export CEDAR_NET_IP_KEYCLOAK=192.168.17.106
export CEDAR_NET_IP_NGINX=192.168.17.107

#------------------------------------------------------
# CEDAR generic environment variables
source ${CEDAR_DEVELOP_HOME}/bin/util/set-env-generic.sh

#------------------------------------------------------
# CEDAR aliases and colors for Local Development
source ${CEDAR_DEVELOP_HOME}/bin/util/set-aliases-and-colors.sh
source ${CEDAR_DEVELOP_HOME}/bin/util/set-dev-aliases.sh

#-------------------------------------------------
# Unit test settings
#Test user 1
export CEDAR_TEST_USER1_ID="https://metadatacenter.org/users/11111111-2222-3333-4444-555555555555"

#Test user 2
export CEDAR_TEST_USER2_ID="https://metadatacenter.org/users/66666666-7777-8888-9999-000000000000"
#----------------------------------------------------------
