// Small namespaced storage: Upstash Redis when configured (keys "paper-trader:<name>:<key>"), otherwise files under data/.
// Used by the study modules (movers). Nothing here is shared with the trading engine or the swing portfolio.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(cfg, name) { this.cfg = cfg; this.name = name; this.dir = path.join(__dirname, '..', 'data'); }
  key(k) { return `paper-trader:${this.name}:${k}`; }
  async redis(cmd) {
    const r = await fetch(this.cfg.upstashUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + this.cfg.upstashToken }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
    return j.result;
  }
  async get(k) {
    if (this.cfg.upstashUrl) { const r = await this.redis(['GET', this.key(k)]); return r ? JSON.parse(r) : null; }
    const f = path.join(this.dir, `${this.name}-${k}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  async set(k, obj) {
    if (this.cfg.upstashUrl) { await this.redis(['SET', this.key(k), JSON.stringify(obj)]); return; }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${this.name}-${k}.json`), JSON.stringify(obj));
  }
  async push(k, rec) {
    if (this.cfg.upstashUrl) { await this.redis(['RPUSH', this.key(k), JSON.stringify(rec)]); return; }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, `${this.name}-${k}.jsonl`), JSON.stringify(rec) + '\n');
  }
  async list(k) {
    if (this.cfg.upstashUrl) return (await this.redis(['LRANGE', this.key(k), 0, -1])).map(x => JSON.parse(x));
    const f = path.join(this.dir, `${this.name}-${k}.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  }
}

module.exports = { Store };
