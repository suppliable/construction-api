'use strict';

const { compareVersions } = require('../semver');

describe('compareVersions', () => {
  test('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  test('returns negative when a < b (patch)', () => {
    expect(compareVersions('1.2.2', '1.2.3')).toBeLessThan(0);
  });

  test('returns positive when a > b (patch)', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  test('returns negative when a < b (minor)', () => {
    expect(compareVersions('1.1.9', '1.2.0')).toBeLessThan(0);
  });

  test('returns positive when a > b (minor)', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
  });

  test('returns negative when a < b (major)', () => {
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
  });

  test('returns positive when a > b (major)', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  test('handles missing patch segment (treats as 0)', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  test('handles missing minor and patch segments', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
  });
});
