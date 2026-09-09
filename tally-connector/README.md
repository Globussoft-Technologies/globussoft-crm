# Globussoft Tally Connector

This application runs on the same Windows computer as Tally and makes an outbound secure WebSocket connection to the CRM. Tally port 9000 remains local.

1. In the CRM Tally export screen, select **Generate connector credentials**.
2. Copy `config.example.json` to `config.json` and paste the returned URL, connector ID, and one-time token.
3. In Tally, open the required company and enable the HTTP/XML service on port 9000.
4. For development, run `npm install` and `npm start`.
5. For Windows packaging, run `npm run build:windows`, place `config.json` beside the generated EXE, and run `install-startup.ps1` as Administrator.

Never change `localTallyUrl` to a public or remote address. The connector rejects non-local addresses.
