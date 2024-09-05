#!/bin/bash

#------------------------------------------------------
# CEDAR Development Util home folder
export CEDAR_DEVELOP_HOME=${CEDAR_HOME}/cedar-development

#------------------------------------------------------
# Home folders of software components
export CEDAR_KEYCLOAK_HOME=${CEDAR_HOME}/keycloak/
export CEDAR_NEO4J_HOME=${CEDAR_HOME}/neo4j/

#------------------------------------------------------
# CEDAR custom environment variables
source ${CEDAR_HOME}/set-env-external.sh
source ${CEDAR_HOME}/set-env-internal.sh

#------------------------------------------------------
# CEDAR network settings
export CEDAR_NET_GATEWAY=127.0.0.1
export CEDAR_NET_SUBNET=127.0.0.1

#------------------------------------------------------
# CEDAR generic environment variables
source ${CEDAR_DEVELOP_HOME}/bin/util/set-env-generic.sh

#------------------------------------------------------
# CEDAR aliases and colors for Local Development
source ${CEDAR_DEVELOP_HOME}/bin/util/set-dev-aliases.sh
source ${CEDAR_DEVELOP_HOME}/bin/util/set-infra-aliases-centos.sh

#-------------------------------------------------
# CEDAR Frontend behavior develop|server
export CEDAR_FRONTEND_BEHAVIOR="server"
#CEDAR frontend test target name
export CEDAR_FRONTEND_TARGET="production"

#-------------------------------------------------
# Frontend test settings
# CEDAR hostname for frontend connections 'CEDAR_FRONTEND_' + ${CEDAR_FRONTEND_TARGET} + '_...'
export CEDAR_FRONTEND_production_UI_HOST=${CEDAR_HOST}
export CEDAR_FRONTEND_production_REST_HOST=${CEDAR_HOST}

export CEDAR_FRONTEND_production_USER1_LOGIN="-"
export CEDAR_FRONTEND_production_USER1_PASSWORD="-"
export CEDAR_FRONTEND_production_USER1_NAME="-"

export CEDAR_FRONTEND_production_USER2_LOGIN="-"
export CEDAR_FRONTEND_production_USER2_PASSWORD="-"
export CEDAR_FRONTEND_production_USER2_NAME="-"

#-------------------------------------------------
# Unit test settings
# Test user 1
export CEDAR_TEST_USER1_ID="-"

# Test user 2
export CEDAR_TEST_USER2_ID="-"

#----------------------------------------------------------
# Development settings
export CEDAR_DEV_USE_PRIVATE_REPOS="false"
export CEDAR_DEV_BUILD_FRONTENDS="false"
