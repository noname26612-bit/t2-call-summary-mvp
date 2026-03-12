const { normalizeIncomingCallPayload } = require('./t2Mapper');

function createT2IngestService({ processCall }) {
  async function ingestT2Call(rawPayload, options = {}) {
    const normalized = normalizeIncomingCallPayload(rawPayload);

    if (!normalized.isValid) {
      return {
        status: 'invalid_t2_payload',
        errors: normalized.errors
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
