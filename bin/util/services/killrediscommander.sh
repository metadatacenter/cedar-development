#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Redis Commander
echo --------------------------------------------------------------------------------
echo

echo Redis Commander processes:
ps ax | grep "[r]edis-commander"

echo Kill them all:
kill `ps ax | grep "[r]edis-commander" | awk '{print $1}'`