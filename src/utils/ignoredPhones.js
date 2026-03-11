function normalizePhone(phone) {
  if (typeof phone !== 'string') {
    return '';
  }

  return phone.trim();
}

function parseIgnoredPhones(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return [];
  }

  return rawValue
    .split(',')
    .map((phone) => normalizePhone(phone))
    .filter(Boolean);
}

function isIgnoredPhone(phone, ignoredPhones) {
  const normalizedPhone = normalizePhone(phone);
  return ignoredPhones.includes(normalizedPhone);
}

module.exports = {
  normalizePhone,
  parseIgnoredPhones,
  isIgnoredPhone
};
