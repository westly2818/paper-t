// Indian Standard Time helpers (UTC+5:30, no daylight saving)
const IST = 5.5 * 3600 * 1000;
const pad = n => String(n).padStart(2, '0');
function parts(ms) {
  const d = new Date(ms + IST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay() };
}
const dayKey = ms => { const p = parts(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const minOfDay = ms => { const p = parts(ms); return p.hh * 60 + p.mm; };
const hhmm = ms => { const p = parts(ms); return `${pad(p.hh)}:${pad(p.mm)}`; };
const atMinute = (key, min) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) - IST + min * 60000; };
const isWeekday = ms => { const w = parts(ms).dow; return w > 0 && w < 6; };
module.exports = { IST, dayKey, minOfDay, hhmm, atMinute, isWeekday, OPEN: 9 * 60 + 15, CLOSE: 15 * 60 + 30 };
