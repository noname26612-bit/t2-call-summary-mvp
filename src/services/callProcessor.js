const { normalizePhone } = require('../utils/ignoredPhones');
const { buildTranscriptHash, buildDedupKey } = require('../utils/dedup');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateCallPayload(payload) {
  const errors = [];

  if (!isNonEmptyString(payload.phone)) {
    errors.push({
      field: 'phone',
      message: 'phone is required and must be a non-empty string'
    });
  }

  if (!isNonEmptyString(payload.callDateTime)) {
    errors.push({
      field: 'callDateTime',
      message: 'callDateTime is required and must be a non-empty string'
    });
  }

  if (!isNonEmptyString(payload.transcript)) {
    errors.push({
      field: 'transcript',
      message: 'transcript is required and must be a non-empty string'
    });
  }

  return errors;
}

function getHistorySource(value) {
  if (!isNonEmptyString(value)) {
    return 'unknown';
  }

  return value.trim();
}

function buildTranscriptPreview(transcript) {
  return transcript.trim().slice(0, 240);
}

function sanitizeErrorForAudit(error) {
  if (!(error instanceof Error)) {
    return {
      message: 'Unknown error'
    };
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code,
    statusCode: error.statusCode
  };
}

function createCallProcessor({ storage, analyzeCall, sendTelegramMessage, logger }) {
  async function appendAuditSafely(payload) {
    try {
      await storage.appendAuditEvent(payload);
    } catch (error) {
      logger.warn('audit_event_write_failed', {
        error,
        callEventId: payload?.callEventId,
        eventType: payload?.eventType
      });
    }
  }

  async function processCall(payload, options = {}) {
    const phoneRaw = payload.phone.trim();
    const phone = normalizePhone(phoneRaw);
    const callDateTime = payload.callDateTime.trim();
    const transcript = payload.transcript.trim();
    const requestId = isNonEmptyString(options.requestId) ? options.requestId.trim() : '';
    const source = getHistorySource(options.source);
    const transcriptHash = buildTranscriptHash(transcript);
    const dedupKey = buildDedupKey({
      phone,
      callDateTime,
      transcriptHash
    });

    const callEvent = await storage.createCallEvent({
      source,
      phoneRaw,
      phoneNormalized: phone,
      callDateTimeRaw: callDateTime,
      transcriptHash,
      transcriptPreview: buildTranscriptPreview(transcript),
      transcriptLength: transcript.length,
      dedupKey
    });

    const callEventId = callEvent.id;

    await appendAuditSafely({
      callEventId,
      eventType: 'call_received',
      payload: {
        source,
        dedupKey
      }
    });

    if (await storage.isPhoneIgnored(phone)) {
      const response = {
        status: 'ignored',
        reason: 'internal_phone',
        phone,
        callDateTime
      };

      await storage.updateCallEventStatus({
        callEventId,
        status: 'ignored',
        reason: response.reason
      });

      await appendAuditSafely({
        callEventId,
        eventType: 'call_ignored',
        payload: {
          reason: response.reason
        }
      });

      return response;
    }

    const dedupLock = await storage.acquireDedupKey({
      dedupKey,
      callEventId,
      phoneNormalized: phone,
      callDateTimeRaw: callDateTime
    });

    if (!dedupLock.acquired) {
      const response = {
        status: 'duplicate',
        reason: 'already_processed',
        phone,
        callDateTime
      };

      await storage.updateCallEventStatus({
        callEventId,
        status: 'duplicate',
        reason: response.reason
      });

      await appendAuditSafely({
        callEventId,
        eventType: 'call_duplicate',
        payload: {
          reason: response.reason,
          dedupPreviousStatus: dedupLock.previousStatus
        }
      });

      return response;
    }

    try {
      const analysis = await analyzeCall({
        requestId,
        phone,
        callDateTime,
        transcript
      });

      await storage.saveSummary({
        callEventId,
        analysis
      });

      await appendAuditSafely({
        callEventId,
        eventType: 'analysis_completed',
        payload: {
          category: analysis.category,
          urgency: analysis.urgency,
          confidence: analysis.confidence
        }
      });

      const telegramResult = await sendTelegramMessage({
        phone,
        callDateTime,
        analysis
      });

      await storage.saveTelegramDelivery({
        callEventId,
        status: telegramResult.status,
        httpStatus: telegramResult.httpStatus || null,
        errorCode: telegramResult.errorCode || null,
        errorMessage: telegramResult.errorMessage || null,
        responsePayload: telegramResult.responsePayload || null
      });

      await appendAuditSafely({
        callEventId,
        eventType: 'telegram_delivery',
        payload: {
          status: telegramResult.status,
          errorCode: telegramResult.errorCode || null,
          httpStatus: telegramResult.httpStatus || null
        }
      });

      await storage.completeDedupKey({
        dedupKey,
        status: 'processed',
        callEventId
      });

      await storage.updateCallEventStatus({
        callEventId,
        status: 'processed',
        telegramStatus: telegramResult.status
      });

      await appendAuditSafely({
        callEventId,
        eventType: 'call_processed',
        payload: {
          telegramStatus: telegramResult.status
        }
      });

      return {
        status: 'processed',
        phone,
        callDateTime,
        analysis,
        telegram: {
          status: telegramResult.status
        }
      };
    } catch (error) {
      await storage.completeDedupKey({
        dedupKey,
        status: 'failed',
        callEventId
      });

      await storage.updateCallEventStatus({
        callEventId,
        status: 'failed',
        reason: 'processing_error'
      });

      await appendAuditSafely({
        callEventId,
        eventType: 'call_failed',
        payload: sanitizeErrorForAudit(error)
      });

      throw error;
    }
  }

  return {
    validateCallPayload,
    processCall
  };
}

module.exports = {
  createCallProcessor,
  validateCallPayload
};
