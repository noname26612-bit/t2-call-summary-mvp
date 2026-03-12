function normalizePhone(phone) {
  if (typeof phone !== 'string') {
    return '';
  }

  const trimmed = phone.trim();
  if (trimmed === '') {
    return '';
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) {
    return trimmed;
  }

  if (digits.length === 10) {
    return `+7${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('8')) {
    return `+7${digits.slice(1)}`;
  }

  if (digits.length === 11 && digits.startsWith('7')) {
    return `+${digits}`;
  }

  if (trimmed.startsWith('+')) {
    return `+${digits}`;
  }

  if (digits.length === 11) {
    return `+${digits}`;
  }

  return trimmed;
}

function parseIgnoredPhones(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return [];
  }

  return [...new Set(
    rawValue
      .split(',')
      .map((phone) => normalizePhone(phone))
      .filter(Boolean)
  )];
}

function isIgnoredPhone(phone, ignoredPhones) {
  const normalizedPhone = normalizePhone(phone);

  if (!Array.isArray(ignoredPhones)) {
    return false;
  }

  return ignoredPhones.includes(normalizedPhone);
}

module.exports = {
  normalizePhone,
  parseIgnoredPhones,
  isIgnoredPhone
};
