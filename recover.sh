#!/bin/bash
PASS="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

echo "$PASS" | sudo -S nginx -t
if [ $? -ne 0 ]; then
    echo "NGINX CONFIGURATION BROKEN. REVERTING crm.globusdemos.com"
    echo "$PASS" | sudo -S rm /etc/nginx/sites-enabled/crm.globusdemos.com
    echo "$PASS" | sudo -S systemctl restart nginx
else
    echo "NGINX IS OK. ATTEMPTING CERTBOT SSL."
    echo "$PASS" | sudo -S certbot --nginx -d crm.globusdemos.com --non-interactive --agree-tos -m admin@globussoft.com || true
    echo "$PASS" | sudo -S systemctl restart nginx
fi
echo "$PASS" | sudo -S systemctl status nginx --no-pager
