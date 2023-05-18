#!/bin/bash

format="| %-27s|%-7s|%-12s|%5s|%-17s|\n"
header="| %-27s|%-7s|%-12s|%5s|%-17s|\n"
formatlong3="| %-27s|%-7s|%-47s|\n"
formatlong1="| %-72s|\n"
RED=$(tput setaf 1)
GREEN=$(tput setaf 2)
BLUE=$(tput setaf 4)
YELLOW=$(tput setaf 3)
NORMAL=$(tput sgr0)

function checkOpenPort {
        if nc -4 -z localhost "$2" > /dev/null 2>&1
        then
                status="${GREEN}Running${NORMAL}"
        else
                status="${RED}Stopped${NORMAL}"
        fi
        printf "$format" $1 $status 'openPort' $2
}

function checkHealth {
        ok=1
        lookFor='HTTP/1.1\s200\sOK'
        if curl --ipv4 -I -s http://localhost:$2/healthcheck | grep $lookFor > /dev/null 2>&1
        then
                status="${GREEN}Running${NORMAL}"
        else
                status="${RED}Stopped${NORMAL}"
                ok=0
        fi
        printf "$format" $1 $status 'healthCheck' $2 $lookFor
        if ((ok == 0));
        then
                reportError $1 $2
        fi
}

function checkHttpResponse {
        ok=1
        if curl --ipv4 -I -s http://localhost:$2 | grep "$3" > /dev/null 2>&1
        then
                status="${GREEN}Running${NORMAL}"
        else
                status="${RED}Stopped${NORMAL}"
                ok=0
        fi
        printf "$format" $1 $status 'httpResponse' $2 $3
        if ((ok == 0));
        then
                reportError $1 $2
        fi
}

function checkRedisPing {
        ok=1
        if (printf "PING\r\nQUIT\r\n";) | nc -4 localhost $2 | grep "+PONG" > /dev/null 2>&1
        then
                status="${GREEN}Running${NORMAL}"
        else
                status="${RED}Stopped${NORMAL}"
                ok=0
        fi
        printf "$format" $1 $status 'redisPing' $2 $3
        if ((ok == 0));
        then
                reportError $1 $2
        fi
}

function showEnvironmentVar {
        varname=$1
        varvalue=${!varname}
        value="${YELLOW}"$varvalue"${NORMAL}"
        printf "$formatlong3" $1 "" $value
}

function printLine {
        printf '|'
        printf $1'%.0s' {1..73}
        printf '|'
        printf '\n'
}

function reportError {
return
        printLine '.'
        echo '  -- ERROR IN '$1
        echo '  -- http://localhost:'$2
        curl --ipv4 -I http://localhost:$2
        printLine '^'
}

echo
printLine '='
printf "$formatlong1" "                            Checking all CEDAR servers"

printLine '='

printf "$header" 'Server' 'Status' 'CheckedFor' 'Port' 'Value'

printLine '\x2D'

printf "$header" '-- Microservices ----------'
checkHealth Artifact 9101
checkHealth Bridge 9115
checkHealth Group 9109
checkHealth Impex 9108
checkHealth Messaging 9112
checkHealth Monitor 9114
checkHealth OpenView 9113
checkHealth Repo 9102
checkHealth Resource 9107
checkHealth Schema 9103
checkHealth Submission 9110
checkHealth Terminology 9104
checkHealth User 9105
checkHealth ValueRecommender 9106
checkHealth Worker 9111
printf "$header" '-- Infrastructure ---------'
checkOpenPort MongoDB 27017
checkHttpResponse OpenSearch-REST 9200 'HTTP/1.1\s200\sOK'
checkOpenPort OpenSearch-Transport 9300 'HTTP/1.1\s200\sOK'
checkHttpResponse NGINX 80 'Server:\snginx'
checkHttpResponse Keycloak 8080 'HTTP/1.1\s200\sOK'
checkHttpResponse Neo4j 7474 'HTTP/1.1\s200\sOK'
checkRedisPing Redis-persistent 6379
#checkRedisPing Redis-non-persistent 6380
checkOpenPort MySQL 3306
printf "$header" '-- Front End --------------'
checkHttpResponse Base-Frontend 4200 'HTTP/1.1\s200\sOK'
checkHttpResponse OpenView-Frontend 4220 'HTTP/1.1'
checkHttpResponse Component-Frontend 4240 'HTTP/1.1'
checkHttpResponse Monitoring-Frontend 4300 'HTTP/1.1'
checkHttpResponse Artifacts-Frontend 4320 'HTTP/1.1'
printf "$header" '-- Monitoring -------------'
checkHttpResponse OpenSearch-Dashboards 5601 'HTTP/1.1\s302\sFo'
checkHttpResponse Redis-Commander 8081 'HTTP/1.1\s200\sOK'
checkHttpResponse PhpMyAdmin 8082 'HTTP/1.1\s200\sOK'
printf "$header" '-- Front End Non-essential-'
checkHttpResponse CEE-DEV-Frontend 4240 'HTTP/1.1'
checkHttpResponse CEE-Demo-Frontend 4260 'HTTP/1.1'
checkHttpResponse CEE-Docs-Frontend 4280 'HTTP/1.1'
printf "$header" '-- Environment ------------'
showEnvironmentVar 'CEDAR_NET_GATEWAY'
showEnvironmentVar 'CEDAR_NET_SUBNET'


printLine '='
