#!/bin/bash
PASS="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

# Fix Nginx 403 / Rewrite Loop
echo "$PASS" | sudo -S mkdir -p /var/www/crm.globusdemos.com
echo "$PASS" | sudo -S cp -r /home/empcloud-development/globussoft-crm/frontend/dist/* /var/www/crm.globusdemos.com/
echo "$PASS" | sudo -S chown -R www-data:www-data /var/www/crm.globusdemos.com
echo "$PASS" | sudo -S chmod -R 755 /var/www/crm.globusdemos.com

cat << 'EOF' > /tmp/crm.globusdemos.com
server {
    server_name crm.globusdemos.com;

    root /var/www/crm.globusdemos.com;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:5099;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
echo "$PASS" | sudo -S mv /tmp/crm.globusdemos.com /etc/nginx/sites-available/crm.globusdemos.com
echo "$PASS" | sudo -S systemctl restart nginx

# Fix Prisma 500 errors
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd /home/empcloud-development/globussoft-crm/backend
npx prisma generate
npx pm2 restart globussoft-crm-backend
