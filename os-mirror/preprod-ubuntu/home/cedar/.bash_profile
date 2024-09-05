# .profile
#Java
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

#---------------------------------------------------------------------
# CEDAR home folder
export CEDAR_HOME=/srv/cedar
source ${CEDAR_HOME}/cedar-profile-preprod-ubuntu.sh
alias cedarcli='source $CEDAR_HOME/cedar-cli/cli.sh'
alias python=python3
# #---------------------------------------------------------------------
#
# export PATH=~/.npm-global/bin:$PATH
#
if [ -f ~/.profile.local ]; then
   . ~/.profile.local
fi
