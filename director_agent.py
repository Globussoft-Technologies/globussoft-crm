import urllib.request
import urllib.error
import json
import ssl
import os
import time
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# Authentication Keys
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip('"').strip("'")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_REPO = "Globussoft-Technologies/globussoft-crm"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def query_gemini_director():
    """Ping Gemini to simulate an authoritative Sales Director feature request."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
    
    prompt = """
    You are an aggressive, visionary Sales Director at Globussoft.
    Propose exactly ONE new, high-ROI feature for the CRM.
    The CRM already has Pipeline Deals, Tasks, Expected Revenue, and Call Queues.
    Respond with a JSON object in exactly this format, nothing else:
    {"title": "[FEATURE] Your Feature Idea", "body": "A detailed 2-paragraph description of the use-case."}
    """
    
    payload = {
        "contents": [{"parts": [{"text": prompt}]}]
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            data = json.loads(response.read().decode("utf-8"))
            content = data["candidates"][0]["content"]["parts"][0]["text"]
            # Clean markdown JSON wrapping if present
            content = content.replace("```json", "").replace("```", "").strip()
            return json.loads(content)
    except urllib.error.HTTPError as e:
        print(f"[Error] Gemini API failed: {e.code} - {e.read().decode('utf-8')}")
        return None
    except Exception as e:
        print(f"[Error] Gemini request exception: {e}")
        return None

def push_github_issue(suggestion):
    """Post the Feature Request algorithmically to the Issue Tracker."""
    if not suggestion: return
    
    url = f"https://api.github.com/repos/{GITHUB_REPO}/issues"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "python-urllib"
    }
    
    body = f"**Sales Director Autonomous Suggestion**\n\n{suggestion['body']}"
    payload = {"title": suggestion["title"], "body": body}
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            res_data = json.loads(response.read().decode("utf-8"))
            print(f"[{datetime.now().strftime('%H:%M:%S')}] 🚀 Successfully posted: {res_data['html_url']}")
    except Exception as e:
        print(f"[Error] GitHub API failed: {e}")

if __name__ == "__main__":
    if not GEMINI_API_KEY:
        print("🚨 CRITICAL ERROR: GEMINI_API_KEY not found in .env file.")
        print("Please add 'GEMINI_API_KEY=your_key_here' to the c:/Users/Admin/gbs-projects/gbs-crm/.env file.")
        exit(1)
        
    print("👔 Starting Autonomous Sales Director Agent...")
    print("This cron will generate and assign a new feature idea to the GitHub board every 10 minutes.\n")
    
    while True:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Calling Gemini Visionary Engine...")
        idea = query_gemini_director()
        if idea:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Pushing blueprint to GitHub Issues...")
            push_github_issue(idea)
            
        print("Sleeping for 10 minutes...\n")
        time.sleep(600)
