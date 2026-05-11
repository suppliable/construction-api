'use strict';

/**
 * Compare two semver strings (major.minor.patch).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareVersions(a, b) {
  const parse = v => {
    const parts = String(v).split('.');
    return [0, 1, 2].map(i => parseInt(parts[i], 10) || 0);
  };
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

module.exports = { compareVersions };
