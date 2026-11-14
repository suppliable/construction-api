'use strict';

// Pins the raw-vs-tracked ref rule. The service tests mock this repository
// wholesale, so nothing exercised its Firestore calls — and a real backfill
// died on the very first batch with "Value for argument 'documentRef' is not a
// valid DocumentReference", after 78 seconds of Zoho paging had already run.
//
// Cause: TrackedDb.batch() passes the underlying Firestore batch straight
// through, but TrackedDb.collection().doc() returns a TrackedDoc wrapper. A
// real batch will not accept one. The two cannot be mixed.

const mockBatchSet = jest.fn();
const mockBatchCommit = jest.fn(async () => {});
const mockRawDoc = { __raw: true };
const mockRawCollection = jest.fn(() => ({ doc: jest.fn(() => mockRawDoc) }));
const mockRawBatch = jest.fn(() => ({ set: mockBatchSet, commit: mockBatchCommit }));

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(() => ({ batch: mockRawBatch, collection: mockRawCollection })),
}));

// The tracked db is still used for reads; its doc refs are wrappers, and a
// batch must never receive one.
const mockTrackedDoc = { __tracked: true };
jest.mock('../../middleware/firestoreTracker', () => ({
  getTrackedDb: () => ({
    batch: jest.fn(() => ({ set: jest.fn(), commit: jest.fn() })),
    collection: jest.fn(() => ({
      doc: jest.fn(() => mockTrackedDoc),
      get: jest.fn(async () => ({ docs: [] })),
    })),
  }),
}));

const repo = require('../purchaseHistoryRepository');

beforeEach(() => jest.clearAllMocks());

const entry = i => ({ itemId: `I${i}`, rateIncl: 10 + i, lastDate: '2026-11-12' });

describe('upsertMany', () => {
  test('writes with RAW document refs, never tracked wrappers', async () => {
    await repo.upsertMany([entry(1)]);
    expect(mockBatchSet).toHaveBeenCalledTimes(1);
    const [ref] = mockBatchSet.mock.calls[0];
    expect(ref).toBe(mockRawDoc);
    expect(ref).not.toBe(mockTrackedDoc);
  });

  test('merges rather than replacing, so a partial entry cannot blank a record', async () => {
    await repo.upsertMany([entry(1)]);
    expect(mockBatchSet.mock.calls[0][2]).toEqual({ merge: true });
  });

  test('keys the document by item id as a string', async () => {
    await repo.upsertMany([{ itemId: 12345, rateIncl: 9 }]);
    const docFn = mockRawCollection.mock.results[0].value.doc;
    expect(docFn).toHaveBeenCalledWith('12345');
  });

  test('chunks under the 500-write batch cap and commits each', async () => {
    await repo.upsertMany(Array.from({ length: 450 }, (_, i) => entry(i)));
    expect(mockBatchCommit).toHaveBeenCalledTimes(2);
    expect(mockBatchSet).toHaveBeenCalledTimes(450);
  });

  test('returns the real count written, not the chunk size', async () => {
    // 450 over chunks of 400 — the tail is 50, so a naive `written += CHUNK`
    // would report 800.
    await expect(repo.upsertMany(Array.from({ length: 450 }, (_, i) => entry(i)))).resolves.toBe(450);
  });

  test('writes nothing for an empty list', async () => {
    await expect(repo.upsertMany([])).resolves.toBe(0);
    expect(mockRawBatch).not.toHaveBeenCalled();
  });
});
