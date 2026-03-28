#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd ~/globussoft-crm/backend
npx pm2 restart globussoft-crm-backend --update-env
