#!/usr/bin/env node
/**
 * hash-super-admin-password.js — one-time helper to generate the bcrypt
 * hash for SUPER_ADMIN_PASSWORD_HASH.
 *
 * The Super Admin Portal never stores or compares a plaintext password —
 * only this hash lives in .env. Run this once, paste the OUTPUT hash into
 * .env, then forget the plaintext (or store it in your team's password
 * manager, not in this repo).
 *
 * Usage:
 *   node scripts/hash-super-admin-password.js "your-password-here"
 *
 * If no argument is given, prompts on stdin so the password never appears
 * in shell history.
 */

const bcrypt = require("bcryptjs");
const readline = require("readline");

async function main() {
  const argPassword = process.argv[2];
  let password = argPassword;

  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise((resolve) => {
      rl.question("Enter the Super Admin password (input will be visible): ", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  console.log("\nAdd this to your .env file:\n");
  console.log(`SUPER_ADMIN_PASSWORD_HASH=${hash}\n`);
}

main().catch((e) => {
  console.error("Failed to generate hash:", e.message);
  process.exit(1);
});
