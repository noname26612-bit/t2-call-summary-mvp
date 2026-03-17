const { normalizePhone } = require('../utils/ignoredPhones');
const { buildTranscriptHash, buildDedupKey } = require('../utils/dedup');
const {
  normalizeCallType,
  resolveEmployeePhoneFromCallMeta
} = require('../utils/callParticipants');

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

function normalizeOptionalPhone(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return normalizePhone(value.trim());
}

function resolveOptionalCallMeta(payload = {}) {
  return {
    callType: normalizeCallType(payload.callType),
    callerNumber: normalizeOptionalPhone(payload.callerNumber),
    calleeNumber: normalizeOptionalPhone(payload.calleeNumber),
    destinationNumber: normalizeOptionalPhone(payload.destinationNumber)
  };
}

function normalizeEmployeeRecord(rawEmployee) {
  if (!rawEmployee || typeof rawEmployee !== 'object' || Array.isArray(rawEmployee)) {
    return null;
  }

  const employeeName = isNonEmptyString(rawEmployee.employeeName) ? rawEmployee.employeeName.trim() : '';
  const employeeTitle = isNonEmptyString(rawEmployee.employeeTitle) ? rawEmployee.employeeTitle.trim() : '';
  const phoneNormalized = isNonEmptyString(rawEmployee.phoneNormalized)
    ? normalizePhone(rawEmployee.phoneNormalized.trim())
    : '';
  const id = Number.isSafeInteger(rawEmployee.id) ? rawEmployee.id : null;

  if (!employeeName || !employeeTitle || !phoneNormalized) {
    return null;
  }

  return {
    id,
    phoneNormalized,
    employeeName,
    employeeTitle
  };
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
    const callMeta = resolveOptionalCallMeta(payload);
    const employeePhone = callMeta.callType
      ? normalizeOptionalPhone(resolveEmployeePhoneFromCallMeta(callMeta))
      : '';
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
      transcriptText: transcript,
      transcriptLength: transcript.length,
      dedupKey
    });

    const callEventId = callEvent.id;
    let employee = null;

    if (employeePhone && typeof storage.findActiveEmployeeByPhone === 'function') {
      try {
        employee = normalizeEmployeeRecord(
          await storage.findActiveEmployeeByPhone(employeePhone)
        );
      } catch (error) {
        logger.warn('employee_directory_lookup_failed', {
          callEventId,
          employeePhone,
          error
        });
      }
    }

    await appendAuditSafely({
      callEventId,
      eventType: 'call_received',
      payload: {
        source,
        dedupKey,
        callType: callMeta.callType,
        employeePhone,
        employeeId: employee?.id || null
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
        transcript,
        callType: callMeta.callType,
        callerNumber: callMeta.callerNumber,
        calleeNumber: callMeta.calleeNumber,
        destinationNumber: callMeta.destinationNumber,
        employee
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
        callEventId,
        phone,
        callDateTime,
        analysis,
        employee,
        ...callMeta
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
