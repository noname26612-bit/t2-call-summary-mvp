const { openaiAnalyzeCall } = require('./openaiAnalyzeCall');
const { sendTelegramMessage } = require('./sendTelegramMessage');
const { hasProcessedCall, saveProcessedCall } = require('./processedCallsStore');
const { appendCallHistory } = require('./callHistoryStore');
const { normalizePhone, parseIgnoredPhones, isIgnoredPhone } = require('../utils/ignoredPhones');

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
  return transcript.trim().slice(0, 200);
}

function buildHistoryRecord({ response, source, transcript }) {
  const historyRecord = {
    status: response.status,
    phone: response.phone,
    callDateTime: response.callDateTime,
    createdAt: new Date().toISOString(),
    source,
    transcriptPreview: buildTranscriptPreview(transcript)
  };

  if (isNonEmptyString(response.reason)) {
    historyRecord.reason = response.reason.trim();
  }

  if (
    response.status === 'processed'
    && response.analysis
    && typeof response.analysis === 'object'
    && !Array.isArray(response.analysis)
  ) {
    historyRecord.analysis = response.analysis;
  }

  if (isNonEmptyString(response?.telegram?.status)) {
    historyRecord.telegramStatus = response.telegram.status.trim();
  }

  return historyRecord;
}

async function appendHistorySafely(response, source, transcript) {
  const historyRecord = buildHistoryRecord({ response, source, transcript });

  try {
    await appendCallHistory(historyRecord);
  } catch (error) {
    console.error(`Call history append failed: ${error.message}`);
  }
}

async function processCall(payload, ignoredPhonesRawValue, options = {}) {
  const phone = normalizePhone(payload.phone);
  const callDateTime = payload.callDateTime.trim();
  const transcript = payload.transcript.trim();
  const ignoredPhones = parseIgnoredPhones(ignoredPhonesRawValue);
  const source = getHistorySource(options.source);

  if (isIgnoredPhone(phone, ignoredPhones)) {
    const response = {
      status: 'ignored',
      reason: 'internal_phone',
      phone,
      callDateTime
    };

    await appendHistorySafely(response, source, transcript);
    return response;
  }

  const alreadyProcessed = await hasProcessedCall({
    phone,
    callDateTime,
    transcript
  });

  if (alreadyProcessed) {
    const response = {
      status: 'duplicate',
      reason: 'already_processed',
      phone,
      callDateTime
    };

    await appendHistorySafely(response, source, transcript);
    return response;
  }

  const analysis = await openaiAnalyzeCall(transcript);
  const telegram = await sendTelegramMessage({
    phone,
    callDateTime,
    analysis
  });
  await saveProcessedCall({
    phone,
    callDateTime,
    transcript
  });

  const response = {
    status: 'processed',
    phone,
    callDateTime,
    analysis,
    telegram
  };

  await appendHistorySafely(response, source, transcript);
  return response;
}

module.exports = {
  validateCallPayload,
  processCall
};
