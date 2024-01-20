#!/bin/bash

#DEV Util common locations
export CEDAR_UTIL_BIN=${CEDAR_DEVELOP_HOME}/bin/util/

#CEDAR location aliases
alias gocedar='cd $CEDAR_HOME'

alias goparent='cd $CEDAR_HOME/cedar-parent'
alias goproject='cd $CEDAR_HOME/cedar-project'
alias golibraries='cd $CEDAR_HOME/cedar-libraries'
alias goclients='cd $CEDAR_HOME/cedar-clients'

alias goutil='cd $CEDAR_HOME/cedar-util'
alias godocs='cd $CEDAR_HOME/cedar-docs'
alias gomicroservice='cd $CEDAR_HOME/cedar-microservice-libraries'
alias gomodel='cd $CEDAR_HOME/cedar-model-validation-library'

alias goadmintool='cd $CEDAR_HOME/cedar-admin-tool'

alias gogroup='cd $CEDAR_HOME/cedar-group-server'
alias gomessaging='cd $CEDAR_HOME/cedar-messaging-server'
alias gorepo='cd $CEDAR_HOME/cedar-repo-server'
alias goresource='cd $CEDAR_HOME/cedar-resource-server'
alias goschema='cd $CEDAR_HOME/cedar-schema-server'
alias goartifact='cd $CEDAR_HOME/cedar-artifact-server'
alias gobridge='cd $CEDAR_HOME/cedar-bridge-server'
alias goterminology='cd $CEDAR_HOME/cedar-terminology-server'
alias gouser='cd $CEDAR_HOME/cedar-user-server'
alias govaluerecommender='cd $CEDAR_HOME/cedar-valuerecommender-server'
alias gosubmission='cd $CEDAR_HOME/cedar-submission-server'
alias goworker='cd $CEDAR_HOME/cedar-worker-server'
alias goopenview='cd $CEDAR_HOME/cedar-openview-server'
alias gomonitor='cd $CEDAR_HOME/cedar-monitor-server'
alias goimpex='cd $CEDAR_HOME/cedar-impex-server'
alias gomkdocs='cd $CEDAR_HOME/cedar-mkdocs'
alias godevelopment='cd $CEDAR_HOME/cedar-development'
alias gobuild='cd $CEDAR_HOME/cedar-docker-build'
alias godeploy='cd $CEDAR_HOME/cedar-docker-deploy'
alias gocontent='cd $CEDAR_HOME/cedar-content-distribution'

alias goeventlistener='cd $CEDAR_HOME/cedar-keycloak-event-listener'

alias goeditor='cd $CEDAR_HOME/cedar-template-editor'
alias goopenfront='cd $CEDAR_HOME/cedar-openview/cedar-openview-src'
alias gomonitoring='cd $CEDAR_HOME/cedar-monitoring/cedar-monitoring-src'
alias goartifacts='cd $CEDAR_HOME/cedar-artifacts/cedar-artifacts-src'
alias goceeang='cd $CEDAR_HOME/cedar-cee-demo/cedar-cee-demo-angular-src'
alias gobridging='cd $CEDAR_HOME/cedar-bridging/cedar-bridging-src'

alias gocli='cd $CEDAR_HOME/cedar-cli'

alias gokk='cd ${CEDAR_KEYCLOAK_HOME}/bin'

#CEDAR Admin Tool alias
alias cedarat='$CEDAR_UTIL_BIN/admintool/cedar-admin-tool.sh'

#Maven aliases
alias mi='mvn install'
alias mcl='mvn clean'
alias mci='mvn clean install'
alias mit='mvn install -DskipTests=true'
alias mcit='mvn clean install -DskipTests=true'

#3rd party server aliases
alias startkk='$CEDAR_UTIL_BIN/services-generic/startkeycloak.sh'
alias killkk='$CEDAR_UTIL_BIN/services-generic/killkeycloak.sh'

alias startmessaging='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh messaging &'
alias stopmessaging='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh messaging 9212'
alias startgroup='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh group &'
alias stopgroup='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh group 9209'
alias startrepo='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh repo &'
alias stoprepo='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh repo 9202'
alias startresource='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh resource &'
alias stopresource='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh resource 9207'
alias startschema='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh schema &'
alias stopschema='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh schema 9203'
alias startartifact='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh artifact &'
alias stopartifact='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh artifact 9201'
alias startterminology='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh terminology &'
alias stopterminology='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh terminology 9204'
alias startuser='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh user &'
alias stopuser='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh user 9205'
alias startvaluerecommender='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh valuerecommender &'
alias stopvaluerecommender='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh valuerecommender 9206'
alias startsubmission='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh submission &'
alias stopsubmission='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh submission 9210'
alias startworker='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh worker &'
alias stopworker='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh worker 9211'
alias startopenview='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh openview &'
alias stopopenview='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh openview 9213'
alias startmonitor='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh monitor &'
alias stopmonitor='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh monitor 9214'
alias startimpex='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh impex &'
alias stopimpex='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh impex 9208'
alias startbridge='$CEDAR_UTIL_BIN/services-generic/start-dw-server.sh bridge &'
alias stopbridge='$CEDAR_UTIL_BIN/services-generic/stop-dw-server.sh bridge 9215'

alias sleepbetweenstarts='sleep 2'
alias stopmicros='$CEDAR_UTIL_BIN/services-generic/stopmicros.sh'
alias startmicros='$CEDAR_UTIL_BIN/services-generic/startmicros.sh'

alias startinfra='$CEDAR_UTIL_BIN/services-generic/startinfra.sh'
alias stopinfra='$CEDAR_UTIL_BIN/services-generic/stopinfra.sh'

alias ij="'/Applications/IntelliJ IDEA.app/Contents/MacOS/idea'"
