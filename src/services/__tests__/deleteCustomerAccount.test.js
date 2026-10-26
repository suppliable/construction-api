'use strict';

const mocks = {};
jest.mock('../firestoreService', () => ({
  getCustomer: (...a) => mocks.getCustomer(...a), saveCustomer: jest.fn(), getCustomerByPhone: jest.fn(),
}));
jest.mock('../../repositories/customerRepository', () => ({ deleteCustomer: (...a) => mocks.deleteCustomer(...a) }));
jest.mock('../../repositories/orderRepository', () => ({ getOrdersByUser: (...a) => mocks.getOrdersByUser(...a) }));
jest.mock('../../repositories/addressRepository', () => ({ deleteAllAddresses: (...a) => mocks.deleteAllAddresses(...a) }));
jest.mock('../../repositories/cartRepository', () => ({ deleteCart: (...a) => mocks.deleteCart(...a) }));
jest.mock('../fcmService', () => ({ deleteUserTokens: (...a) => mocks.deleteUserTokens(...a) }));
jest.mock('../zohoService', () => ({ createZohoContact: jest.fn(), updateZohoContact: (...a) => mocks.updateZohoContact(...a) }));
jest.mock('../../utils/firebaseAdmin', () => ({ auth: () => ({ deleteUser: (...a) => mocks.deleteAuthUser(...a) }) }));

jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }));

const { deleteCustomerAccount } = require('../customerService');

beforeEach(() => {
  Object.assign(mocks, {
    getCustomer: jest.fn().mockResolvedValue({ userId: 'u1', zoho_contact_id: 'z1', gstin: '' }),
    getOrdersByUser: jest.fn().mockResolvedValue([{ orderId: 'o1', status: 'delivered' }]),
    deleteCustomer: jest.fn().mockResolvedValue(),
    deleteAllAddresses: jest.fn().mockResolvedValue(0),
    deleteCart: jest.fn().mockResolvedValue(),
    deleteUserTokens: jest.fn().mockResolvedValue(),
    updateZohoContact: jest.fn().mockResolvedValue({}),
    deleteAuthUser: jest.fn().mockResolvedValue(),
  });
});

test('throws USER_NOT_FOUND for an unknown customer', async () => {
  mocks.getCustomer.mockResolvedValue(null);
  await expect(deleteCustomerAccount('u1')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
});

test('refuses while an order is in flight and deletes nothing', async () => {
  mocks.getOrdersByUser.mockResolvedValue([{ orderId: 'o2', status: 'out_for_delivery' }]);
  await expect(deleteCustomerAccount('u1')).rejects.toMatchObject({ code: 'ACTIVE_ORDERS', orderIds: ['o2'] });
  expect(mocks.deleteCustomer).not.toHaveBeenCalled();
});

test('anonymises the Zoho contact and erases customer data', async () => {
  const res = await deleteCustomerAccount('u1');
  expect(mocks.updateZohoContact).toHaveBeenCalledWith('z1', { name: 'Deleted Customer u1', phone: '' }, null);
  expect(mocks.deleteCustomer).toHaveBeenCalled();
  expect(mocks.deleteAuthUser).toHaveBeenCalledWith('u1');
  expect(res).toEqual({ zohoAnonymised: true, retainedOrders: 1 });
});

test('leaves a GSTIN customer’s Zoho contact intact', async () => {
  mocks.getCustomer.mockResolvedValue({ userId: 'u1', zoho_contact_id: 'z1', gstin: '33AAAAA0000A1Z5' });
  const res = await deleteCustomerAccount('u1');
  expect(mocks.updateZohoContact).not.toHaveBeenCalled();
  expect(res.zohoAnonymised).toBe(false);
});

test('a Zoho failure does not block deletion', async () => {
  mocks.updateZohoContact.mockRejectedValue(new Error('zoho down'));
  const res = await deleteCustomerAccount('u1');
  expect(mocks.deleteCustomer).toHaveBeenCalled();
  expect(res.zohoAnonymised).toBe(false);
});
