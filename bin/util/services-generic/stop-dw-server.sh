#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping CEDAR $1 server
echo - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - 

STOPMSG="Stop:$1:Me"
echo "${STOPMSG}"$'\n'"stop" | nc 127.0.0.1 $2
echo "Stop message '${STOPMSG}' sent to port $2"
echo --------------------------------------------------------------------------------
echo