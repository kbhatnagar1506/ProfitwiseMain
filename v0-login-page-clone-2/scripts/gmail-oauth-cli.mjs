#!/usr/bin/env node
/**
 * Terminal-based Gmail OAuth: starts a local server, opens the browser for consent,
 * then saves access + refresh tokens so you can read the connected mailbox (e.g. for invoice extraction).
 *
 * Prerequisites:
 * 1. Google Cloud Console: create OAuth 2.0 Client ID (Desktop app or Web application).
 * 2. Add redirect URI: http://localhost:3232/callback
 * 3. Enable Gmail API for the project.
 *
 * Usage:
 *   GMAIL_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com \
 *   GMAIL_OAUTH_CLIENT_SECRET=your-client-secret \
 *   node scripts/gmail-oauth-cli.mjs
 *
 * Tokens are written to scripts/gmail-tokens.json (or --out=path).
 * Keep that file secret; use it from your server or store in DB/env.
 */

import { createServer } from "http";
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 3232;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
const outArg = process.argv.find((a) => a.startsWith("--out="));
const outPath = outArg ? outArg.slice(6) : join(__dirname, "gmail-tokens.json");

if (!clientId || !clientSecret) {
  console.error("Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET.");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const stateReceived = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<html><body><p>Authorization failed: ${error}</p><p>You can close this tab.</p></body></html>`
    );
    server.close();
    return;
  }
  if (stateReceived !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid state");
    server.close();
    return;
  }
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing code");
    server.close();
    return;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  }).toString();

  let tokenRes;
  try {
    tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<html><body><p>Token exchange failed: ${e.message}</p><p>Close this tab.</p></body></html>`
    );
    server.close();
    return;
  }

  const tokens = await tokenRes.json();
  if (tokens.error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<html><body><p>Token error: ${tokens.error} ${tokens.error_description || ""}</p><p>Close this tab.</p></body></html>`
    );
    server.close();
    return;
  }

  // Optionally fetch user email for display
  let email = null;
  if (tokens.access_token) {
    try {
      const profileRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      );
      if (profileRes.ok) {
        const profile = await profileRes.json();
        email = profile.email;
      }
    } catch {
      // ignore
    }
  }

  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    email,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<html><body><p>Success! Connected${email ? ` as <strong>${email}</strong>` : ""}.</p><p>Tokens saved to ${outPath}. You can close this tab and stop the script (Ctrl+C).</p></body></html>`
  );
  server.close();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL in your browser to connect your Workspace email:\n");
  console.log(authUrl.toString());
  console.log("\nWaiting for callback on http://localhost:" + PORT + "/callback ...");
  try {
    execSync(`open "${authUrl.toString()}"`, { stdio: "ignore" });
  } catch {
    // open not available (e.g. Linux); user can paste URL
  }
});
