'use strict';

const { normalizePhone, isValidIndianMobile } = require('../phone');

describe('normalizePhone', () => {
  test('normalizes a plain 10-digit number', () => {
    expect(normalizePhone('9876543210')).toBe('+919876543210');
  });

  test('strips +91 prefix and re-adds it', () => {
    expect(normalizePhone('+919876543210')).toBe('+919876543210');
  });

  test('strips 091 prefix', () => {
    expect(normalizePhone('0919876543210')).toBe('+919876543210');
  });

  test('normalizes a 12-digit number with 91 prefix', () => {
    expect(normalizePhone('919876543210')).toBe('+919876543210');
  });

  test('returns null for a non-mobile first digit (e.g. starting with 5)', () => {
    expect(normalizePhone('5123456789')).toBeNull();
  });

  test('returns null for an 8-digit number', () => {
    expect(normalizePhone('98765432')).toBeNull();
  });

  test('returns null for an 11-digit number', () => {
    expect(normalizePhone('98765432101')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(normalizePhone('')).toBeNull();
  });

  test('returns null for non-numeric input', () => {
    expect(normalizePhone('abc')).toBeNull();
  });

  test('strips non-digit characters before normalizing', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('+919876543210');
  });
});

describe('isValidIndianMobile', () => {
  test('returns true for a valid 10-digit mobile', () => {
    expect(isValidIndianMobile('9876543210')).toBe(true);
  });

  test('returns true for +91 prefixed number', () => {
    expect(isValidIndianMobile('+919876543210')).toBe(true);
  });

  test('returns false for a landline-style number (starts with 1)', () => {
    expect(isValidIndianMobile('1234567890')).toBe(false);
  });

  test('returns false for too-short number', () => {
    expect(isValidIndianMobile('98765')).toBe(false);
  });

  test('returns false for empty input', () => {
    expect(isValidIndianMobile('')).toBe(false);
  });
});
