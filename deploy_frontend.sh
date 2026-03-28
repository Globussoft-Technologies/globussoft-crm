#!/bin/bash
PASS="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"
echo "$PASS" | sudo -S rm -rf /var/www/crm.globusdemos.com/*
echo "$PASS" | sudo -S cp -r ~/dist_patch/* /var/www/crm.globusdemos.com/
echo "$PASS" | sudo -S chown -R www-data:www-data /var/www/crm.globusdemos.com
