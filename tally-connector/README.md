# Globussoft Tally Connector for Windows

The connector runs on the Windows computer that hosts Tally. It makes an outbound WebSocket connection to Globussoft CRM and talks to the local Tally HTTP/XML service. Tally port 9000 stays local.

## First-time setup (CRM download)

1. Extract the entire downloaded `TallyConnector.zip` into a writable folder, such as `C:\TallyConnector`. Keep all files together; the ZIP already contains the CRM-generated `config.json`.
2. Open the correct company in Tally and enable its HTTP/XML service on port 9000.
3. In File Explorer, open the extracted folder, click the address bar, type `powershell`, and press **Enter**. In the PowerShell window, run:

   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\install-startup.ps1
   ```

   The execution-policy change applies only to this PowerShell window. This is a per-user install and does not normally need Administrator access. It starts the connector hidden and adds it to that user's Startup folder.
4. Check `logs\connector.log` in the extracted folder. Look for `Connected to Globussoft CRM`; connection errors are recorded there too.
5. To disconnect later, open PowerShell in the same folder, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, then run `./uninstall-startup.ps1`.

## Build

On a build computer with Node.js and npm:

```powershell
cd tally-connector
npm ci
npm run build:windows
```

The build creates `dist/TallyConnector.exe` and copies the deployment scripts and configuration template into `dist/`. The executable contains the connector code; Node.js is not needed on the Tally computer. Keep the deployment files together in a writable folder on that computer, for example `C:\Globussoft\TallyConnector`:

```text
TallyConnector.exe
config.json
run-hidden.vbs
install-startup.ps1
uninstall-startup.ps1
logs/connector.log       (created automatically)
```

Do not install in `Program Files` unless the signed-in user can write to its `logs` folder. Keep `config.json` private because it contains the connector token.

## Configure

If you downloaded `TallyConnector.zip` from the CRM Tally export screen, it already contains a generated `config.json` and the deployment scripts. Extract the whole ZIP into one folder. If you built the executable yourself, select **Generate connector credentials** in the CRM, copy `config.example.json` to `config.json` beside the executable, and set:

| Field | Value |
| --- | --- |
| `serverUrl` | CRM connector WebSocket URL, usually `wss://<crm-host>/ws/tally-connector` |
| `customerId` | Customer ID returned by the CRM |
| `connectorId` | Connector ID returned by the CRM |
| `token` | One-time connector token returned by the CRM |
| `machineId` | A name for this Tally computer |
| `localTallyUrl` | Local Tally HTTP/XML address, normally `http://127.0.0.1:9000` |
| `requestTimeoutMs` | Timeout for a Tally request in milliseconds |
| `rejectUnauthorized` | Keep `true` to verify the CRM TLS certificate |

Open the correct company in Tally and enable its HTTP/XML service on port 9000. `localTallyUrl` must point to localhost; the connector rejects remote addresses.

## Install and verify

From PowerShell in the deployment folder, run:

```powershell
.\install-startup.ps1
```

The installer checks for the executable, configuration, and VBS launcher. It creates or updates `Globussoft Tally Connector.lnk` in the current user's Startup folder, pointing to `wscript.exe`, then starts the connector hidden immediately. Running the installer again updates the shortcut without starting a second connector process. Administrator rights are not required for a per-user install.

Check `logs/connector.log` for startup, connection, reconnect, and job messages. The process remains hidden while running. The Startup shortcut launches it at the next sign-in for this Windows user. To verify that behavior, sign out and back in, then check for a new startup entry in the log and a running `TallyConnector.exe` process. A reachable CRM should produce a `Connected to Globussoft CRM` entry; otherwise, the connector logs errors and retries.

The executable resolves both `config.json` and `logs/connector.log` relative to its own folder, regardless of the current working directory.

## Uninstall

Run `./uninstall-startup.ps1` from the deployment folder. It removes the current user's Startup shortcut and stops the connector process started from this folder. It leaves `config.json` and logs for inspection. You can then remove the deployment folder if no longer needed.
