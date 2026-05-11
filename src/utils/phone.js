function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return '+91' + digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) return '+91' + digits.slice(3);
  return null;
}

function isValidIndianMobile(raw) {
  return normalizePhone(raw) !== null;
}

module.exports = { normalizePhone, isValidIndianMobile };
