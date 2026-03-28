import requests

url = "https://crm.globusdemos.com/api/auth/login"
payload = {"email": "admin@globussoft.com", "password": "admin"}      
headers = {"Content-Type": "application/json"}

print(f"Testing POST {url}")
try:
    response = requests.post(url, json=payload, headers=headers, timeout=10)
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text}")
    print(f"Headers: {response.headers}")
except Exception as e:
    print(f"Error: {e}")
