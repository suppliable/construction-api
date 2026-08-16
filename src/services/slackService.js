'use strict';

const env = require('../config/env');
const admin = require('../utils/firebaseAdmin');
const { getCustomer } = require('../repositories/customerRepository');
const { istDateKey } = require('../utils/istDate');
const { formatISTTime, formatISTDate } = require('../utils/storeSchedule');

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

// Channel for warehouse open/close broadcasts. Currently unset, so these post
// into the order channel alongside order cards — that's intentional. Set
// SLACK_BROADCAST_CHANNEL_ID (a channel ID, not a name) to split them out; each
// env already points SLACK_CHANNEL_ID at its own channel, so this needs no
// per-env routing of its own.
const broadcastChannel = () =>
  env.SLACK_BROADCAST_CHANNEL_ID || env.SLACK_CHANNEL_ID;

// Scheduled ticks only ever run in prod: Cloud Scheduler is scoped to the
// suppliable-app GCP project, and dev/qa run on Render where no cron reaches
// them. Manual closes DO fire from every env (they run inline on the admin
// request), so the env label below is what distinguishes a qa test close from a
// real prod outage in a shared channel.

// ── Slack Web API (bot token) ──────────────────────────────────────────────
// Unlike incoming webhooks, the Web API returns a message `ts` we can later
// edit via chat.update. Both helpers are best-effort: they never throw, so a
// Slack outage can't break order creation or payment confirmation.

async function postMessage(blocks, text, threadTs = null, channel = null) {
  if (!slackEnabled()) return null;
  try {
    const body = { channel: channel || env.SLACK_CHANNEL_ID, text, blocks };
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

// ── Warehouse open/close broadcast ─────────────────────────────────────────

/**
 * Announce a warehouse open/close transition to the broadcast channel.
 *
 * `kind` ∈ 'scheduled' (a schedule boundary passed, prod only — see above) |
 * 'manual' (an admin acted, any env).
 *
 * Best-effort: never throws, so it can't break the caller.
 */

// Whether the routine daily scheduled open is announced. Closes and all manual
// actions always post. Set false to mute the every-morning "open" message while
// keeping the ones that signal something unusual.
const ANNOUNCE_SCHEDULED_OPEN = true;

async function notifyWarehouseTransition({ kind, isOpen, until, message }) {
  if (!slackEnabled()) return;
  if (isOpen && kind === 'scheduled' && !ANNOUNCE_SCHEDULED_OPEN) return;

  const heading = isOpen
    ? (kind === 'manual' ? '🟢 *Warehouse reopened* — by admin' : '🟢 *Warehouse open*')
    : (kind === 'manual' ? '🔴 *Warehouse closed* — by admin' : '🔴 *Warehouse closed*');

  const lines = [heading, `🏷️ *Environment:* ${env.appEnv}`];
  if (!isOpen && until) {
    lines.push(`⏰ *Reopens around:* ${formatISTTime(new Date(until))} IST`);
  }
  if (!isOpen && message) {
    lines.push(`💬 *Customers see:* _${message}_`);
  }

  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
  const text = isOpen ? '🟢 Warehouse open' : '🔴 Warehouse closed';
  await postMessage(blocks, text, null, broadcastChannel());
}

// ── Pending-orders summary (scheduled tick) ────────────────────────────────
// A periodic digest of ALL orders awaiting admin acceptance (status ===
// 'warehouse_review'), posted to the broadcast channel. Unlike postNewOrder /
// notifyPaymentFailed (one Slack call per order, worth a live customer
// lookup), this runs every 15 min over potentially many orders —
// customerName/Phone are read directly off the order doc (denormalized at
// creation in orderService.js for every path that reaches warehouse_review)
// rather than round-tripping to customerRepository per order.

const PENDING_SECTION_CHAR_BUDGET = 2800; // stay under Slack's 3000-char block text limit

// "COD" for cash-on-delivery orders; online orders further distinguish a
// confirmed payment from one still settling (pending_proceeding/pending) so
// the admin can see at a glance which orders haven't actually been paid for.
function paymentModeLabel(order) {
  if (order.paymentType !== 'ONLINE') return 'COD';
  return order.paymentStatus === 'confirmed' ? 'ONLINE (paid)' : 'ONLINE (pending)';
}

function pendingOrderLine(order, index) {
  const name = order.customerName || 'N/A';
  const phone = order.customerPhone || 'N/A';
  const createdAt = new Date(order.createdAt);
  const date = formatISTDate(createdAt);
  const time = `${formatISTTime(createdAt)} IST`;
  const paymentMode = paymentModeLabel(order);
  return `${index + 1}. \`${order.orderId}\` — ${name} · ${phone} · ₹${order.grand_total} · ${paymentMode} · ${date} ${time}`;
}

// Chunks lines into section blocks so no single block's text exceeds Slack's
// ~3000-char limit. `header` (if given) is prepended to the first chunk.
function chunkIntoSectionBlocks(lines, header) {
  const blocks = [];
  let current = header ? [header] : [];
  let currentLen = header ? header.length : 0;

  for (const line of lines) {
    const addedLen = line.length + 1; // + newline
    if (current.length > 0 && currentLen + addedLen > PENDING_SECTION_CHAR_BUDGET) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current.join('\n') } });
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += addedLen;
  }
  if (current.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current.join('\n') } });
  }
  return blocks;
}

/**
 * Post a digest of orders awaiting admin acceptance to the broadcast channel.
 * Caller passes orders already filtered to status === 'warehouse_review',
 * oldest-first. No-op if `orders` is empty (also guarded by the caller).
 * Best-effort via postMessage: never throws.
 */
async function notifyPendingOrders(orders) {
  if (!slackEnabled() || !orders || orders.length === 0) return null;

  const count = orders.length;
  const header = `⏳ *${count} order${count === 1 ? '' : 's'} awaiting acceptance*`;
  const lines = orders.map(pendingOrderLine);
  const blocks = chunkIntoSectionBlocks(lines, header);
  const text = `⏳ ${count} order${count === 1 ? '' : 's'} awaiting acceptance`;

  return postMessage(blocks, text, null, broadcastChannel());
}

module.exports = {
  postNewOrder,
  updateOrderPaymentStatus,
  notifyPaymentFailed,
  cardStateFromRaw,
  notifyWarehouseTransition,
  notifyPendingOrders,
};
