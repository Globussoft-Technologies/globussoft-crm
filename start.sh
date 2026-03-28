#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd ~/globussoft-crm/backend
npm install
npx pm2 start server.js --name 'globussoft-crm-backend' || npx pm2 restart globussoft-crm-backend
cd ../frontend
npm install
npm run build
npx pm2 serve dist 8000 --name 'globussoft-crm-frontend' --spa || npx pm2 restart globussoft-crm-frontend
npx pm2 save
