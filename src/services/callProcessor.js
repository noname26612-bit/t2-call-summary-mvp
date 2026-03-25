const { normalizePhone } = require('../utils/ignoredPhones');
const { buildTranscriptHash, buildDedupKey, buildCallIdDedupKey } = require('../utils/dedup');
const {
  normalizeCallType,
  resolveEmployeePhoneFromCallMeta
} = require('../utils/callParticipants');

const DEFAULT_ANALYZE_MIN_TRANSCRIPT_CHARS = 16;

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

const ANALYZE_SKIP_REASONS = Object.freeze({
  INTERNAL_OR_IGNORED_PHONE: 'skipped_before_analyze:internal_or_ignored_phone',
  DUPLICATE_CALL_SKIP: 'skipped_before_analyze:duplicate_call_skip',
  EMPTY_TRANSCRIPT_SKIP: 'skipped_before_analyze:empty_transcript_skip',
  LOW_SIGNAL_TRANSCRIPT_SKIP: 'skipped_before_analyze:low_signal_transcript_skip'
});

const LOW_SIGNAL_WORDS = new Set([
  'алло',
  'ало',
  'да',
  'угу',
  'ага',
  'мм',
  'мг',
  'ok',
  'okay',
  'хорошо',
  'понял',
  'поняла',
  'спасибо',
  'пока',
  'до',
  'свидания'
]);

const BUSINESS_WORD_PREFIXES = [
  'аренд',
  'прокат',
  'ремонт',
  'сервис',
  'запчаст',
  'достав',
  'заказ',
  'цен',
  'стоим',
  'коммерч',
  'кп',
  'договор',
  'счет',
  'оплат',
  'клиент',
  'техник',
  'погруз',
  'экскават',
  'трактор',
  'номер',
  'детал',
  'масл',
  'фильтр',
  'подшип'
];

const NO_SPEECH_PATTERNS = [
  /^нет речи$/,
  /^без речи$/,
  /^тишина$/,
  /^шум$/,
  /^молчание$/,
  /^фон$/,
  /^no speech$/,
  /^silence$/,
  /^noise$/,
  /^silence only$/,
  /^music$/,
  /^beep(?:s)?$/,
  /^tone(?:s)?$/,
  /^гудки$/,
  /^сброс$/
];

const SERVICE_PHRASE_PATTERNS = [
  /абонент.*(не отвечает|недоступен|временно недоступен)/,
  /оставьте.*(сообщени|после сигнала)/,
  /(автоответчик|голосова[яй] почт)/,
  /номер.*(не обслуживает|не существует|неправильно набран)/,
  /перезвоните позже/,
  /телефон выключен/
];

