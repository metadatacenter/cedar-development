#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting Neo4j
echo --------------------------------------------------------------------------------
echo

[ -d "/opt/homebrew/opt/openjdk@11" ] && export JAVA_HOME=/opt/homebrew/opt/openjdk@11/
[ -d "/usr/local/opt/openjdk@11" ] && export JAVA_HOME=/usr/local/opt/openjdk@11/
${CEDAR_NEO4J_HOME}/bin/neo4j start &
