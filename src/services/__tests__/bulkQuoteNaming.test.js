'use strict';

// A bulk line's orderable item is a Zoho VARIANT, whose name is only its size
// ("1 inch (25 mm)"). These tests pin the rule that a quote line always names
// the product it belongs to — on request, on read, and once ops has priced it.
//
// bulkRepository pulls in Firestore at require-time and productService pulls in
// Zoho, so both are mocked here rather than loaded, same as the other service
// tests.

jest.mock('../../repositories/bulkRepository', () => ({
  listCategoryOverlays: jest.fn(),
  saveQuote: jest.fn(async q => q),
  getQuote: jest.fn(),
  updateQuote: jest.fn(async (id, data) => ({ id, ...data })),
  getPhotoSlots: jest.fn(async () => []),
}));
jest.mock('../../services/productService', () => ({
  getAllProducts: jest.fn(),
  getProductById: jest.fn(),
}));
jest.mock('../../services/remoteConfigService', () => ({
  getString: jest.fn(async (_k, d) => d),
  getNumber: jest.fn(async (_k, d) => d),
}));
jest.mock('../../services/storageService', () => ({
  getSignedUploadUrl: jest.fn(),
  getSignedReadUrl: jest.fn(),
}));

const bulkRepo = require('../../repositories/bulkRepository');
const { getAllProducts, getProductById } = require('../productService');
const bulkService = require('../bulkService');

// One grouped product: PVC Pipe, sold in three sizes.
const PIPE = {
  id: 'GROUP-1',
  name: 'PVC Pipe',
  category: 'Plumbing',
  unit: 'Pcs',
  hasVariants: true,
  appVisible: true,
  bulkVisible: true,
  gst_percentage: 18,
  variants: [
    { id: 'ITEM-19', name: '3/4 inch (19mm)', price: 5, available_stock: 100 },
    { id: 'ITEM-25', name: '1 inch (25 mm)', price: 90, available_stock: 100 },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  bulkRepo.listCategoryOverlays.mockResolvedValue([
    { id: 'plumbing', bulkEnabled: true, minOrderValue: 0, active: true, sortOrder: 1 },
  ]);
  getAllProducts.mockResolvedValue([PIPE]);
  getProductById.mockImplementation(async id => (id === PIPE.id ? PIPE : null));
});

describe('createQuoteRequest', () => {
  it('names the product and the size on every line', async () => {
    const quote = await bulkService.createQuoteRequest({
      userId: 'U1',
      source: 'cart',
      items: [{ productId: 'GROUP-1', variantId: 'ITEM-25', quantity: 1000 }],
    });

    expect(quote.items[0]).toMatchObject({
      name: 'PVC Pipe — 1 inch (25 mm)',
      productName: 'PVC Pipe',
      variantName: '1 inch (25 mm)',
      variantId: 'ITEM-25',
    });
  });

  it('leaves a product without variants named as itself', async () => {
    const cement = {
      id: 'ITEM-C', name: 'UltraTech OPC 53', category: 'Plumbing', unit: 'bag',
      hasVariants: false, appVisible: true, price: 400, gst_percentage: 28,
    };
    getAllProducts.mockResolvedValue([cement]);
    getProductById.mockResolvedValue(cement);

    const quote = await bulkService.createQuoteRequest({
      userId: 'U1', source: 'cart',
      items: [{ productId: 'ITEM-C', quantity: 10 }],
    });

    expect(quote.items[0]).toMatchObject({
      name: 'UltraTech OPC 53',
      productName: 'UltraTech OPC 53',
      variantName: null,
    });
  });
});

