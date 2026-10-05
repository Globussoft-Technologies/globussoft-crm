const fs = require("fs");
const path = require("path");

const outputDirectory = path.join(__dirname, "dist");
for (const name of [
  "config.example.json",
  "run-hidden.vbs",
  "install-startup.ps1",
  "uninstall-startup.ps1",
  "README.md",
]) {
  fs.copyFileSync(path.join(__dirname, name), path.join(outputDirectory, name));
}
