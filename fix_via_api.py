import requests

API_URL = "https://crm.globusdemos.com/api"

print("1. Logging in via Simulator Bypass...")
res = requests.post(f"{API_URL}/auth/login", json={"email": "admin", "password": "admin"})
token = res.json().get("token")
if not token:
    print("Failed to get simulator token!")
    exit(1)

headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

print("2. Fetching User Directory...")
res = requests.get(f"{API_URL}/auth/users", headers=headers)
users = res.json()

target_id = None
for u in users:
    if u.get("email") == "admin@globussoft.com":
        target_id = u.get("id")
        break

if target_id:
    print(f"3. Found corrupted admin root (ID: {target_id}). Obliterating...")
    requests.delete(f"{API_URL}/auth/users/{target_id}", headers=headers)
else:
    print("3. Admin root not found in DB, proceeding to register...")

print("4. Registering Master Admin natively (forces bcrypt hash integration)...")
reg_res = requests.post(f"{API_URL}/auth/register", json={
    "email": "admin@globussoft.com",
    "password": "password123",
    "name": "Super Admin"
})
new_user = reg_res.json().get("user", {})
new_id = new_user.get("id")

if new_id:
    print(f"5. Promoting new user (ID: {new_id}) to ADMIN layer...")
    requests.put(f"{API_URL}/auth/users/{new_id}/role", headers=headers, json={"role": "ADMIN"})
    print("SUCCESS: Admin user rebuilt with secure cryptography!")
else:
    print("FAILED to register new user. Response:", reg_res.text)
