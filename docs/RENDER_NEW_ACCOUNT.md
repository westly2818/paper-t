# Moving the paper trader to a new Render account, and keeping it from being suspended again

Written 24 Oct 2026. The old workspace was suspended because it used its 5 GB of free outbound bandwidth. Nothing was lost: all state is in Upstash Redis.

## What prevents a repeat (in the code, works on any host)
1. Responses over 1 KB are gzip-compressed (about 5x smaller). The dashboard refreshes every 10 s, only while the tab is visible.
2. `lib/usage.js` counts every byte the app sends out (responses to browsers and the bodies it uploads to Redis, Yahoo, Gemini and Fyers) against a monthly budget, `BW_BUDGET_GB` (default 4, leaving 1 GB of the 5 GB for headers, TLS and other services). The count is saved to Redis (a few bytes) and restarts on the 1st of each month (UTC).
   - below 60% of the budget: normal;
   - 60 to 85%: slow mode. The dashboard shows an amber banner and refreshes every minute; each visitor may fetch a heavy page once per 30 s;
   - 85% and above: protect mode. Pages and APIs answer with a tiny "paused" message (503); `/health`, `/api/usage`, the Fyers login and the trading engines keep working, so trading is never stopped by this guard.
3. A visitor cannot fetch `/api/state` more than once per 3 s, which also cuts old browser tabs still running the former 1.5-second script.
4. `/health` (2 bytes) is the only address a keep-alive pinger should hit. The engine writes less often to Redis (the equity curve alone changed every minute).
5. `GET /api/usage` shows the month, GB used and the mode at any time. Compare it with Render's own bandwidth figure (Dashboard, Metrics) at least weekly for the first month: the meter counts what the app knows it sent, so Render's figure is the truth and may be 5 to 10% higher.

## Setting up a new Render account (about 20 minutes)
1. Create the new Render account (a different email). Hobby plan. Connect the GitHub account that owns `westly2818/paper-t` and allow Render to read that repository.
2. New, Web Service, pick `paper-t`. Name it (the web address is `https://<name>.onrender.com`). Runtime Node, build command empty, start command `node server.js`, plan Free.
3. Environment variables (copy the values from the old service or your PC's `.env`; never paste them into chat): `MODE=live`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `LLM_API_KEY_FREE` (Gemini), `DASH_PASSWORD` (and `DASH_USER` if not `admin`), `FYERS_APP_ID`, `FYERS_SECRET`, optionally `BW_BUDGET_GB=4`.
4. **Fyers redirect:** the Fyers login button returns to `https://<name>.onrender.com/fyers/callback`. Add exactly that address as the redirect URL in your Fyers app settings (and remove or keep the old one), or the button will fail. Until then use `node --env-file=.env fyers-login.js` on your PC.
5. **Pinger:** point it at `https://<name>.onrender.com/health` every 5 minutes, Monday to Friday, 08:00 to 16:55 IST (cron `*/5 8-16 * * 1-5`, time zone Asia/Kolkata). A free service spins down after 15 minutes without traffic and takes about a minute to start; the 750 free hours a month are shared by all free services in the workspace.
6. **Only one live copy.** The old service must stay suspended or be deleted before the new one trades; two copies share one database and would double-trade.
7. Check: `https://<name>.onrender.com/health` prints `ok`; the dashboard loads (login with your password); `/api/usage` shows a small number; the Data tab shows the database saving.

## Two cautions
- A new account is a way around a free limit, not a fix for the cause. The fixes above are what prevent a repeat; without them a second account would hit the same cap. I have not read Render's current terms on multiple free accounts: check them, because a ban would suspend the service without notice.
- The ML shadow service (separate repo `ml-trading`, `render.yaml`) can go in the same new workspace; its traffic is tiny, but it also counts against the 750 free hours.
