'use strict';

const { calculateGST, calculateOrderGST, calculateItemPrice } = require('../gstCalculator');

describe('calculateGST', () => {
  test('correctly splits 18% GST from an inclusive price', () => {
    const result = calculateGST(118, 18);
    expect(result.selling_price).toBe(118);
    expect(result.base_price).toBe(100);
    expect(result.gst_percentage).toBe(18);
    expect(result.gst_amount).toBe(18);
  });

  test('correctly splits 5% GST', () => {
    const result = calculateGST(105, 5);
    expect(result.selling_price).toBe(105);
    expect(result.base_price).toBeCloseTo(100, 1);
    expect(result.gst_amount).toBeCloseTo(5, 1);
  });

  test('returns 0 GST amount when rate is 0', () => {
    const result = calculateGST(200, 0);
    expect(result.base_price).toBe(200);
    expect(result.gst_amount).toBe(0);
  });

  test('rounds to 2 decimal places', () => {
    const result = calculateGST(100, 18);
    expect(result.base_price).toBe(84.75);
    expect(result.gst_amount).toBe(15.25);
  });
});

describe('calculateOrderGST', () => {
  test('aggregates GST across multiple items', () => {
    const items = [
      { selling_price: 118, gst_percentage: 18, quantity: 2 },
      { selling_price: 105, gst_percentage: 5, quantity: 1 },
    ];
    const result = calculateOrderGST(items);
    expect(result.items).toHaveLength(2);
    expect(result.subtotal).toBeCloseTo(341, 0);
    expect(result.total_gst).toBeGreaterThan(0);
    expect(result.final_total).toBe(result.subtotal);
  });

  test('returns zero totals for empty items array', () => {
    const result = calculateOrderGST([]);
    expect(result.subtotal).toBe(0);
    expect(result.total_gst).toBe(0);
  });
});

describe('calculateItemPrice', () => {
  test('computes subtotal, GST amount, and total with GST', () => {
    const product = { selling_price: 100, gst_percentage: 18 };
    const result = calculateItemPrice(product, 2);
    expect(result.subtotal).toBe(200);
    expect(result.gstAmount).toBe(36);
    expect(result.totalWithGST).toBe(236);
  });

  test('handles quantity of 1', () => {
    const product = { selling_price: 50, gst_percentage: 12 };
    const result = calculateItemPrice(product, 1);
    expect(result.subtotal).toBe(50);
    expect(result.gstAmount).toBe(6);
    expect(result.totalWithGST).toBe(56);
  });
});
