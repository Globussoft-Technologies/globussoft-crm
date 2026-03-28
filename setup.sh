#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
PASS="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

cat << 'EOF' > /tmp/crm.globusdemos.com
server {
    listen 80;
    server_name crm.globusdemos.com;

    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

echo "$PASS" | sudo -S mv /tmp/crm.globusdemos.com /etc/nginx/sites-available/
echo "$PASS" | sudo -S ln -sf /etc/nginx/sites-available/crm.globusdemos.com /etc/nginx/sites-enabled/
echo "$PASS" | sudo -S systemctl restart nginx
