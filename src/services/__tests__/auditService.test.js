'use strict';

// The audit log exists because structured logs expire — roughly a fortnight on
// Grafana Cloud's free tier — while "who raised this price?" tends to be asked
// months later. These tests pin the two properties that make it trustworthy:
// it records the actor, and it never breaks the thing it is recording.

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(), auth: jest.fn(), database: jest.fn(),
}));
jest.mock('../../repositories/auditRepository', () => ({
  append: jest.fn(async e => e),
  list: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const repo = require('../../repositories/auditRepository');
const audit = require('../auditService');

const mkReq = (over = {}) => ({
  adminUser: { userId: 'ravi@suppliable.in', name: 'Ravi', role: 'admin' },
  traceContext: { traceId: 'trace-1' },
  log: { warn: jest.fn() },
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('record', () => {
  test('captures who, what, and the before/after of a value change', async () => {
    await audit.record(mkReq(), audit.ACTIONS.SELLING_PRICE_CHANGED,
      { type: 'item', id: 'I1', name: 'Brass Reducer' },
      { before: 65, after: 80 }, { lastPurchaseIncl: 75.45 });

    const [entry] = repo.append.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'selling_price.changed',
      label: 'Changed selling price',
      actorId: 'ravi@suppliable.in',
      actorName: 'Ravi',
      targetType: 'item', targetId: 'I1', targetName: 'Brass Reducer',
      before: 65, after: 80,
      traceId: 'trace-1',
    });
    expect(entry.at).toBeTruthy();
  });

  test('flags an action taken on the shared credential, so "unknown" is explicable', async () => {
    const req = mkReq({ adminUser: { userId: 'legacy-shared-token', name: 'Shared admin token', isLegacy: true } });
    await audit.record(req, audit.ACTIONS.BILL_CREATED, { type: 'bill', id: 'B1' });
    expect(repo.append.mock.calls[0][0].actorIsLegacy).toBe(true);
  });

  test('records "unknown" rather than throwing when there is no user', async () => {
    await audit.record({ log: { warn: jest.fn() } }, audit.ACTIONS.BILL_CREATED, { type: 'bill', id: 'B1' });
    expect(repo.append.mock.calls[0][0].actorId).toBe('unknown');
  });

  test('NEVER throws — a failed audit row must not undo a bill Zoho already accepted', async () => {
    repo.append.mockRejectedValue(new Error('firestore down'));
    const req = mkReq();
    await expect(audit.record(req, audit.ACTIONS.BILL_CREATED, { type: 'bill', id: 'B1' }))
      .resolves.toBeUndefined();
    expect(req.log.warn).toHaveBeenCalledWith(expect.anything(), 'audit.write_failed');
  });

  test('every action has a human label — the page should not show raw keys', () => {
    for (const action of Object.values(audit.ACTIONS)) {
      expect(audit.LABELS[action]).toBeTruthy();
    }
  });
});

describe('list', () => {
  const rows = [
    { at: '2026-11-17T10:00:00.000Z', actorId: 'ravi@x.in', action: 'bill.created' },
    { at: '2026-11-16T10:00:00.000Z', actorId: 'nila@x.in', action: 'selling_price.changed' },
    { at: '2026-11-15T10:00:00.000Z', actorId: 'ravi@x.in', action: 'selling_price.changed' },
  ];
  beforeEach(() => repo.list.mockResolvedValue(rows));

  test('filters by person', async () => {
    expect(await audit.list({ actorId: 'ravi@x.in' })).toHaveLength(2);
  });

  test('filters by action', async () => {
    expect(await audit.list({ action: 'selling_price.changed' })).toHaveLength(2);
  });

  test('a "to" date includes the whole day, not midnight', async () => {
    // Filtering on a bare date would otherwise drop everything after 00:00.
    expect(await audit.list({ from: '2026-11-16', to: '2026-11-16' })).toHaveLength(1);
  });

  test('combines filters', async () => {
    const out = await audit.list({ actorId: 'ravi@x.in', action: 'selling_price.changed' });
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe('2026-11-15T10:00:00.000Z');
  });

  test('no filters returns everything', async () => {
    expect(await audit.list({})).toHaveLength(3);
  });
});
