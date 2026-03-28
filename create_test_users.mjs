import fs from 'fs';

async function setup() {
    const API_URL = 'https://crm.globusdemos.com/api';

    // 1. Login as ADMIN bypass
    console.log("Logging in as Admin bypass...");
    const loginRes = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email: 'admin', password: 'admin' })
    });
    const authData = await loginRes.json();
    if (!authData.token) {
        console.error("Failed to login as admin bypass", authData);
        process.exit(1);
    }
    const token = authData.token;
    console.log("Admin logged in.");

    // 2. Register Manager
    console.log("Registering Manager user...");
    const regManager = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email: 'manager@crm.com', password: 'password123', name: 'Test Manager' })
    });
    const managerData = await regManager.json();
    
    // 3. Elevate Manager
    if (managerData.user && managerData.user.id) {
        await fetch(`${API_URL}/auth/users/${managerData.user.id}/role`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ role: 'MANAGER' })
        });
        console.log("Manager registered and elevated.");
    } else {
        console.log("Manager might already exist.");
    }

    // 4. Register User
    console.log("Registering Standard User...");
    await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email: 'user@crm.com', password: 'password123', name: 'Test User' })
    });
    console.log("User registered.");
}

setup().catch(console.error);
