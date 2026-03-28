#!/bin/bash
PASS="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

# Stop the PM2 frontend server as it's no longer needed
echo "$PASS" | sudo -S -u empcloud-development pm2 stop globussoft-crm-frontend || true
echo "$PASS" | sudo -S -u empcloud-development pm2 delete globussoft-crm-frontend || true

# Change backend port to avoid collisions
cd ~/globussoft-crm/backend
echo "PORT=5099" > .env
export PATH=$PATH:~/.nvm/versions/node/$(nvm version)/bin
echo "$PASS" | sudo -S -u empcloud-development pm2 restart globussoft-crm-backend || true

# Write better Nginx config
cat << 'EOF' > /tmp/crm.globusdemos.com
server {
    server_name crm.globusdemos.com;

    root /home/empcloud-development/globussoft-crm/frontend/dist;
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
echo "$PASS" | sudo -S certbot --nginx -d crm.globusdemos.com --non-interactive --agree-tos -m admin@globussoft.com || true
echo "$PASS" | sudo -S systemctl restart nginx
