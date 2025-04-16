#!/bin/bash

# This file contains connection information to external resources

#CEDAR BioPortal REST endpoint base and API Key - place your own here
export CEDAR_BIOPORTAL_REST_BASE="https://data.bioontology.org/"
export CEDAR_BIOPORTAL_API_KEY="changeme-bbbb-cccc-dddd-eeeeeeeeeeee"

#CEDAR Google Analytics Key - place your own key here if the site is publicly available
export CEDAR_ANALYTICS_KEY="false"
export CEDAR_GA4_TRACKING_ID="false"

#CEDAR NCBI SRA FTP Data - place your own data here
export CEDAR_NCBI_SRA_FTP_HOST="changeme"
export CEDAR_NCBI_SRA_FTP_USER="changeme"
export CEDAR_NCBI_SRA_FTP_PASSWORD="changeme"
export CEDAR_NCBI_SRA_FTP_DIRECTORY="directory/subdirectory"

#CEDAR ImmPort Submission User and Password - place your own data here
export CEDAR_IMMPORT_SUBMISSION_USER="changeme"
export CEDAR_IMMPORT_SUBMISSION_PASSWORD="changeme"

#CEDAR DataMed Submission - place your own data here
export CEDAR_DATAMED_TEMPLATE_ID="changeme"
export CEDAR_DATAMED_GROUP_ID="changeme"
export CEDAR_DATAMED_PERMISSION_TYPE="read"

#Template ids which can be submitted
export CEDAR_SUBMISSION_TEMPLATE_ID_1="changeme"
export CEDAR_SUBMISSION_TEMPLATE_ID_2="changeme"

#CEDAR NCI caDSR FTP Connection Settings - place your own data here
export CEDAR_NCI_CADSR_FTP_HOST="changeme"
export CEDAR_NCI_CADSR_FTP_USER="changeme"
export CEDAR_NCI_CADSR_FTP_PASSWORD="changeme"
export CEDAR_NCI_CADSR_FTP_CLASSIFICATIONS_DIRECTORY="changeme"
export CEDAR_NCI_CADSR_FTP_CDES_DIRECTORY="changeme"

#CEDAR DATACITE Integration - place your own data here
export CEDAR_DATACITE_REPOSITORY_ID="changeme"
export CEDAR_DATACITE_REPOSITORY_PASSWORD="changeme"
export CEDAR_DATACITE_REPOSITORY_PREFIX="changeme"
export CEDAR_DATACITE_API_ENDPOINT_URL="changeme"
export CEDAR_DATACITE_TEMPLATE_ID="changeme"
export CEDAR_DATACITE_ENABLED="true"

#CEDAR External Authority Integration - place your own data here
export ROR_API_PREFIX="https://api.ror.org/v2/"
export ORCID_API_PREFIX="https://api.orcid.org/v3.0/"
export ORCID_API_CLIENT_ID="changeme"
export ORCID_API_CLIENT_SECRET="changeme"
