# Run the paper trader on a Google Cloud e2-micro VM

Written 23 Oct 2026. Prices and free limits change, so check the Google Cloud pricing page before you start. Nothing here places real orders: the bot is paper only.

## Before you start (read once)

- **Free tier, as I understand it:** one `e2-micro` VM per month is free in `us-west1` (Oregon), `us-central1` (Iowa) or `us-east1` (South Carolina), with 30 GB of standard disk and about 1 GB a month of outgoing traffic. A card is needed to open the account.
- **Possible small charge:** Google charges for a public IPv4 address (roughly 3 to 4 dollars a month), and I am not sure the free tier covers it. The bot needs internet access (prices, database, Gemini), so the VM needs that address. Check the cost shown on the VM page after you create it.
- **Safety net:** make a budget alert at 1 dollar (Billing, then Budgets & alerts) so you hear about any charge.
- **One copy only:** never run the bot on two machines at the same time (Render, your PC and the VM share one database and would double-trade). Keep Render suspended, or delete it, before the VM starts.

## 1. Create the VM

1. Open <https://console.cloud.google.com>, make or pick a project, and set up billing (card).
2. Menu, then **Compute Engine**, then **VM instances**, then **Create instance**.
3. Name `paper-trader`. Region `us-central1` (or another free-tier region). Machine: **e2-micro** (shown under General purpose, E2).
4. **Boot disk:** Change, then Debian 12, disk type **Standard persistent disk**, size **30 GB**.
5. Leave the firewall boxes unticked. Click **Create**.

## 2. Install it

1. On the VM list, click **SSH** next to the VM (a browser terminal opens).
2. Paste:

   ```
   curl -fsSL https://raw.githubusercontent.com/westly2818/paper-t/main/deploy/setup-vm.sh -o setup-vm.sh && bash setup-vm.sh
   ```

   If the GitHub repository is private that download fails. Then upload the file with the SSH window's gear icon, then **Upload file**, and run `REPO_URL=https://USER:TOKEN@github.com/westly2818/paper-t.git bash setup-vm.sh` where TOKEN is a read-only GitHub token. Never paste that token anywhere else.
3. The script stops and asks you to fill in the settings:

   ```
   sudo nano /opt/paper-trader/.env
   ```

   Copy the values from the `.env` file on your PC (the database URL and token, the Gemini key) and choose a dashboard password. Save with Ctrl+O, Enter, then Ctrl+X.
4. Start it:

   ```
   sudo systemctl restart paper-trader
   curl -s http://localhost:3000/health
   ```

   It should print `ok`. To watch it work: `sudo journalctl -u paper-trader -f` (Ctrl+C to leave).

## 3. Open the dashboard

**Safest (no open port):** on your PC, with the Google Cloud CLI installed:

```
gcloud compute ssh paper-trader --zone us-central1-a -- -L 3000:localhost:3000
```

Leave it open and browse to <http://localhost:3000> (user `admin`, your password).

**From your phone:** VPC network, then Firewall, then Create rule: allow `tcp:3000` from `0.0.0.0/0`, target the VM. Then use `http://<external IP>:3000`. The password travels unencrypted over plain http, so use a long unique password and never reuse one from elsewhere. If this matters, keep only the SSH tunnel option.

## 4. Switch over

1. Make sure Render stays suspended or is deleted.
2. In UptimeRobot, point the monitor at `http://<external IP>:3000/health` (or delete it; the VM does not sleep).
3. Fyers login stays the same: run `node --env-file=.env fyers-login.js` on your PC each morning. The token goes into the shared database, and the VM reads it from there.

## 5. Everyday

- **Update to the newest code:** `bash /opt/paper-trader/deploy/setup-vm.sh`
- **Restart:** `sudo systemctl restart paper-trader`
- **Is it alive:** `sudo systemctl status paper-trader`
- **Backups** still run on your PC: `node --env-file=.env db-backup.js` weekly.
- **Cost check:** Billing, then Reports, once a week for the first month.

## If something goes wrong

- `curl` prints nothing: look at `sudo journalctl -u paper-trader -n 50`. A missing database URL or token in `.env` is the usual cause.
- To stop everything: `sudo systemctl stop paper-trader`, or Stop the VM in the console.
- To go back: resume Render (after adding a card or at the monthly reset) and stop the VM first.
