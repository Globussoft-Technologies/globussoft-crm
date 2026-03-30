import urllib.request
import json
import ssl

import os

token = os.getenv("GITHUB_TOKEN", "")
repo = "Globussoft-Technologies/globussoft-crm"
issues = list(range(70, 83)) + [98, 99] + list(range(100, 106))

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

headers = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "python-urllib"
}

for i in issues:
    url = f"https://api.github.com/repos/{repo}/issues/{i}"
    data = json.dumps({"state": "closed"}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="PATCH")
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            print(f"Issue {i} closed successfully")
    except Exception as e:
        print(f"Failed to close issue {i}: {e}")