function normalizeTranscriptTextForGate(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTranscriptWords(value) {
  if (!isNonEmptyString(value)) {
    return [];
  }

  return value.match(/[a-zа-яё0-9]+/gi) || [];
}

function hasBusinessSignal(words) {
  return words.some((word) => BUSINESS_WORD_PREFIXES.some((prefix) => word.startsWith(prefix)));
}

function normalizeAnalyzeMinTranscriptChars(value) {
  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  return DEFAULT_ANALYZE_MIN_TRANSCRIPT_CHARS;
}

function evaluateAnalyzeSkipGate(transcript, options = {}) {
  const minTranscriptChars = normalizeAnalyzeMinTranscriptChars(options.minTranscriptChars);
  const normalized = normalizeTranscriptTextForGate(transcript);
  if (!normalized) {
    return {
      shouldSkip: true,
      reason: ANALYZE_SKIP_REASONS.EMPTY_TRANSCRIPT_SKIP,
      details: {
        transcriptLength: 0,
        minTranscriptChars
      }
    };
  }

  if (normalized.length < minTranscriptChars) {
    return {
      shouldSkip: true,
      reason: ANALYZE_SKIP_REASONS.LOW_SIGNAL_TRANSCRIPT_SKIP,
      details: {
        signalType: 'min_chars_threshold',
        transcriptLength: normalized.length,
        minTranscriptChars
      }
    };
  }

  if (NO_SPEECH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      shouldSkip: true,
      reason: ANALYZE_SKIP_REASONS.LOW_SIGNAL_TRANSCRIPT_SKIP,
      details: {
        signalType: 'no_speech_or_noise',
        normalizedTranscript: normalized,
        transcriptLength: normalized.length,
        minTranscriptChars
      }
    };
  }

  if (SERVICE_PHRASE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      shouldSkip: true,
      reason: ANALYZE_SKIP_REASONS.LOW_SIGNAL_TRANSCRIPT_SKIP,
      details: {
        signalType: 'service_phrase_only',
        normalizedTranscript: normalized,
        transcriptLength: normalized.length,
        minTranscriptChars
      }
    };
  }

  const words = tokenizeTranscriptWords(normalized);
  const meaningfulWords = words.filter((word) => word.length > 1 && !LOW_SIGNAL_WORDS.has(word));
  const singleCharWordCount = words.filter((word) => word.length <= 1).length;
  const singleCharWordRatio = words.length > 0 ? singleCharWordCount / words.length : 0;
  const businessSignalDetected = hasBusinessSignal(words);

  if (!businessSignalDetected && meaningfulWords.length <= 2 && normalized.length <= 80) {
    return {
      shouldSkip: true,
      reason: ANALYZE_SKIP_REASONS.LOW_SIGNAL_TRANSCRIPT_SKIP,
      details: {
        signalType: 'low_informative_content',
        transcriptLength: normalized.length,
        wordsCount: words.length,
        meaningfulWordsCount: meaningfulWords.length,
        businessSignalDetected,
        minTranscriptChars
      }
    };
  }

  if (!businessSignalDetected && words.length >= 4 && singleCharWordRatio >= 0.75) {
    return {
      shouldSkip: true,
      reason: ANALYZE_SKIP_REASONS.LOW_SIGNAL_TRANSCRIPT_SKIP,
      details: {
        signalType: 'low_transcript_quality',
        transcriptLength: normalized.length,
        wordsCount: words.length,
        singleCharWordRatio: Number(singleCharWordRatio.toFixed(3)),
        businessSignalDetected,
        minTranscriptChars
      }
    };
  }

  return {
    shouldSkip: false,
    reason: '',
    details: {
      transcriptLength: normalized.length,
      wordsCount: words.length,
      meaningfulWordsCount: meaningfulWords.length,
      businessSignalDetected,
      minTranscriptChars
    }
  };
}

function normalizeNonNegativeInteger(value, fallback = null) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}

function normalizePositiveInteger(value, fallback = null) {
  const normalized = normalizeNonNegativeInteger(value, fallback);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return fallback;
  }

  return normalized;
}

function normalizeEstimatedCostRub(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Number(value.toFixed(6));
  }

  if (typeof value === 'string' && /^[0-9]+([.,][0-9]+)?$/.test(value.trim())) {
    const parsed = Number.parseFloat(value.trim().replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Number(parsed.toFixed(6));
    }
  }

  return null;
}

