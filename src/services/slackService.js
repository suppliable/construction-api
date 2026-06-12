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

async function notifyNewOrder(order) {
  if (!env.SLACK_WEBHOOK_URL) return;

  const [{ name, phone }, dailyNo] = await Promise.all([
    resolveCustomer(order),
    nextDailyOrderNumber(),
  ]);
  const items = order.items
    .map(i => `• _${i.name} × ${i.quantity} ${i.unit}_`)
    .join('\n');

  const payIcon = order.paymentType === 'COD' ? '💵' : '💳';
  const heading = dailyNo
    ? `🛒 *New Order #${dailyNo} today* · \`${order.orderId}\``
    : `🛒 *New Order:* \`${order.orderId}\``;
  const payload = {
    text: dailyNo ? `🛒 New Order #${dailyNo} today` : `🛒 New Order \`${order.orderId}\``,
    blocks: [
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            heading,
            `👤 *Customer:* ${name}`,
            `📞 *Phone:* ${phone}`,
            `${payIcon} *Payment:* ${order.paymentType}`,
            `💰 *Order Value:* ₹${order.grand_total}`,
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `📦 *Items:*\n${items}` },
      },
    ],
  };

  await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function notifyPaymentFailed(order, attempt) {
  if (!env.SLACK_WEBHOOK_URL) return;

  const { name, phone } = await resolveCustomer(order);
  const source = attempt && attempt.source ? attempt.source : 'unknown';
  const rawStatus = attempt && attempt.rawProviderStatus ? JSON.stringify(attempt.rawProviderStatus) : 'N/A';

  const payload = {
    text: `❌ Payment Failed \`${order.orderId}\``,
    blocks: [
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `❌ *Payment Failed:* \`${order.orderId}\``,
            `👤 *Customer:* ${name}`,
            `📞 *Phone:* ${phone}`,
            `💰 *Order Value:* ₹${order.grand_total}`,
            `🔗 *Source:* ${source}`,
            `⚠️ *Gateway Status:* ${rawStatus}`,
          ].join('\n'),
        },
      },
    ],
  };

  await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

module.exports = { notifyNewOrder, notifyPaymentFailed };