describe('hydrateItemNames', () => {
  it('repairs a line saved before product names were stored', async () => {
    const repaired = await bulkService.hydrateItemNames({
      items: [{ productId: 'GROUP-1', variantId: 'ITEM-19', zohoItemId: 'ITEM-19', name: '3/4 inch (19mm)' }],
    });

    expect(repaired.items[0]).toMatchObject({
      name: 'PVC Pipe — 3/4 inch (19mm)',
      productName: 'PVC Pipe',
      variantName: '3/4 inch (19mm)',
    });
  });

  it('keeps a description ops typed by hand', async () => {
    const repaired = await bulkService.hydrateItemNames({
      items: [{ productId: 'GROUP-1', variantId: 'ITEM-19', name: 'Pipe offcuts, site rate' }],
    });

    expect(repaired.items[0].name).toBe('Pipe offcuts, site rate');
    expect(repaired.items[0].productName).toBe('PVC Pipe');
  });

  it('costs nothing when the lines already name their product', async () => {
    const quote = { items: [{ productId: 'GROUP-1', productName: 'PVC Pipe', name: 'PVC Pipe — 1 inch (25 mm)' }] };
    const out = await bulkService.hydrateItemNames(quote);

    expect(out).toBe(quote);
    expect(getProductById).not.toHaveBeenCalled();
  });
});

describe('publishQuote', () => {
  it('keeps the size the customer chose on the priced line', async () => {
    bulkRepo.getQuote.mockResolvedValue({ id: 'QT-1', status: 'requested', items: [] });

    await bulkService.publishQuote('QT-1', {
      items: [{
        productId: 'GROUP-1', variantId: 'ITEM-25', zohoItemId: 'ITEM-25',
        productName: 'PVC Pipe', variantName: '1 inch (25 mm)',
        name: 'PVC Pipe — 1 inch (25 mm)', quantity: 1000, unit: 'Pcs', unitPrice: 90, gstRate: 18,
      }],
      deliveryCharge: 1000,
    });

    const saved = bulkRepo.updateQuote.mock.calls[0][1];
    expect(saved.items[0]).toMatchObject({
      name: 'PVC Pipe — 1 inch (25 mm)',
      productName: 'PVC Pipe',
      variantName: '1 inch (25 mm)',
      variantId: 'ITEM-25',
      zohoItemId: 'ITEM-25',
    });
  });

  it('repairs a row the console seeded from an older quote', async () => {
    bulkRepo.getQuote.mockResolvedValue({ id: 'QT-2', status: 'requested', items: [] });

    await bulkService.publishQuote('QT-2', {
      items: [{
        productId: 'GROUP-1', variantId: 'ITEM-25', zohoItemId: 'ITEM-25',
        name: '1 inch (25 mm)', quantity: 10, unit: 'Pcs', unitPrice: 90, gstRate: 18,
      }],
      deliveryCharge: 0,
    });

    const saved = bulkRepo.updateQuote.mock.calls[0][1];
    expect(saved.items[0].name).toBe('PVC Pipe — 1 inch (25 mm)');
    expect(saved.items[0].productName).toBe('PVC Pipe');
  });
});

describe('toQuoteDTO', () => {
  it('sends both halves of the name to the app', () => {
    const dto = bulkService.toQuoteDTO({
      id: 'QT-3', status: 'quoted',
      items: [{
        name: 'PVC Pipe — 1 inch (25 mm)', productName: 'PVC Pipe', variantName: '1 inch (25 mm)',
        variantId: 'ITEM-25', quantity: 1000, unit: 'Pcs', unitPrice: 90, packLabel: 'Pcs',
      }],
    });

    expect(dto.items[0]).toMatchObject({
      name: 'PVC Pipe — 1 inch (25 mm)',
      productName: 'PVC Pipe',
      variantName: '1 inch (25 mm)',
      variantId: 'ITEM-25',
    });
  });

  it('sends null rather than an empty string for an unvaried line', () => {
    const dto = bulkService.toQuoteDTO({
      id: 'QT-4', status: 'quoted',
      items: [{ name: 'UltraTech OPC 53', productName: 'UltraTech OPC 53', variantName: null, quantity: 10 }],
    });

    expect(dto.items[0].variantName).toBeNull();
  });
});
