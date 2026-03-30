import time
import urllib.request
import json
import os
import ssl

API_URL = "https://api.github.com/repos/Globussoft-Technologies/globussoft-crm/issues?state=open"
CHECKED_ISSUES_FILE = "checked_issues.json"

print("Starting Background Bug Monitor Cron (10m loop)...")

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

headers = {"User-Agent": "python-urllib"}

while True:
    try:
        req = urllib.request.Request(API_URL, headers=headers)
        with urllib.request.urlopen(req, context=ctx) as response:
            if response.status == 200:
                issues = json.loads(response.read().decode('utf-8'))
                known = set()
                if os.path.exists(CHECKED_ISSUES_FILE):
                    with open(CHECKED_ISSUES_FILE, 'r', encoding='utf-8') as f:
                        known = set(json.load(f))
                
                new_known = set()
                for issue in issues:
                    num = issue.get("number")
                    new_known.add(num)
                    if num not in known and os.path.exists(CHECKED_ISSUES_FILE):
                        title = issue.get('title')
                        print(f"\n🚨 NEW BUG REPORTED: #{num} - {title}\n")
                
                with open(CHECKED_ISSUES_FILE, 'w', encoding='utf-8') as f:
                    json.dump(list(new_known), f)
            else:
                print(f"Failed to fetch issues: {response.status}")
    except Exception as e:
        print(f"Error checking issues: {e}")
    
    time.sleep(600)
