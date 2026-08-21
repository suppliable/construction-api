'use strict';
// Diagnose MSG91 SMS/OTP delivery: balance, recent sends, failure reasons.
//   Usage: node scripts/msg91-doctor.js [dev|qa|prod|local] [days]
//          node scripts/msg91-doctor.js qa 7
//
//   Probe a candidate template id (SENDS A REAL SMS, ~Rs 0.25):
//          node scripts/msg91-doctor.js local 1 --probe 919876543210
//          node scripts/msg91-doctor.js local 1 --probe 919876543210 --template <24-hex>
//
//   How the probe decides: MSG91 returns 200 + request_id for *every* send, so the
//   response tells you nothing. A template it recognises produces a delivery-log
//   row; one it rejects (wrong/archived) is discarded before any row is written.
//   The report API lags several minutes, hence the polling.
//
// Why this exists: MSG91's v5 send endpoints return HTTP 200 with a request_id
// even when the message is dropped (zero balance, bad template). A "successful"
// send tells you nothing — only the delivery log and the balance do.
//
// Parses the target .env.local.<env> by hand rather than going through
// src/config/env.js, which runs a dotenv cascade that loads .env.local LAST with
// override:true and would silently swap in dev's credentials.
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const API_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const envName = (positional[0] || 'dev').toLowerCase();
const days = Number(positional[1] || 7);
const probeMobile = flag('probe');

const envFile = envName === 'local'
  ? '.env.local'
  : `.env.local.${envName}`;
const envPath = path.join(API_ROOT, envFile);

if (!fs.existsSync(envPath)) {
  console.error(`No such env file: ${envFile}`);
  console.error('Usage: node scripts/msg91-doctor.js [dev|qa|prod|local] [days]');
  process.exit(1);
}

const cfg = dotenv.parse(fs.readFileSync(envPath));
const AUTHKEY = cfg.MSG91_AUTH_KEY;
const TEMPLATE_ID = cfg.MSG91_TEMPLATE_ID;

if (!AUTHKEY) {
  console.error(`MSG91_AUTH_KEY missing from ${envFile}`);
  process.exit(1);
}

const mask = k => (k ? `${k.slice(0, 4)}***${k.slice(-4)}` : '(not set)');
const iso = d => d.toISOString().slice(0, 10);
const today = new Date();
const from = new Date(today.getTime() - days * 86400000);

async function outboundIp() {
  try {
    const res = await fetch('https://api.ipify.org');
    return (await res.text()).trim();
  } catch {
    return '(lookup failed)';
  }
}

async function logs(kind) {
  const res = await fetch(`https://control.msg91.com/api/v5/report/logs/${kind}`, {
    method: 'POST',
    headers: { authkey: AUTHKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: iso(from), endDate: iso(today), limit: 100 }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null; // MSG91 serves an HTML 404 page for unknown log kinds
  }
}

(async () => {
  console.log(`\nMSG91 doctor — env=${envName} (${envFile})`);
  console.log(`authkey=${mask(AUTHKEY)}  template_id=${TEMPLATE_ID || '(not set)'}`);
  console.log(`window: ${iso(from)} → ${iso(today)} (${days}d)\n`);

  // NOTE: do not use control.msg91.com/api/balance.php here. It reports LEGACY
  // SMS credits, which read 0 on wallet-based accounts regardless of funds — it
  // says nothing about whether you can send. Check the wallet in the dashboard.
  console.log(`outbound IP: ${await outboundIp()}`);
  console.log('  (if MSG91 IP whitelisting is on, a non-listed IP gets 200 + request_id and is then dropped)\n');

  for (const kind of ['sms', 'otp']) {
    const data = await logs(kind);
    if (!data) continue;
    const rows = data.data || [];
    const total = data.metadata?.total ?? rows.length;
    console.log(`${kind.toUpperCase()} delivery log — ${total} record(s)`);
    if (!rows.length) {
      console.log('  (none — a send that returned type:"success" but has no row here was dropped');
      console.log('   before delivery: archived/invalid template, or a non-whitelisted source IP)\n');
      continue;
    }
    for (const r of rows) {
      const reason = (r.failureReason || '').trim();
      console.log(
        `  ${r.sentDateTime}  ${String(r.telNum).padEnd(14)}` +
        `${String(r.status).padEnd(12)}${String(r.credit ?? '').padEnd(6)}${reason}`
      );
    }
    const spent = rows.reduce((s, r) => s + (r.credit || 0), 0);
    console.log(`  credits spent: ${spent.toFixed(2)}\n`);
  }
  if (!probeMobile) return;

  const candidate = flag('template') || TEMPLATE_ID;
  if (!/^[0-9a-f]{24}$/.test(candidate || '')) {
    console.log(`Probe aborted: "${candidate}" is not a 24-hex template id.`);
    return;
  }

  const mobile = String(probeMobile).replace(/\D/g, '');
  console.log(`Probe: sending OTP to ${mobile} with template ${candidate}`);
  const sendRes = await fetch(
    `https://control.msg91.com/api/v5/otp?template_id=${candidate}&mobile=${mobile}`,
    { method: 'POST', headers: { authkey: AUTHKEY } },
  );
  const sendBody = await sendRes.json().catch(() => ({}));
  console.log(`  -> ${sendRes.status} ${JSON.stringify(sendBody)}`);
  if (sendBody.type !== 'success') {
    console.log('  MSG91 rejected the send outright — see message above.\n');
    return;
  }

  // Poll gently: the report API rate-limits under tight loops.
  const started = Date.now();
  for (let i = 1; i <= 8; i++) {
    await new Promise(r => setTimeout(r, 60_000));
    const d = await logs('otp');
    const rows = (d && d.data) || [];
    const hit = rows.find(r => String(r.telNum || '').endsWith(mobile.slice(-10)));
    const mins = Math.round((Date.now() - started) / 60000);
    if (hit) {
      console.log(`\n  ✅ Row appeared after ~${mins}m — MSG91 RECOGNISES this template.`);
      console.log(`     ${hit.sentDateTime}  ${hit.status}  sender=${hit.senderId}` +
                  `  ${(hit.failureReason || '').trim()}`);
      console.log('     If sender is SMSIND, the template was ignored and MSG91 used its default.\n');
      return;
    }
    console.log(`  [${mins}m] no row yet...`);
  }
  console.log('\n  ❌ No delivery-log row after ~8m — MSG91 does NOT recognise this template id.');
  console.log('     It is wrong, archived, or belongs to a different MSG91 account.\n');
})().catch(err => {
  console.error('msg91-doctor failed:', err.message);
  process.exit(1);
});
