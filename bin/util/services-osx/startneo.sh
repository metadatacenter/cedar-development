#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting Neo4j
echo --------------------------------------------------------------------------------
echo

export JAVA_HOME=/opt/homebrew/opt/openjdk@11/
${CEDAR_NEO4J_HOME}/bin/neo4j start &
