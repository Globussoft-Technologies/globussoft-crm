#!/bin/bash
PASS="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

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
echo "$PASS" | sudo -S ln -sf /etc/nginx/sites-available/crm.globusdemos.com /etc/nginx/sites-enabled/
echo "$PASS" | sudo -S certbot --nginx -d crm.globusdemos.com --non-interactive --agree-tos -m admin@globussoft.com || true
echo "$PASS" | sudo -S systemctl restart nginx
