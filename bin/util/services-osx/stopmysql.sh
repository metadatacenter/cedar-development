#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping MySQL
echo --------------------------------------------------------------------------------
echo

MYSQL_FORMULA=mysql@8.4

brew services stop "${MYSQL_FORMULA}"
