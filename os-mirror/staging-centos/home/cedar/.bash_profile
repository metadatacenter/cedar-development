# .bash_profile

# Get the aliases and functions
if [ -f ~/.bashrc ]; then
  . ~/.bashrc
  fi

# User specific environment and startup programs
# !!!! .bash_profile is managed by Puppet
# Please use .bash_profile.local for customization
# or update puppet profile

PATH=$PATH:$HOME/bin

export PATH

#Java
export JAVA_HOME=/usr/lib/jvm/jdk-17.0.6+10/

# Anaconda
export PATH=/home/cedar/anaconda3/bin:$PATH

#---------------------------------------------------------------------
# CEDAR home folder
export CEDAR_HOME=/srv/cedar
source ${CEDAR_HOME}/cedar-profile-staging-centos.sh
#---------------------------------------------------------------------

export PATH=~/.npm-global/bin:$PATH

if [ -f ~/.bash_profile.local ]; then
  . ~/.bash_profile.local
fi