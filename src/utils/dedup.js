const crypto = require('crypto');

function hashSha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value), 'utf8')
    .digest('hex');
}

function normalizeCallDateTimeForKey(callDateTime) {
  if (typeof callDateTime !== 'string' || callDateTime.trim() === '') {
    return '';
  }

  const trimmed = callDateTime.trim();
  const parsed = Date.parse(trimmed);

  if (Number.isNaN(parsed)) {
    return trimmed;
  }

  return new Date(parsed).toISOString();
}

function buildTranscriptHash(transcript) {
  const normalizedTranscript = typeof transcript === 'string' ? transcript.trim() : '';
  return hashSha256(normalizedTranscript);
}

function buildDedupKey({ phone, callDateTime, transcriptHash }) {
  const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
  const normalizedCallDateTime = normalizeCallDateTimeForKey(callDateTime);
  const normalizedTranscriptHash = typeof transcriptHash === 'string' ? transcriptHash.trim() : '';

  return hashSha256(`${normalizedPhone}|${normalizedCallDateTime}|${normalizedTranscriptHash}`);
}

module.exports = {
  buildTranscriptHash,
  buildDedupKey,
  normalizeCallDateTimeForKey
};
