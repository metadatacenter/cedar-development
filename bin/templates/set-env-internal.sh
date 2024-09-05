#!/bin/bash

# This file contains connection information to internal resources

# CEDAR hostname for backend services
export CEDAR_HOST=metadatacenter.orgx

#CEDAR version modifier
export CEDAR_VERSION_MODIFIER=""

# Keycloak admin user data
export CEDAR_KEYCLOAK_ADMIN_USER="administrator"
export CEDAR_KEYCLOAK_ADMIN_PASSWORD="changeme"

# cedar-admin user data
# You should change this before the first run
# 64 characters, [0-9, a-f]
export CEDAR_ADMIN_USER_API_KEY="0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff"
# Do not change this for now
export CEDAR_ADMIN_USER_PASSWORD="Password123"

# Mongo user data
export CEDAR_MONGO_ROOT_USER_NAME="mongoRootUser"
export CEDAR_MONGO_ROOT_USER_PASSWORD="changeme"
export CEDAR_MONGO_APP_USER_NAME="cedarMongoUser"
export CEDAR_MONGO_APP_USER_PASSWORD="changeme"

# MySQL root user data
export CEDAR_MYSQL_ROOT_PASSWORD="changeme"

# MySQL CEDAR app user data for Keycloak
export CEDAR_KEYCLOAK_MYSQL_USER="cedarMySQLKeycloakUser"
export CEDAR_KEYCLOAK_MYSQL_PASSWORD="changeme"

# MySQL CEDAR app user data for Messaging
export CEDAR_MESSAGING_MYSQL_USER="cedarMySQLMessagingUser"
export CEDAR_MESSAGING_MYSQL_PASSWORD="changeme"

# MySQL CEDAR app user data for Logging
export CEDAR_LOG_MYSQL_HOST="${CEDAR_NET_GATEWAY}"
export CEDAR_LOG_MYSQL_DB="cedar_log"
export CEDAR_LOG_MYSQL_USER="cedarMySQLLogUser"
export CEDAR_LOG_MYSQL_PASSWORD="changeme"

# Neo4j user data
export CEDAR_NEO4J_USER_NAME="neo4j"
export CEDAR_NEO4J_USER_PASSWORD="changeme"

# Random string for API key generation - replace with a random string of your choice
export CEDAR_SALT_API_KEY="changeme"

# Certificat Authority data for self-signed certificates
export CEDAR_CA_PASSWORD="changeme"
export CEDAR_CA_HOME=${CEDAR_HOME}/CEDAR_CA
export CEDAR_CA_COUNTRY=US
export CEDAR_CA_STATE=CA
export CEDAR_CA_LOC=Stanford
export CEDAR_CA_ORG=BMIR
export CEDAR_CA_ORG_UNIT=CEDAR
export CEDAR_CA_COMMON_NAME=${CEDAR_HOST}
export CEDAR_CA_EMAIL=metadatacenter@gmail.com

# Field, element, template validation
export CEDAR_VALIDATION_ENABLED="true"

# CaDSR data
export CEDAR_CADSR_ADMIN_USER_API_KEY="0000111122223333444455556666777788889999aaaabbbbccccddddeeeefffe"
export CEDAR_CDE_FOLDER_ID="https://repo.metadatacenter.orgx/folders/00000000-1111-2222-3333-444444444444"

# Trusted folders
export CEDAR_TRUSTED_FOLDERS="{\\\"caDSR\\\":[\\\"https://repo.metadatacenter.orgx/folders/00000000-1111-2222-3333-444444444444\\\"]}"
