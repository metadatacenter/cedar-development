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
export CEDAR_NET_SUBNET=127.0.0.0

#------------------------------------------------------
# CEDAR generic environment variables
source ${CEDAR_DEVELOP_HOME}/bin/util/set-env-generic.sh

#------------------------------------------------------
# The local terminology store, off: every ontology is served through BioPortal. Staging carries no
# catalog, and an empty path is what turns the store off — cedar-services.sh passes no
# -DterminologyStore.* flags without one, which is also cedar-main.yml's shipped default.
#
# Said here rather than left out, because leaving it out gave the same behaviour for a reason nobody
# reading this file could see: the allowlist and the local-only flag arrive armed from
# set-env-generic.sh and stay inert only while this is blank. Point it at a catalog to switch over.
export CEDAR_TERMINOLOGY_STORE_CATALOG=""

#------------------------------------------------------
# CEDAR aliases and colors for Local Development
source ${CEDAR_DEVELOP_HOME}/bin/util/set-dev-aliases.sh
source ${CEDAR_DEVELOP_HOME}/bin/util/set-infra-aliases-centos.sh

#-------------------------------------------------
# CEDAR Frontend behavior develop|server
export CEDAR_FRONTEND_BEHAVIOR="server"
#CEDAR frontend test target name
export CEDAR_FRONTEND_TARGET="staging"

#-------------------------------------------------
# Frontend test settings
# CEDAR hostname for frontend connections 'CEDAR_FRONTEND_' + ${CEDAR_FRONTEND_TARGET} + '_...'
export CEDAR_FRONTEND_staging_UI_HOST=${CEDAR_HOST}
export CEDAR_FRONTEND_staging_REST_HOST=${CEDAR_HOST}

export CEDAR_FRONTEND_staging_USER1_LOGIN="test1@test.com"
export CEDAR_FRONTEND_staging_USER1_PASSWORD="test1"
export CEDAR_FRONTEND_staging_USER1_NAME="Test User 1"

export CEDAR_FRONTEND_staging_USER2_LOGIN="test2@test.com"
export CEDAR_FRONTEND_staging_USER2_PASSWORD="test2"
export CEDAR_FRONTEND_staging_USER2_NAME="Test User 2"

#-------------------------------------------------
# Unit test settings
# Test user 1
export CEDAR_TEST_USER1_ID="https://metadatacenter.org/users/11111111-2222-3333-4444-555555555555"

# Test user 2
export CEDAR_TEST_USER2_ID="https://metadatacenter.org/users/66666666-7777-8888-9999-000000000000"

#----------------------------------------------------------
# Development settings
export CEDAR_DEV_USE_PRIVATE_REPOS="false"
export CEDAR_DEV_BUILD_FRONTENDS="false"
