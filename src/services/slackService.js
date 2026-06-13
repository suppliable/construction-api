'use strict';

const env = require('../config/env');
const admin = require('../utils/firebaseAdmin');
const { getCustomer } = require('../repositories/customerRepository');

// IST date key (YYYY-MM-DD) — counter resets at midnight Asia/Kolkata, matching
// the warehouse's local day rather than UTC.
function istDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// Atomically increment and return today's order sequence number. Backed by a
// per-day counter doc (counters/orders-YYYY-MM-DD). Display-only — the real
// orderId is unchanged. Best-effort: returns null on any failure so the Slack
// message still sends without the counter.
async function nextDailyOrderNumber() {
  try {
    const db = admin.firestore();
    const ref = db.collection('counters').doc(`orders-${istDateKey()}`);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = (snap.exists ? snap.data().count || 0 : 0) + 1;
      tx.set(ref, { count: next }, { merge: true });
      return next;
    });
  } catch {
    return null;
  }
}

async function resolveCustomer(order) {
  if (order.customerName && order.customerPhone) return { name: order.customerName, phone: order.customerPhone };
  try {
    const customer = await getCustomer(order.userId);
    return { name: customer?.name || 'N/A', phone: customer?.phone || 'N/A' };
  } catch {
    return { name: 'N/A', phone: 'N/A' };
  }
}

// Blocks for the items list, posted as a threaded reply under the order card.
// Returns null when the order has no items so the caller can skip the reply.
function itemsBlocks(order) {
  if (!order.items || order.items.length === 0) return null;
  const items = order.items
    .map(i => `• _${i.name} × ${i.quantity} ${i.unit}_`)
    .join('\n');
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `📦 *Items:*\n${items}` } },
  ];
}

const slackEnabled = () => Boolean(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID);

// ── Slack Web API (bot token) ──────────────────────────────────────────────
// Unlike incoming webhooks, the Web API returns a message `ts` we can later
// edit via chat.update. Both helpers are best-effort: they never throw, so a
// Slack outage can't break order creation or payment confirmation.

async function postMessage(blocks, text, threadTs = null) {
  if (!slackEnabled()) return null;
  try {
    const body = { channel: env.SLACK_CHANNEL_ID, text, blocks };
    if (threadTs) body.thread_ts = threadTs;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.ok ? data.ts : null;
  } catch {
    return null;
  }
}

async function updateMessage(ts, blocks, text) {
  if (!slackEnabled() || !ts) return;
  try {
    await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, ts, text, blocks }),
    });
  } catch {
    // best-effort
  }
}

// ── Order card ─────────────────────────────────────────────────────────────
// The payment line carries both the type and (for ONLINE) the lifecycle status
// so the same card can be edited in place. COD has no online payment lifecycle.
function paymentLine(order, state) {
  if (order.paymentType === 'COD') return '💵 *Payment:* :cod:';
  const status =
    state === 'paid' ? '✅ Success' :
    state === 'failed' ? '❌ Failed' :
    state === 'cancelled' ? '🚫 Cancelled' :
    '⏳ Waiting';
  return `💳 *Payment:* ONLINE — ${status}`;
}

function orderCardBlocks({ order, name, phone, dailyNo, state }) {
  const heading = dailyNo
    ? `🛒 *New Order #${dailyNo} today* · \`${order.orderId}\``
    : `🛒 *New Order:* \`${order.orderId}\``;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          heading,
          `👤 *Customer:* ${name}`,
          `📞 *Phone:* ${phone}`,
          paymentLine(order, state),
          `💰 *Order Value:* ₹${order.grand_total}`,
        ].join('\n'),
      },
    },
  ];
}

/**
 * Post the order card. For ONLINE orders this fires at checkout with the
 * payment line showing "Awaiting payment"; for COD it shows "COD". Returns
 * `{ ts, dailyNo }` (ts null if Slack is off / the post failed) so the caller
 * can persist them and later edit the card via updateOrderPaymentStatus while
 * preserving the "#N today" heading.
 */
async function postNewOrder(order) {
  if (!slackEnabled()) return { ts: null, dailyNo: null };
  const [{ name, phone }, dailyNo] = await Promise.all([
    resolveCustomer(order),
    nextDailyOrderNumber(),
  ]);
  const blocks = orderCardBlocks({ order, name, phone, dailyNo, state: undefined });
  const text = dailyNo ? `🛒 New Order #${dailyNo} today` : `🛒 New Order ${order.orderId}`;
  const ts = await postMessage(blocks, text);

  // Post the item list as a threaded reply under the card, so the channel stays
  // tidy and items are one click away. Best-effort; skipped if the card didn't
  // post or the order has no items.
  const items = itemsBlocks(order);
  if (ts && items) await postMessage(items, '📦 Items', ts);

  return { ts, dailyNo };
}

/**
 * Edit an already-posted order card to reflect the resolved payment state.
 * `state` ∈ 'paid' | 'failed' | 'cancelled'. Best-effort; no-op without a ts.
 * `order.dailyOrderNo` (if present) preserves the heading counter.
 */
async function updateOrderPaymentStatus(order, ts, state) {
  if (!slackEnabled() || !ts) return;
  const { name, phone } = await resolveCustomer(order);
  const blocks = orderCardBlocks({ order, name, phone, dailyNo: order.dailyOrderNo, state });
  const verb = state === 'paid' ? 'Success' : state === 'cancelled' ? 'Cancelled' : 'Failed';
  await updateMessage(ts, blocks, `🛒 Order ${order.orderId} — ${verb}`);
}

// ── Payment-failure alert (separate message per attempt) ───────────────────
const FAILURE_LABELS = {
  USER_DROPPED: 'Customer abandoned checkout',
  CANCELLED: 'Payment cancelled',
  cancelled: 'Payment cancelled',
  FAILED: 'Payment failed / declined',
  expired: 'Payment link expired',
  FLAGGED: 'Flagged for review',
};

function friendlyReason(raw) {
  if (!raw) return 'Unknown';
  const label = FAILURE_LABELS[raw];
  return label ? `${label} (${raw})` : String(raw);
}

// Map a raw gateway status to the card state. Customer-initiated drops/cancels
// and expired links read as "cancelled"; everything else is a real "failed".
const CANCELLED_STATUSES = new Set(['USER_DROPPED', 'CANCELLED', 'cancelled', 'expired']);
function cardStateFromRaw(raw) {
  return CANCELLED_STATUSES.has(raw) ? 'cancelled' : 'failed';
}

/**
 * Post a standalone 🚨 alert for a single failed payment attempt, with a
 * human-readable reason. One message per attempt (NOT an edit) so repeated
 * retries are all visible.
 */
async function notifyPaymentFailed(order, attempt) {
  if (!slackEnabled()) return;
  const { name, phone } = await resolveCustomer(order);
  const source = attempt && attempt.source ? attempt.source : 'unknown';
  const reason = friendlyReason(attempt && attempt.rawProviderStatus);

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `🚨 *Payment Failed:* \`${order.orderId}\``,
          `👤 *Customer:* ${name}`,
          `📞 *Phone:* ${phone}`,
          `💰 *Order Value:* ₹${order.grand_total}`,
          `⚠️ *Reason:* ${reason}`,
          `🔗 *Source:* ${source}`,
        ].join('\n'),
      },
    },
  ];
  await postMessage(blocks, `🚨 Payment Failed ${order.orderId}`);
}

module.exports = { postNewOrder, updateOrderPaymentStatus, notifyPaymentFailed, cardStateFromRaw };
