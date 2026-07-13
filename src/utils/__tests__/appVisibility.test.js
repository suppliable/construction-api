'use strict';

const { isAppVisible } = require('../appVisibility');

describe('isAppVisible (opt-out)', () => {
  test('visible when the field is absent', () => {
    expect(isAppVisible({})).toBe(true);
    expect(isAppVisible({ custom_field_hash: {} })).toBe(true);
    expect(isAppVisible(undefined)).toBe(true);
  });

  test('visible for truthy / non-false values', () => {
    expect(isAppVisible({ cf_app_visible: true })).toBe(true);
    expect(isAppVisible({ cf_app_visible: 'true' })).toBe(true);
    expect(isAppVisible({ cf_app_visible: '' })).toBe(true);
    expect(isAppVisible({ custom_field_hash: { cf_app_visible: true } })).toBe(true);
  });

  test('hidden only when explicitly false', () => {
    expect(isAppVisible({ cf_app_visible: false })).toBe(false);
    expect(isAppVisible({ cf_app_visible: 'false' })).toBe(false);
    expect(isAppVisible({ custom_field_hash: { cf_app_visible: false } })).toBe(false);
    expect(isAppVisible({ custom_field_hash: { cf_app_visible: 'false' } })).toBe(false);
  });

  test('raw field takes precedence over custom_field_hash', () => {
    expect(isAppVisible({ cf_app_visible: false, custom_field_hash: { cf_app_visible: true } })).toBe(false);
    expect(isAppVisible({ cf_app_visible: true, custom_field_hash: { cf_app_visible: false } })).toBe(true);
  });
});
