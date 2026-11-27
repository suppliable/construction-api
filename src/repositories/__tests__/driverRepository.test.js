'use strict';

// A removed-and-re-added driver has two records on one number. Sign-in must pick
// the active one, not whichever Firestore happens to return first.

const mockGet = jest.fn();
jest.mock('../../middleware/firestoreTracker', () => ({
  getTrackedDb: () => ({ collection: () => ({ where: () => ({ get: mockGet, limit: () => ({ get: mockGet }) }) }) }),
}));
jest.mock('../../utils/dbOp', () => ({ dbOp: (_name, fn) => fn() }));

const { getDriverByPhone } = require('../driverRepository');

const records = (...rows) => mockGet.mockResolvedValue({
  empty: rows.length === 0,
  docs: rows.map(({ id, ...data }) => ({ id, data: () => data })),
});

beforeEach(() => jest.clearAllMocks());

test('the re-added active record wins over the older removed one', async () => {
  records({ id: 'DR100', isActive: false, pin: 'old' }, { id: 'DR200', isActive: true, pin: 'new' });
  await expect(getDriverByPhone('+910000000000')).resolves.toMatchObject({ driverId: 'DR200' });
});

test('among active records, one with a PIN beats a newer one without', async () => {
  records({ id: 'DR100', isActive: true, pin: 'set' }, { id: 'DR200', isActive: true });
  await expect(getDriverByPhone('+910000000000')).resolves.toMatchObject({ driverId: 'DR100' });
});

test('between equals, the newest', async () => {
  records({ id: 'DR100', isActive: true, pin: 'a' }, { id: 'DR200', isActive: true, pin: 'b' });
  await expect(getDriverByPhone('+910000000000')).resolves.toMatchObject({ driverId: 'DR200' });
});

test('only removed records: returns one, so sign-in can say "inactive"', async () => {
  records({ id: 'DR100', isActive: false }, { id: 'DR200', isActive: false });
  await expect(getDriverByPhone('+910000000000')).resolves.toMatchObject({ driverId: 'DR200', isActive: false });
});

test('an unknown number is null', async () => {
  records();
  await expect(getDriverByPhone('+910000000000')).resolves.toBeNull();
});
