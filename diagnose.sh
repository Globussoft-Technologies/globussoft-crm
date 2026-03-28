#!/bin/bash
PASS="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

echo "=== NGINX ERROR LOGS ==="
echo "$PASS" | sudo -S tail -n 20 /var/log/nginx/error.log

echo "=== PM2 BACKEND LOGS ==="
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
npx pm2 logs globussoft-crm-backend --lines 30 --nostream