function normalizeAiUsagePayload(rawUsage = {}, fallback = {}) {
  const source = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : {};

  const xRequestId = isNonEmptyString(source.xRequestId)
    ? source.xRequestId.trim()
    : (isNonEmptyString(fallbackSource.xRequestId) ? fallbackSource.xRequestId.trim() : '');

  const operation = isNonEmptyString(source.operation)
    ? source.operation.trim()
    : (isNonEmptyString(fallbackSource.operation) ? fallbackSource.operation.trim() : 'analyze');

  const model = isNonEmptyString(source.model)
    ? source.model.trim()
    : (isNonEmptyString(fallbackSource.model) ? fallbackSource.model.trim() : '');

  const provider = isNonEmptyString(source.provider)
    ? source.provider.trim()
    : (isNonEmptyString(fallbackSource.provider) ? fallbackSource.provider.trim() : '');

  const responseStatus = isNonEmptyString(source.responseStatus)
    ? source.responseStatus.trim()
    : (isNonEmptyString(fallbackSource.responseStatus) ? fallbackSource.responseStatus.trim() : 'failed');

  const skipReason = isNonEmptyString(source.skipReason)
    ? source.skipReason.trim()
    : (isNonEmptyString(fallbackSource.skipReason) ? fallbackSource.skipReason.trim() : '');

  const createdAt = isNonEmptyString(source.createdAt)
    ? source.createdAt.trim()
    : (isNonEmptyString(fallbackSource.createdAt) ? fallbackSource.createdAt.trim() : '');

  return {
    xRequestId,
    callEventId: normalizePositiveInteger(source.callEventId, normalizePositiveInteger(fallbackSource.callEventId, null)),
    callId: isNonEmptyString(source.callId)
      ? source.callId.trim().slice(0, 256)
      : (isNonEmptyString(fallbackSource.callId) ? fallbackSource.callId.trim().slice(0, 256) : ''),
    operation,
    model,
    provider,
    promptTokens: normalizeNonNegativeInteger(
      source.promptTokens,
      normalizeNonNegativeInteger(fallbackSource.promptTokens, null)
    ),
    completionTokens: normalizeNonNegativeInteger(
      source.completionTokens,
      normalizeNonNegativeInteger(fallbackSource.completionTokens, null)
    ),
    totalTokens: normalizeNonNegativeInteger(
      source.totalTokens,
      normalizeNonNegativeInteger(fallbackSource.totalTokens, null)
    ),
    transcriptCharsRaw: normalizeNonNegativeInteger(
      source.transcriptCharsRaw,
      normalizeNonNegativeInteger(fallbackSource.transcriptCharsRaw, null)
    ),
    transcriptCharsSent: normalizeNonNegativeInteger(
      source.transcriptCharsSent,
      normalizeNonNegativeInteger(fallbackSource.transcriptCharsSent, null)
    ),
    durationMs: normalizeNonNegativeInteger(
      source.durationMs,
      normalizeNonNegativeInteger(fallbackSource.durationMs, null)
    ),
    responseStatus,
    skipReason,
    estimatedCostRub: normalizeEstimatedCostRub(source.estimatedCostRub) ?? normalizeEstimatedCostRub(fallbackSource.estimatedCostRub),
    createdAt
  };
}

