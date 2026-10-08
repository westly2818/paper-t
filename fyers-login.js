// One-time (daily) Fyers login: opens the Fyers login page, catches the redirect, saves the access token.
//   1. Put FYERS_APP_ID (like ABCD1234E5-100), FYERS_SECRET and FYERS_REDIRECT in .env
//      FYERS_REDIRECT must be EXACTLY the redirect URL saved in the Fyers app, e.g. http://127.0.0.1:3000/callback
//   2. Stop the paper-trader server if it uses the same port, then run:  node --env-file=.env fyers-login.js
// The token is saved to data/fyers-token.json (gitignored) and lasts until about midnight; run this again next day.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const { FYERS_APP_ID: appId, FYERS_SECRET: secret, FYERS_REDIRECT: redirect } = process.env;
if (!appId || !secret || !redirect) { console.error('Set FYERS_APP_ID, FYERS_SECRET and FYERS_REDIRECT in .env (run with: node --env-file=.env fyers-login.js)'); process.exit(1); }
const ru = new URL(redirect);
const authUrl = 'https://api-t1.fyers.in/api/v3/generate-authcode?' + new URLSearchParams({ client_id: appId, redirect_uri: redirect, response_type: 'code', state: 'paper-trader' });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== ru.pathname) { res.writeHead(404); return res.end('Not found'); }
  const code = u.searchParams.get('auth_code') || u.searchParams.get('code');
  if (!code || u.searchParams.get('s') === 'error') { res.writeHead(400); res.end('Login failed or cancelled. Close this tab and run the script again.'); console.error('No auth code in the redirect:', req.url); return; }
  try {
    const r = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash: crypto.createHash('sha256').update(`${appId}:${secret}`).digest('hex'), code })
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(JSON.stringify(j));
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'data', 'fyers-token.json'), JSON.stringify({ appId, access_token: j.access_token, savedAt: new Date().toISOString() }));
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Fyers login done. You can close this tab.');
    console.log('Token saved to data/fyers-token.json');
    // Also copy it to the database so the F&O book on Render can read prices (it expires about midnight, like the file). Skipped when no database is configured.
    const { UPSTASH_REDIS_REST_URL: dbUrl, UPSTASH_REDIS_REST_TOKEN: dbToken } = process.env;
    if (dbUrl && dbToken) {
      try {
        const w = await fetch(dbUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + dbToken }, body: JSON.stringify(['SET', 'paper-trader:fyers:token', JSON.stringify({ appId, access_token: j.access_token, savedAt: new Date().toISOString() }), 'EX', 86400]) });
        console.log((await w.json()).result === 'OK' ? 'Token also saved to the database for the F&O book (expires in 24 hours).' : 'Could not save the token to the database.');
      } catch (e) { console.log('Could not save the token to the database:', e.message); }
    }
    server.close(); process.exit(0);
  } catch (e) { res.writeHead(500); res.end('Token request failed, see the terminal.'); console.error('Token request failed:', e.message); }
});
server.listen(+ru.port || 80, ru.hostname, () => {
  console.log(`Listening on ${redirect}\nOpen this URL, log in and approve:\n\n${authUrl}\n`);
  exec(process.platform === 'win32' ? `start "" "${authUrl}"` : `xdg-open "${authUrl}"`);
});
