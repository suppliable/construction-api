'use strict';

const { isAppVisible, isWalkinOnly } = require('../appVisibility');

describe('isAppVisible (opt-out via cf_walkin)', () => {
  test('visible when the field is absent (all existing products default to app-listed)', () => {
    expect(isAppVisible({})).toBe(true);
    expect(isAppVisible({ custom_field_hash: {} })).toBe(true);
    expect(isAppVisible(undefined)).toBe(true);
  });

  test('visible for unchecked / falsey values', () => {
    expect(isAppVisible({ cf_walkin: false })).toBe(true);
    expect(isAppVisible({ cf_walkin: 'false' })).toBe(true);
    expect(isAppVisible({ cf_walkin: '' })).toBe(true);
    expect(isAppVisible({ custom_field_hash: { cf_walkin: false } })).toBe(true);
  });

  test('hidden only when the walk-in box is checked', () => {
    expect(isAppVisible({ cf_walkin: true })).toBe(false);
    expect(isAppVisible({ cf_walkin: 'true' })).toBe(false);
    expect(isAppVisible({ custom_field_hash: { cf_walkin: true } })).toBe(false);
    expect(isAppVisible({ custom_field_hash: { cf_walkin: 'true' } })).toBe(false);
  });

  test('raw field takes precedence over custom_field_hash', () => {
    expect(isAppVisible({ cf_walkin: true, custom_field_hash: { cf_walkin: false } })).toBe(false);
    expect(isAppVisible({ cf_walkin: false, custom_field_hash: { cf_walkin: true } })).toBe(true);
  });

  test('isWalkinOnly is the inverse of isAppVisible', () => {
    expect(isWalkinOnly({ cf_walkin: true })).toBe(true);
    expect(isWalkinOnly({})).toBe(false);
  });
});