function createCallProcessor({
  storage,
  analyzeCall,
  sendTelegramMessage,
  logger,
  analyzeMinTranscriptChars = DEFAULT_ANALYZE_MIN_TRANSCRIPT_CHARS
}) {
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

  async function appendAiUsageAuditSafely(payload) {
    if (typeof storage.insertAiUsageAudit !== 'function') {
      return;
    }

    try {
      await storage.insertAiUsageAudit(payload);
    } catch (error) {
      logger.warn('ai_usage_audit_write_failed', {
        error,
        callEventId: payload?.callEventId || null,
        responseStatus: payload?.responseStatus || '',
        operation: payload?.operation || ''
      });
    }
  }

  async function processCall(payload, options = {}) {
    const phoneRaw = payload.phone.trim();
    const phone = normalizePhone(phoneRaw);
    const callDateTime = payload.callDateTime.trim();
    const transcript = payload.transcript.trim();
    const externalCallId = isNonEmptyString(payload.callId) ? payload.callId.trim().slice(0, 256) : '';
    const callMeta = resolveOptionalCallMeta(payload);
    const employeePhone = callMeta.callType
      ? normalizeOptionalPhone(resolveEmployeePhoneFromCallMeta(callMeta))
      : '';
    const requestId = isNonEmptyString(options.requestId) ? options.requestId.trim() : '';
    const source = getHistorySource(options.source);
    const transcriptHash = buildTranscriptHash(transcript);
    const contentBasedDedupKey = buildDedupKey({
      phone,
      callDateTime,
      transcriptHash
    });
    const dedupKey = externalCallId
      ? buildCallIdDedupKey(`${source}|${externalCallId}`)
      : contentBasedDedupKey;
    const dedupKeyType = externalCallId ? 'external_call_id' : 'content_hash';

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
    const callId = externalCallId || dedupKey;
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
        dedupKeyType,
        contentBasedDedupKey,
        externalCallId,
        callType: callMeta.callType,
        employeePhone,
        employeeId: employee?.id || null
      }
    });

    if (await storage.isPhoneIgnored(phone)) {
      const response = {
        status: 'ignored',
        reason: ANALYZE_SKIP_REASONS.INTERNAL_OR_IGNORED_PHONE,
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

      await appendAiUsageAuditSafely({
        xRequestId: requestId,
        callEventId,
        callId,
        operation: 'analyze',
        model: '',
        provider: 'polza',
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        transcriptCharsRaw: transcript.length,
        transcriptCharsSent: 0,
        durationMs: 0,
        responseStatus: 'skipped',
        skipReason: ANALYZE_SKIP_REASONS.INTERNAL_OR_IGNORED_PHONE,
        estimatedCostRub: null
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
        reason: ANALYZE_SKIP_REASONS.DUPLICATE_CALL_SKIP,
        phone,
        callDateTime
      };

      logger.info('cost_guard_dedup_skip', {
        requestId,
        callEventId,
        callId,
        stage: 'before_analyze',
        reason: response.reason,
        dedupKeyType,
        dedupPreviousStatus: dedupLock.previousStatus
      });

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

      await appendAiUsageAuditSafely({
        xRequestId: requestId,
        callEventId,
        callId,
        operation: 'analyze',
        model: '',
        provider: 'polza',
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        transcriptCharsRaw: transcript.length,
        transcriptCharsSent: 0,
        durationMs: 0,
        responseStatus: 'skipped',
        skipReason: ANALYZE_SKIP_REASONS.DUPLICATE_CALL_SKIP,
        estimatedCostRub: null
      });

      return response;
    }

    const analyzeSkipGate = evaluateAnalyzeSkipGate(transcript, {
      minTranscriptChars: analyzeMinTranscriptChars
    });
    if (analyzeSkipGate.shouldSkip) {
      const response = {
        status: 'ignored',
        reason: analyzeSkipGate.reason,
        phone,
        callDateTime
      };

      logger.info('cost_guard_analyze_skip', {
        requestId,
        callEventId,
        callId,
        stage: 'before_analyze',
        reason: analyzeSkipGate.reason,
        transcriptLength: transcript.length,
        minTranscriptCharsConfigured: analyzeMinTranscriptChars
      });

      await storage.completeDedupKey({
        dedupKey,
        status: 'processed',
        callEventId
      });

      await storage.updateCallEventStatus({
        callEventId,
        status: 'ignored',
        reason: analyzeSkipGate.reason
      });

      await appendAuditSafely({
        callEventId,
        eventType: 'call_skipped_before_analyze',
        payload: {
          reason: analyzeSkipGate.reason,
          ...analyzeSkipGate.details
        }
      });

      await appendAiUsageAuditSafely({
        xRequestId: requestId,
        callEventId,
        callId,
        operation: 'analyze',
        model: '',
        provider: 'polza',
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        transcriptCharsRaw: transcript.length,
        transcriptCharsSent: 0,
        durationMs: 0,
        responseStatus: 'skipped',
        skipReason: analyzeSkipGate.reason,
        estimatedCostRub: null
      });

      return response;
    }

    try {
      const analyzeStartedAt = Date.now();
      let analysis;

      try {
        analysis = await analyzeCall({
          requestId,
          callEventId,
          callId,
          phone,
          callDateTime,
          transcript,
          callType: callMeta.callType,
          callerNumber: callMeta.callerNumber,
          calleeNumber: callMeta.calleeNumber,
          destinationNumber: callMeta.destinationNumber,
          employee
        });
      } catch (error) {
        const normalizedFailedUsage = normalizeAiUsagePayload(error?.aiUsage, {
          xRequestId: requestId,
          callEventId,
          callId,
          operation: 'analyze',
          provider: 'polza',
          responseStatus: 'failed',
          transcriptCharsRaw: transcript.length,
          transcriptCharsSent: transcript.length,
          durationMs: Date.now() - analyzeStartedAt
        });

        await appendAiUsageAuditSafely(normalizedFailedUsage);
        throw error;
      }

      const normalizedSuccessUsage = normalizeAiUsagePayload(analysis?.aiUsage, {
        xRequestId: requestId,
        callEventId,
        callId,
        operation: 'analyze',
        provider: 'polza',
        responseStatus: 'success',
        transcriptCharsRaw: transcript.length,
        transcriptCharsSent: transcript.length,
        durationMs: Date.now() - analyzeStartedAt
      });

      await appendAiUsageAuditSafely(normalizedSuccessUsage);

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
        employeePhone,
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
          httpStatus: telegramResult.httpStatus || null,
          recipients: Array.isArray(telegramResult.recipientResults)
            ? telegramResult.recipientResults
            : []
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
