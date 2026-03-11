const { processCall } = require('./callProcessor');
const { normalizeIncomingCallPayload } = require('./t2Mapper');

async function ingestT2Call(rawPayload, ignoredPhonesRawValue) {
  const normalized = normalizeIncomingCallPayload(rawPayload);

  if (!normalized.isValid) {
    return {
      status: 'invalid_t2_payload',
      errors: normalized.errors
    };
  }

  return processCall(normalized.payload, ignoredPhonesRawValue, { source: 't2_ingest' });
}

module.exports = { ingestT2Call };
