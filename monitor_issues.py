import time
import requests
import json
import os

API_URL = "https://api.github.com/repos/Globussoft-Technologies/globussoft-crm/issues?state=open"
CHECKED_ISSUES_FILE = "checked_issues.json"

print("Starting Background Bug Monitor Cron (10m loop)...")

while True:
    try:
        res = requests.get(API_URL)
        if res.status_code == 200:
            issues = res.json()
            known = set()
            if os.path.exists(CHECKED_ISSUES_FILE):
                with open(CHECKED_ISSUES_FILE, 'r') as f:
                    known = set(json.load(f))
            
            new_known = set()
            for issue in issues:
                num = issue.get("number")
                new_known.add(num)
                if num not in known and os.path.exists(CHECKED_ISSUES_FILE):
                    title = issue.get('title')
                    print(f"\n🚨 NEW BUG REPORTED: #{num} - {title}\n")
            
            with open(CHECKED_ISSUES_FILE, 'w') as f:
                json.dump(list(new_known), f)
        else:
            print(f"Failed to fetch issues: {res.status_code}")
    except Exception as e:
        print(f"Error checking issues: {e}")
    
    time.sleep(600)
