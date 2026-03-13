const { validateCallPayload } = require('./callProcessor');
const { normalizeIncomingCallPayload } = require('./t2Mapper');

function maskPhoneLast4(phone) {
  if (typeof phone !== 'string' || phone.trim() === '') {
    return '';
  }

  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4);
}

function createT2IngestService({ processCall, adapterConfig = {}, logger }) {
  async function ingestT2Call(rawPayload, options = {}) {
    const normalized = normalizeIncomingCallPayload(rawPayload, adapterConfig);

    if (!normalized.isValid) {
      logger?.warn('tele2_payload_normalization_failed', {
        requestId: options.requestId,
        errors: normalized.errors,
        adapterMeta: normalized.adapterMeta
      });

      return {
        status: 'invalid_t2_payload',
        errors: normalized.errors,
        adapterMeta: normalized.adapterMeta
      };
    }

    const canonicalValidationErrors = validateCallPayload(normalized.payload);
    if (canonicalValidationErrors.length > 0) {
      logger?.warn('tele2_payload_canonical_validation_failed', {
        requestId: options.requestId,
        errors: canonicalValidationErrors,
        adapterMeta: normalized.adapterMeta
      });

      return {
        status: 'invalid_t2_payload',
        errors: canonicalValidationErrors,
        adapterMeta: normalized.adapterMeta
      };
    }

    if (options.dryRun === true) {
      return {
        status: 'normalized_preview',
        normalized: {
          phoneLast4: maskPhoneLast4(normalized.payload.phone),
          callDateTime: normalized.payload.callDateTime,
          transcriptLength: normalized.payload.transcript.length
        },
        adapterMeta: normalized.adapterMeta
      };
    }

    return processCall(normalized.payload, {
      source: 't2_ingest',
      requestId: options.requestId
    });
  }

  return {
    ingestT2Call
  };
}

module.exports = {
  createT2IngestService
};
