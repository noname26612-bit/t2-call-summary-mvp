#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createPgPool } = require('../db/createPgPool');
const { createLogger, serializeError } = require('../services/logger');
const { resolveClientPhoneFromCallMeta, normalizeCallType } = require('../utils/callParticipants');
const { normalizePhone } = require('../utils/ignoredPhones');

dotenv.config();

const DEFAULT_T2_BASE_URL = 'https://ats2.t2.ru/crm/openapi';
const DEFAULT_AI_GATEWAY_URL = 'http://127.0.0.1:3001';
const DEFAULT_PROCESS_URL = 'http://127.0.0.1:3000/api/process-call';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_LOOKBACK_MINUTES = 180;
const DEFAULT_FETCH_LIMIT = 30;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MIN_AUDIO_BYTES = 4096;
const DEFAULT_TIMEZONE_OFFSET = '+03:00';
const DEFAULT_DOWNLOAD_RETRY_ATTEMPTS = 3;
const DEFAULT_DOWNLOAD_RETRY_BACKOFF_MS = 1500;
const DEFAULT_TRANSCRIBE_RETRY_ATTEMPTS = 2;
const DEFAULT_TRANSCRIBE_RETRY_BACKOFF_MS = 1500;
const DEFAULT_REPLAY_FETCH_LIMIT = 500;
const MIN_CONVERSATION_DURATION_SECONDS = 10;
const PRE_TRANSCRIBE_SKIP_REASONS = Object.freeze({
  DUPLICATE_EVENT: 'skipped_before_transcribe:duplicate_call_skip',
  DUPLICATE_EVENT_DRY_RUN: 'skipped_before_transcribe:duplicate_call_skip_dry_run',
  MISSING_RECORD_FILE_NAME: 'skipped_before_transcribe:missing_record_file_name',
  UNUSABLE_METADATA_MISSING_PHONE: 'skipped_before_transcribe:unusable_metadata_missing_phone',
  UNUSABLE_METADATA_MISSING_CALL_DATETIME: 'skipped_before_transcribe:unusable_metadata_missing_call_datetime',
  OUTGOING_UNANSWERED: 'skipped_before_transcribe:outgoing_unanswered',
  MISSED_CALL: 'skipped_before_transcribe:missed_call',
  MISSING_CONVERSATION_DURATION: 'skipped_before_transcribe:missing_conversation_duration',
  SHORT_CONVERSATION_LE_10S: 'skipped_before_transcribe:short_conversation_le_10s',
  INTERNAL_OR_IGNORED_PHONE: 'skipped_before_transcribe:internal_or_ignored_phone',
  AUDIO_TOO_SMALL: 'skipped_before_transcribe:audio_too_small',
  UNUSABLE_AUDIO_METADATA: 'skipped_before_transcribe:unusable_audio_metadata',
  AUDIO_RECORD_NOT_FOUND: 'skipped_before_transcribe:audio_record_not_found'
});
const CONVERSATION_DURATION_FIELDS = [
  'callDurationSec',
  'callDurationSeconds',
  'callDuration',
  'conversationDurationSec',
  'conversationDurationSeconds',
  'conversationDuration',
  'talkDurationSec',
  'talkDurationSeconds',
  'talkDuration',
  'conversationTime',
  'durationSec',
  'durationSeconds',
  'duration',
  'billsec',
  'billSec',
  'speakingDuration',
  'speechDuration'
];
const MISSED_BOOLEAN_FIELDS = [
  'isMissed',
  'missed',
  'missedCall',
  'is_missed'
];
const MISSED_STATUS_FIELDS = [
  'callStatus',
  'status',
  'result',
  'disposition',
  'callResult',
  'hangupReason',
  'terminationReason'
];
const MISSED_STATUS_TOKENS = [
  'missed',
  'no_answer',
  'not_answered',
  'unanswered',
  'noanswer',
  'busy',
  'abandoned',
  'cancelled',
  'canceled'
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parsePositiveInt(rawValue, name, fallbackValue) {
  if (!isNonEmptyString(rawValue)) {
    return fallbackValue;
  }

  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseBoolean(rawValue, fallbackValue) {
  if (!isNonEmptyString(rawValue)) {
    return fallbackValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${rawValue}`);
}

function normalizeErrorCodeToken(rawValue) {
  if (!isNonEmptyString(rawValue)) {
    return '';
  }

  return rawValue.trim().toUpperCase();
}

function parseErrorCodeList(rawValue) {
  if (!isNonEmptyString(rawValue)) {
    return [];
  }

  const unique = [];
  const seen = new Set();

  for (const chunk of rawValue.split(',')) {
    const token = normalizeErrorCodeToken(chunk);
    if (!token || seen.has(token)) {
      continue;
    }

    seen.add(token);
    unique.push(token);
  }

  return unique;
}

function appendReplayRecordFileNames(target, rawValue) {
  if (!isNonEmptyString(rawValue)) {
    return;
  }

  const chunks = rawValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    target.push(chunk);
  }
}

function parseArgs(argv, defaults) {
  const parsed = { ...defaults };
  parsed.recordFileNames = Array.isArray(defaults.recordFileNames)
    ? [...defaults.recordFileNames]
    : [];
  const args = [...argv];

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (arg === '--no-dry-run') {
      parsed.dryRun = false;
      continue;
    }

    if (arg === '--no-retry-failed') {
      parsed.retryFailed = false;
      continue;
    }

    if (arg === '--retry-failed') {
      parsed.retryFailed = true;
      continue;
    }

    if (arg.startsWith('--retry-skipped-error-codes=')) {
      parsed.retrySkippedErrorCodes = parseErrorCodeList(
        arg.split('=').slice(1).join('=')
      );
      continue;
    }

    if (arg === '--retry-skipped-error-codes') {
      parsed.retrySkippedErrorCodes = parseErrorCodeList(args.shift());
      continue;
    }

    if (arg.startsWith('--record-file-name=')) {
      appendReplayRecordFileNames(parsed.recordFileNames, arg.split('=').slice(1).join('='));
      continue;
    }

    if (arg === '--record-file-name') {
      appendReplayRecordFileNames(parsed.recordFileNames, args.shift());
      continue;
    }

    if (arg.startsWith('--lookback-minutes=')) {
      parsed.lookbackMinutes = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'lookback-minutes',
        parsed.lookbackMinutes
      );
      continue;
    }

    if (arg === '--lookback-minutes') {
      parsed.lookbackMinutes = parsePositiveInt(args.shift(), 'lookback-minutes', parsed.lookbackMinutes);
      continue;
    }

    if (arg.startsWith('--fetch-limit=')) {
      parsed.fetchLimit = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'fetch-limit',
        parsed.fetchLimit
      );
      continue;
    }

    if (arg === '--fetch-limit') {
      parsed.fetchLimit = parsePositiveInt(args.shift(), 'fetch-limit', parsed.fetchLimit);
      continue;
    }

    if (arg.startsWith('--max-candidates=')) {
      parsed.maxCandidates = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'max-candidates',
        parsed.maxCandidates
      );
      continue;
    }

    if (arg === '--max-candidates') {
      parsed.maxCandidates = parsePositiveInt(args.shift(), 'max-candidates', parsed.maxCandidates);
      continue;
    }

    if (arg.startsWith('--min-audio-bytes=')) {
      parsed.minAudioBytes = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'min-audio-bytes',
        parsed.minAudioBytes
      );
      continue;
    }

    if (arg === '--min-audio-bytes') {
      parsed.minAudioBytes = parsePositiveInt(args.shift(), 'min-audio-bytes', parsed.minAudioBytes);
      continue;
    }

    if (arg.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'timeout-ms',
        parsed.timeoutMs
      );
      continue;
    }

    if (arg === '--timeout-ms') {
      parsed.timeoutMs = parsePositiveInt(args.shift(), 'timeout-ms', parsed.timeoutMs);
      continue;
    }

    if (arg.startsWith('--download-retry-attempts=')) {
      parsed.downloadRetryAttempts = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'download-retry-attempts',
        parsed.downloadRetryAttempts
      );
      continue;
    }

    if (arg === '--download-retry-attempts') {
      parsed.downloadRetryAttempts = parsePositiveInt(
        args.shift(),
        'download-retry-attempts',
        parsed.downloadRetryAttempts
      );
      continue;
    }

    if (arg.startsWith('--download-retry-backoff-ms=')) {
      parsed.downloadRetryBackoffMs = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'download-retry-backoff-ms',
        parsed.downloadRetryBackoffMs
      );
      continue;
    }

    if (arg === '--download-retry-backoff-ms') {
      parsed.downloadRetryBackoffMs = parsePositiveInt(
        args.shift(),
        'download-retry-backoff-ms',
        parsed.downloadRetryBackoffMs
      );
      continue;
    }

    if (arg.startsWith('--transcribe-retry-attempts=')) {
      parsed.transcribeRetryAttempts = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'transcribe-retry-attempts',
        parsed.transcribeRetryAttempts
      );
      continue;
    }

    if (arg === '--transcribe-retry-attempts') {
      parsed.transcribeRetryAttempts = parsePositiveInt(
        args.shift(),
        'transcribe-retry-attempts',
        parsed.transcribeRetryAttempts
      );
      continue;
    }

    if (arg.startsWith('--transcribe-retry-backoff-ms=')) {
      parsed.transcribeRetryBackoffMs = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'transcribe-retry-backoff-ms',
        parsed.transcribeRetryBackoffMs
      );
      continue;
    }

    if (arg === '--transcribe-retry-backoff-ms') {
      parsed.transcribeRetryBackoffMs = parsePositiveInt(
        args.shift(),
        'transcribe-retry-backoff-ms',
        parsed.transcribeRetryBackoffMs
      );
      continue;
    }

    if (arg.startsWith('--replay-fetch-limit=')) {
      parsed.replayFetchLimit = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'replay-fetch-limit',
        parsed.replayFetchLimit
      );
      continue;
    }

    if (arg === '--replay-fetch-limit') {
      parsed.replayFetchLimit = parsePositiveInt(
        args.shift(),
        'replay-fetch-limit',
        parsed.replayFetchLimit
      );
      continue;
    }

    if (arg.startsWith('--process-url=')) {
      parsed.processUrl = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--process-url') {
      parsed.processUrl = args.shift() || parsed.processUrl;
      continue;
    }

    if (arg.startsWith('--ai-gateway-url=')) {
      parsed.aiGatewayUrl = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--ai-gateway-url') {
      parsed.aiGatewayUrl = args.shift() || parsed.aiGatewayUrl;
      continue;
    }

    if (arg.startsWith('--ai-gateway-secret=')) {
      parsed.aiGatewaySecret = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--ai-gateway-secret') {
      parsed.aiGatewaySecret = args.shift() || parsed.aiGatewaySecret;
      continue;
    }

    if (arg.startsWith('--ai-gateway-transcribe-path=')) {
      parsed.aiGatewayTranscribePath = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--ai-gateway-transcribe-path') {
      parsed.aiGatewayTranscribePath = args.shift() || parsed.aiGatewayTranscribePath;
      continue;
    }

    if (arg.startsWith('--transcribe-model=')) {
      parsed.transcribeModel = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--transcribe-model') {
      parsed.transcribeModel = args.shift() || parsed.transcribeModel;
      continue;
    }

    if (arg.startsWith('--compare-transcribe-model=')) {
      parsed.compareTranscribeModel = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--compare-transcribe-model') {
      parsed.compareTranscribeModel = args.shift() || parsed.compareTranscribeModel;
      continue;
    }

    if (arg.startsWith('--t2-base-url=')) {
      parsed.t2BaseUrl = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--t2-base-url') {
      parsed.t2BaseUrl = args.shift() || parsed.t2BaseUrl;
      continue;
    }

    if (arg.startsWith('--t2-token=')) {
      parsed.t2Token = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--t2-token') {
      parsed.t2Token = args.shift() || parsed.t2Token;
      continue;
    }

    if (arg.startsWith('--t2-auth-scheme=')) {
      parsed.t2AuthScheme = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--t2-auth-scheme') {
      parsed.t2AuthScheme = args.shift() || parsed.t2AuthScheme;
      continue;
    }

    if (arg.startsWith('--ingest-secret=')) {
      parsed.ingestSecret = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--ingest-secret') {
      parsed.ingestSecret = args.shift() || parsed.ingestSecret;
      continue;
    }

    if (arg.startsWith('--timezone-offset=')) {
      parsed.timezoneOffset = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--timezone-offset') {
      parsed.timezoneOffset = args.shift() || parsed.timezoneOffset;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function validateTimeZoneOffset(offset) {
  if (!isNonEmptyString(offset)) {
    throw new Error('timezone offset is required');
  }

  const normalized = offset.trim();
  if (!/^[+-][0-9]{2}:[0-9]{2}$/.test(normalized)) {
    throw new Error('timezone offset must be in format +HH:MM or -HH:MM');
  }

  const sign = normalized.startsWith('-') ? -1 : 1;
  const hours = Number.parseInt(normalized.slice(1, 3), 10);
  const minutes = Number.parseInt(normalized.slice(4, 6), 10);

  if (hours > 14 || minutes > 59) {
    throw new Error('timezone offset is out of range');
  }

  return {
    value: normalized,
    totalMinutes: sign * (hours * 60 + minutes)
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateWithOffset(date, offsetMeta) {
  const shifted = new Date(date.getTime() + offsetMeta.totalMinutes * 60 * 1000);

  return [
    shifted.getUTCFullYear(),
    '-',
    pad2(shifted.getUTCMonth() + 1),
    '-',
    pad2(shifted.getUTCDate()),
    'T',
    pad2(shifted.getUTCHours()),
    ':',
    pad2(shifted.getUTCMinutes()),
    ':',
    pad2(shifted.getUTCSeconds()),
    offsetMeta.value
  ].join('');
}

function buildLookbackWindow({ lookbackMinutes, offsetMeta }) {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookbackMinutes * 60 * 1000);

  return {
    startDate,
    endDate,
    start: formatDateWithOffset(startDate, offsetMeta),
    end: formatDateWithOffset(endDate, offsetMeta)
  };
}

function buildDayWindowByRecordFileName(recordFileName, offsetMeta) {
  const normalizedRecord = normalizeRecordFileName(recordFileName);
  if (!normalizedRecord.includes('/')) {
    return null;
  }

  const [datePart] = normalizedRecord.split('/', 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return null;
  }

  return {
    start: `${datePart}T00:00:00${offsetMeta.value}`,
    end: `${datePart}T23:59:59${offsetMeta.value}`
  };
}

function delayMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, value);
  });
}

function buildBackoffMs(baseMs, attemptNumber) {
  if (!Number.isSafeInteger(baseMs) || baseMs <= 0) {
    return 0;
  }

  const safeAttempt = Number.isSafeInteger(attemptNumber) && attemptNumber > 0
    ? attemptNumber
    : 1;

  return baseMs * (2 ** (safeAttempt - 1));
}

function isRetryableHttpStatus(statusCode) {
  return Number.isInteger(statusCode) && (
    statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || statusCode >= 500
  );
}

function buildAuthorizationHeader(token, scheme) {
  if (scheme === 'bearer') {
    return `Bearer ${token}`;
  }

  return token;
}

function truncateMessage(message, maxLength = 400) {
  if (!isNonEmptyString(message)) {
    return '';
  }

  const normalized = message.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeRecordFileName(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value.trim();
}

function pickFirstNonEmptyString(values) {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  return '';
}

function resolvePhoneFromRecord(record) {
  return resolveClientPhoneFromCallMeta({
    callType: record?.callType,
    phone: record?.phone,
    callerNumber: record?.callerNumber,
    calleeNumber: record?.calleeNumber,
    destinationNumber: record?.destinationNumber
  });
}

function buildProcessCallPayload({
  record = {},
  phone = '',
  callDateTime = '',
  transcript = ''
} = {}) {
  const durationMeta = extractConversationDuration(record);
  const missedMeta = recordLooksMissed(record);
  const callId = pickFirstNonEmptyString([
    record?.callId,
    record?.externalCallId,
    record?.recordingId,
    record?.recordFileName
  ]);

  const payload = {
    phone: isNonEmptyString(phone) ? phone.trim() : '',
    callDateTime: isNonEmptyString(callDateTime) ? callDateTime.trim() : '',
    transcript: isNonEmptyString(transcript) ? transcript.trim() : '',
    ...(isNonEmptyString(callId) ? { callId } : {})
  };

  const optionalFields = {
    callType: pickFirstNonEmptyString([record?.callType]),
    callerNumber: pickFirstNonEmptyString([record?.callerNumber]),
    calleeNumber: pickFirstNonEmptyString([record?.calleeNumber]),
    destinationNumber: pickFirstNonEmptyString([record?.destinationNumber])
  };

  for (const [key, value] of Object.entries(optionalFields)) {
    if (isNonEmptyString(value)) {
      payload[key] = value;
    }
  }

  if (typeof durationMeta.seconds === 'number' && Number.isFinite(durationMeta.seconds) && durationMeta.seconds >= 0) {
    payload.durationSec = Math.round(durationMeta.seconds);
  }

  if (isNonEmptyString(missedMeta.sourceField)) {
    payload.answered = !missedMeta.isMissed;
    payload.noAnswer = missedMeta.isMissed;
  } else if (typeof durationMeta.seconds === 'number' && Number.isFinite(durationMeta.seconds) && durationMeta.seconds > 0) {
    payload.answered = true;
    payload.noAnswer = false;
  }

  return payload;
}

function parseDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (!isNonEmptyString(value)) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(',', '.');
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    return Number.parseFloat(normalized);
  }

  if (/^[0-9]{1,2}:[0-9]{2}:[0-9]{2}$/.test(normalized)) {
    const [hoursRaw, minutesRaw, secondsRaw] = normalized.split(':');
    const hours = Number.parseInt(hoursRaw, 10);
    const minutes = Number.parseInt(minutesRaw, 10);
    const seconds = Number.parseInt(secondsRaw, 10);
    return (hours * 3600) + (minutes * 60) + seconds;
  }

  if (/^[0-9]{1,2}:[0-9]{2}$/.test(normalized)) {
    const [minutesRaw, secondsRaw] = normalized.split(':');
    const minutes = Number.parseInt(minutesRaw, 10);
    const seconds = Number.parseInt(secondsRaw, 10);
    return (minutes * 60) + seconds;
  }

  const textNumberMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!textNumberMatch) {
    return null;
  }

  return Number.parseFloat(textNumberMatch[1]);
}

function extractConversationDuration(record) {
  for (const field of CONVERSATION_DURATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record || {}, field)) {
      continue;
    }

    const rawValue = record[field];
    const seconds = parseDurationSeconds(rawValue);
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      return {
        seconds,
        sourceField: field,
        rawValue
      };
    }
  }

  return {
    seconds: null,
    sourceField: '',
    rawValue: null
  };
}

function recordLooksMissed(record) {
  for (const field of MISSED_BOOLEAN_FIELDS) {
    const value = record ? record[field] : undefined;
    if (value === true || value === 1) {
      return {
        isMissed: true,
        sourceField: field,
        sourceValue: value
      };
    }

    if (isNonEmptyString(value)) {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(normalized)) {
        return {
          isMissed: true,
          sourceField: field,
          sourceValue: value
        };
      }
    }
  }

  for (const field of MISSED_STATUS_FIELDS) {
    const value = record ? record[field] : undefined;
    if (!isNonEmptyString(value)) {
      continue;
    }

    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (MISSED_STATUS_TOKENS.some((token) => normalized.includes(token))) {
      return {
        isMissed: true,
        sourceField: field,
        sourceValue: value
      };
    }
  }

  return {
    isMissed: false,
    sourceField: '',
    sourceValue: null
  };
}

function evaluateConversationGate(record) {
  const durationMeta = extractConversationDuration(record);
  const missedMeta = recordLooksMissed(record);
  const callType = normalizeCallType(record?.callType);

  if (callType === 'OUTGOING' && missedMeta.isMissed) {
    return {
      shouldAnalyze: false,
      reason: PRE_TRANSCRIBE_SKIP_REASONS.OUTGOING_UNANSWERED,
      errorCode: 'OUTGOING_UNANSWERED',
      errorMessage: `Outgoing call marked as unanswered by field "${missedMeta.sourceField}"`,
      durationSeconds: durationMeta.seconds,
      durationSourceField: durationMeta.sourceField
    };
  }

  if (missedMeta.isMissed) {
    return {
      shouldAnalyze: false,
      reason: PRE_TRANSCRIBE_SKIP_REASONS.MISSED_CALL,
      errorCode: 'MISSED_CALL',
      errorMessage: `Call marked as missed by field "${missedMeta.sourceField}"`,
      durationSeconds: durationMeta.seconds,
      durationSourceField: durationMeta.sourceField
    };
  }

  if (typeof durationMeta.seconds !== 'number' || Number.isNaN(durationMeta.seconds)) {
    return {
      shouldAnalyze: false,
      reason: PRE_TRANSCRIBE_SKIP_REASONS.MISSING_CONVERSATION_DURATION,
      errorCode: 'CONVERSATION_DURATION_MISSING',
      errorMessage: `Cannot resolve conversation duration from Tele2 record (expected one of: ${CONVERSATION_DURATION_FIELDS.join(', ')})`,
      durationSeconds: null,
      durationSourceField: durationMeta.sourceField
    };
  }

  if (durationMeta.seconds <= MIN_CONVERSATION_DURATION_SECONDS) {
    return {
      shouldAnalyze: false,
      reason: PRE_TRANSCRIBE_SKIP_REASONS.SHORT_CONVERSATION_LE_10S,
      errorCode: 'CONVERSATION_DURATION_TOO_SHORT',
      errorMessage: `Conversation duration ${durationMeta.seconds} sec is not greater than ${MIN_CONVERSATION_DURATION_SECONDS} sec`,
      durationSeconds: durationMeta.seconds,
      durationSourceField: durationMeta.sourceField
    };
  }

  return {
    shouldAnalyze: true,
    reason: 'eligible',
    errorCode: '',
    errorMessage: '',
    durationSeconds: durationMeta.seconds,
    durationSourceField: durationMeta.sourceField
  };
}

function phoneLast4(phone) {
  if (!isNonEmptyString(phone)) {
    return '';
  }

  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4);
}

function buildTempFilePath(recordFileName) {
  const safe = recordFileName.replace(/[^a-zA-Z0-9._/-]/g, '_').replace(/[\/]/g, '__');
  return path.join(os.tmpdir(), `tele2-poll-${safe}-${crypto.randomUUID()}.mp3`);
}

function sanitizeRecordFileName(recordFileName) {
  return recordFileName
    .replace(/[^a-zA-Z0-9._/-]/g, '_')
    .replace(/[\/]/g, '__');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: abortController.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Request timeout after ${timeoutMs} ms`);
      timeoutError.code = 'REQUEST_TIMEOUT';
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveUrl(baseUrl, pathname) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return new URL(normalizedPath, normalizedBase);
}

async function fetchTele2Records({
  t2BaseUrl,
  t2Token,
  t2AuthScheme,
  timeoutMs,
  start,
  end,
  fetchLimit
}) {
  const url = resolveUrl(t2BaseUrl, 'call-records/info');
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('is_recorded', 'true');
  url.searchParams.set('size', String(fetchLimit));
  url.searchParams.set('sort', 'date,DESC');

  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: buildAuthorizationHeader(t2Token, t2AuthScheme)
    }
  }, timeoutMs);

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Tele2 info request failed with status ${response.status}`);
    error.statusCode = response.status;
    error.code = 'T2_INFO_HTTP_ERROR';
    error.responseBody = text;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const parseError = new Error('Tele2 info response is not valid JSON');
    parseError.code = 'T2_INFO_INVALID_JSON';
    parseError.responseBody = text;
    throw parseError;
  }

  if (!Array.isArray(parsed)) {
    const shapeError = new Error('Tele2 info response JSON is not an array');
    shapeError.code = 'T2_INFO_INVALID_SHAPE';
    throw shapeError;
  }

  return parsed;
}

async function fetchTele2RecordByFileName({
  recordFileName,
  t2BaseUrl,
  t2Token,
  t2AuthScheme,
  timeoutMs,
  offsetMeta,
  fetchLimit
}) {
  const dayWindow = buildDayWindowByRecordFileName(recordFileName, offsetMeta);
  if (!dayWindow) {
    return null;
  }

  const records = await fetchTele2Records({
    t2BaseUrl,
    t2Token,
    t2AuthScheme,
    timeoutMs,
    start: dayWindow.start,
    end: dayWindow.end,
    fetchLimit
  });

  const normalizedTarget = normalizeRecordFileName(recordFileName);
  for (const record of records) {
    if (normalizeRecordFileName(record?.recordFileName) === normalizedTarget) {
      return {
        ...record,
        recordFileName: normalizedTarget
      };
    }
  }

  return null;
}

async function downloadTele2Audio({
  recordFileName,
  t2BaseUrl,
  t2Token,
  t2AuthScheme,
  timeoutMs
}) {
  const url = resolveUrl(t2BaseUrl, 'call-records/file');
  url.searchParams.set('filename', recordFileName);

  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: buildAuthorizationHeader(t2Token, t2AuthScheme)
    }
  }, timeoutMs);

  const contentType = response.headers.get('content-type') || '';
  const bodyBuffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const error = new Error(`Tele2 file download failed with status ${response.status}`);
    error.statusCode = response.status;
    error.code = 'T2_FILE_HTTP_ERROR';
    error.responseBody = bodyBuffer.toString('utf8');
    throw error;
  }

  if (!contentType.toLowerCase().includes('audio')) {
    const error = new Error(`Tele2 file response is not audio (content-type: ${contentType || 'unknown'})`);
    error.code = 'T2_FILE_NOT_AUDIO';
    error.statusCode = 502;
    throw error;
  }

  const tempFilePath = buildTempFilePath(recordFileName);
  fs.writeFileSync(tempFilePath, bodyBuffer);

  return {
    tempFilePath,
    contentType,
    sizeBytes: bodyBuffer.length
  };
}

function isRetryableDownloadError(error) {
  const errorCode = isNonEmptyString(error?.code) ? error.code.trim() : '';
  if (errorCode === 'REQUEST_TIMEOUT') {
    return true;
  }

  if (errorCode === 'T2_FILE_HTTP_ERROR') {
    if (!Number.isInteger(error?.statusCode)) {
      return true;
    }

    return isRetryableHttpStatus(error.statusCode);
  }

  return false;
}

async function downloadTele2AudioWithRetry({
  recordFileName,
  t2BaseUrl,
  t2Token,
  t2AuthScheme,
  timeoutMs,
  logger,
  requestId,
  attempts,
  baseBackoffMs
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const audio = await downloadTele2Audio({
        recordFileName,
        t2BaseUrl,
        t2Token,
        t2AuthScheme,
        timeoutMs
      });

      if (attempt > 1) {
        logger.info('tele2_poll_download_recovered_after_retry', {
          recordFileName,
          requestId,
          attempt,
          maxAttempts: attempts,
          audioBytes: audio.sizeBytes
        });
      }

      return {
        audio,
        attemptsUsed: attempt
      };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableDownloadError(error);
      const errorCode = isNonEmptyString(error?.code) ? error.code.trim() : 'T2_FILE_DOWNLOAD_FAILED';
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;

      logger.warn('tele2_poll_download_attempt_failed', {
        recordFileName,
        requestId,
        attempt,
        maxAttempts: attempts,
        retryable,
        errorCode,
        statusCode,
        errorMessage: truncateMessage(error?.message || 'Unknown download error', 300)
      });

      if (!retryable || attempt >= attempts) {
        throw error;
      }

      const retryDelayMs = buildBackoffMs(baseBackoffMs, attempt);
      logger.info('tele2_poll_download_retry_scheduled', {
        recordFileName,
        requestId,
        attempt,
        nextAttempt: attempt + 1,
        retryDelayMs
      });
      await delayMs(retryDelayMs);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Unexpected download retry state');
}

async function transcribeViaGateway({
  tempFilePath,
  recordFileName,
  requestId,
  callId,
  aiGatewayUrl,
  aiGatewaySecret,
  aiGatewayTranscribePath,
  transcribeModel,
  timeoutMs
}) {
  const audioBuffer = fs.readFileSync(tempFilePath);
  const url = resolveUrl(aiGatewayUrl, aiGatewayTranscribePath).toString();
  const uploadFileName = `${sanitizeRecordFileName(recordFileName)}.mp3`;

  const formData = new FormData();
  formData.append('requestId', requestId);
  if (isNonEmptyString(callId)) {
    formData.append('callId', callId.trim());
  }
  formData.append('fileName', uploadFileName);
  formData.append('mimeType', 'audio/mpeg');
  if (isNonEmptyString(transcribeModel)) {
    formData.append('transcribeModel', transcribeModel.trim());
  }
  formData.append(
    'audio',
    new Blob([audioBuffer], { type: 'audio/mpeg' }),
    uploadFileName
  );

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'x-gateway-secret': aiGatewaySecret,
      'x-request-id': requestId
    },
    body: formData
  }, timeoutMs);

  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const requestError = new Error(`ai-gateway transcription failed with status ${response.status}`);
    requestError.statusCode = response.status;
    requestError.code = payload?.code || 'AI_GATEWAY_TRANSCRIBE_HTTP_ERROR';
    requestError.responseBody = payload || raw;
    if (payload?.details && typeof payload.details === 'object') {
      requestError.details = payload.details;
    }
    if (payload?.aiUsage && typeof payload.aiUsage === 'object') {
      requestError.aiUsage = payload.aiUsage;
    }
    throw requestError;
  }

  const transcript = isNonEmptyString(payload?.transcript) ? payload.transcript.trim() : '';
  if (!transcript) {
    const emptyError = new Error('ai-gateway returned empty transcript');
    emptyError.code = 'AI_GATEWAY_EMPTY_TRANSCRIPT';
    throw emptyError;
  }

  return {
    transcript,
    model: isNonEmptyString(payload?.model)
      ? payload.model.trim()
      : (isNonEmptyString(transcribeModel) ? transcribeModel.trim() : ''),
    audioBytes: Number.isInteger(payload?.audioBytes) ? payload.audioBytes : audioBuffer.length,
    aiUsage: payload?.aiUsage && typeof payload.aiUsage === 'object' ? payload.aiUsage : null
  };
}

function buildTranscriptPreview(transcript) {
  if (!isNonEmptyString(transcript)) {
    return '';
  }

  const normalized = transcript.trim();
  if (normalized.length <= 140) {
    return normalized;
  }

  return `${normalized.slice(0, 137)}...`;
}

function resolveTranscribeErrorCode(error) {
  if (isNonEmptyString(error?.code)) {
    return error.code.trim();
  }

  if (isNonEmptyString(error?.responseBody?.code)) {
    return error.responseBody.code.trim();
  }

  return 'AI_GATEWAY_TRANSCRIBE_FAILED';
}

function isEmptyTranscriptionCode(errorCode) {
  return errorCode === 'POLZA_EMPTY_TRANSCRIPTION' || errorCode === 'AI_GATEWAY_EMPTY_TRANSCRIPT';
}

function readAudioFingerprint(tempFilePath) {
  if (!isNonEmptyString(tempFilePath)) {
    return {
      sha256: '',
      first16Hex: ''
    };
  }

  try {
    const audioBuffer = fs.readFileSync(tempFilePath);
    return {
      sha256: crypto.createHash('sha256').update(audioBuffer).digest('hex'),
      first16Hex: audioBuffer.subarray(0, 16).toString('hex')
    };
  } catch (error) {
    return {
      sha256: '',
      first16Hex: ''
    };
  }
}

function normalizeTranscriptionOutcome(outcome, index) {
  const normalized = outcome && typeof outcome === 'object' ? outcome : {};
  const attempt = Number.isSafeInteger(normalized.attempt) && normalized.attempt > 0
    ? normalized.attempt
    : index + 1;
  const status = isNonEmptyString(normalized.status) ? normalized.status.trim() : 'failed';
  const errorCode = isNonEmptyString(normalized.errorCode) ? normalized.errorCode.trim() : '';
  const model = isNonEmptyString(normalized.model) ? normalized.model.trim() : '';
  const durationMs = Number.isSafeInteger(normalized.durationMs) && normalized.durationMs >= 0
    ? normalized.durationMs
    : null;
  const statusCode = Number.isInteger(normalized.statusCode) ? normalized.statusCode : null;
  const transcriptLength = Number.isSafeInteger(normalized.transcriptLength) && normalized.transcriptLength >= 0
    ? normalized.transcriptLength
    : 0;
  const errorMessage = isNonEmptyString(normalized.errorMessage)
    ? truncateMessage(normalized.errorMessage, 180)
    : '';
  const errorDetails = normalized.errorDetails && typeof normalized.errorDetails === 'object'
    ? normalized.errorDetails
    : null;

  return {
    attempt,
    status,
    errorCode,
    model,
    durationMs,
    statusCode,
    transcriptLength,
    errorMessage,
    errorDetails
  };
}

function classifyEmptyTranscriptionDiagnostics({ outcomes, audioBytes, conversationDurationSeconds }) {
  const normalizedOutcomes = Array.isArray(outcomes)
    ? outcomes.map((outcome, index) => normalizeTranscriptionOutcome(outcome, index))
    : [];
  const hasOutcomes = normalizedOutcomes.length > 0;
  const hasOnlyEmptyCodes = hasOutcomes
    ? normalizedOutcomes.every((item) => isEmptyTranscriptionCode(item.errorCode))
    : false;
  const hasMixedFailures = hasOutcomes
    ? normalizedOutcomes.some((item) => !isEmptyTranscriptionCode(item.errorCode) && item.errorCode)
    : false;
  const shortConversationLikely = typeof conversationDurationSeconds === 'number'
    && Number.isFinite(conversationDurationSeconds)
    && conversationDurationSeconds <= 15;
  const smallAudioLikely = Number.isSafeInteger(audioBytes) && audioBytes > 0 && audioBytes < 16384;

  if (hasOnlyEmptyCodes && (shortConversationLikely || smallAudioLikely)) {
    return 'audio_short_or_low_signal_likely';
  }

  if (hasOnlyEmptyCodes) {
    return 'upstream_empty_after_retries';
  }

  if (hasMixedFailures) {
    return 'mixed_transient_or_upstream_failures';
  }

  return 'empty_transcription_unclassified';
}

function buildEmptyTranscriptionDiagnostics({
  recordFileName,
  requestId,
  error,
  audio,
  conversationDurationSeconds,
  requestedModel,
  aiGatewayTranscribePath
}) {
  const normalizedError = error && typeof error === 'object' ? error : {};
  const outcomes = Array.isArray(normalizedError.transcriptionOutcomes)
    ? normalizedError.transcriptionOutcomes.map((item, index) => normalizeTranscriptionOutcome(item, index))
    : [];
  const attemptCodes = outcomes
    .map((item) => item.errorCode || (item.status === 'success' ? 'SUCCESS' : 'UNKNOWN'))
    .filter(Boolean);
  const fingerprint = readAudioFingerprint(audio?.tempFilePath);
  const audioBytes = Number.isSafeInteger(audio?.sizeBytes) ? audio.sizeBytes : null;
  const contentType = isNonEmptyString(audio?.contentType) ? audio.contentType.trim() : '';
  const finalErrorCode = isNonEmptyString(normalizedError.code) ? normalizedError.code.trim() : 'POLZA_EMPTY_TRANSCRIPTION';
  const finalErrorMessage = truncateMessage(normalizedError.message || 'Empty transcription', 180);
  const upstreamDetails = normalizedError.details && typeof normalizedError.details === 'object'
    ? normalizedError.details
    : null;
  const attemptsUsed = Number.isSafeInteger(normalizedError.transcriptionAttempts)
    ? normalizedError.transcriptionAttempts
    : outcomes.length;

  const classification = classifyEmptyTranscriptionDiagnostics({
    outcomes,
    audioBytes,
    conversationDurationSeconds
  });

  return {
    recordFileName,
    requestId,
    downloadPath: recordFileName,
    classification,
    recoverable: true,
    audio: {
      bytes: audioBytes,
      contentType,
      conversationDurationSeconds: Number.isFinite(conversationDurationSeconds)
        ? Number(conversationDurationSeconds.toFixed(2))
        : null,
      sha256: fingerprint.sha256,
      first16Hex: fingerprint.first16Hex
    },
    transcribe: {
      attemptsUsed,
      requestedModel: isNonEmptyString(requestedModel) ? requestedModel.trim() : '',
      gatewayPath: isNonEmptyString(aiGatewayTranscribePath) ? aiGatewayTranscribePath.trim() : '/transcribe',
      finalErrorCode,
      finalErrorMessage,
      statusCode: Number.isInteger(normalizedError.statusCode) ? normalizedError.statusCode : null,
      attemptCodes,
      upstreamDetails,
      outcomes
    }
  };
}

function buildEmptyTranscriptionErrorMessage(diagnostics) {
  const details = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
  const classification = isNonEmptyString(details.classification)
    ? details.classification.trim()
    : 'empty_transcription_unclassified';
  const bytes = Number.isSafeInteger(details.audio?.bytes) ? details.audio.bytes : null;
  const mime = isNonEmptyString(details.audio?.contentType) ? details.audio.contentType.trim() : 'unknown';
  const convSec = Number.isFinite(details.audio?.conversationDurationSeconds)
    ? details.audio.conversationDurationSeconds
    : null;
  const attempts = Number.isSafeInteger(details.transcribe?.attemptsUsed) ? details.transcribe.attemptsUsed : 0;
  const attemptCodes = Array.isArray(details.transcribe?.attemptCodes)
    ? details.transcribe.attemptCodes.join('>')
    : '';
  const shaShort = isNonEmptyString(details.audio?.sha256) ? details.audio.sha256.slice(0, 16) : '';

  return truncateMessage(
    [
      `class=${classification}`,
      `mime=${mime}`,
      `bytes=${bytes !== null ? bytes : 'n/a'}`,
      `convSec=${convSec !== null ? convSec : 'n/a'}`,
      `attempts=${attempts}`,
      `codes=${attemptCodes || 'n/a'}`,
      `sha16=${shaShort || 'n/a'}`
    ].join('; '),
    380
  );
}

async function runTranscriptionAttempt({
  tempFilePath,
  recordFileName,
  requestId,
  callId,
  aiGatewayUrl,
  aiGatewaySecret,
  aiGatewayTranscribePath,
  transcribeModel,
  timeoutMs
}) {
  const startedAt = Date.now();

  try {
    const result = await transcribeViaGateway({
      tempFilePath,
      recordFileName,
      requestId,
      callId,
      aiGatewayUrl,
      aiGatewaySecret,
      aiGatewayTranscribePath,
      transcribeModel,
      timeoutMs
    });

    const durationMs = Date.now() - startedAt;
    return {
      ok: true,
      result,
      outcome: {
        status: 'success',
        model: result.model || (isNonEmptyString(transcribeModel) ? transcribeModel.trim() : 'default'),
        transcriptLength: result.transcript.length,
        preview: buildTranscriptPreview(result.transcript),
        durationMs,
        audioBytes: result.audioBytes
      }
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorCode = resolveTranscribeErrorCode(error);
    return {
      ok: false,
      error,
      outcome: {
        status: isEmptyTranscriptionCode(errorCode) ? 'empty' : 'failed',
        model: isNonEmptyString(transcribeModel) ? transcribeModel.trim() : 'default',
        transcriptLength: 0,
        preview: '',
        durationMs,
        audioBytes: null,
        errorCode,
        errorMessage: truncateMessage(error?.message || 'Unknown transcription error', 300),
        statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null,
        errorDetails: (error?.details && typeof error.details === 'object')
          ? error.details
          : (error?.responseBody?.details && typeof error.responseBody.details === 'object'
            ? error.responseBody.details
            : null)
      }
    };
  }
}

function isRetryableTranscribeError(error) {
  const errorCode = isNonEmptyString(error?.code) ? error.code.trim() : '';
  if (errorCode === 'REQUEST_TIMEOUT') {
    return true;
  }

  if (errorCode === 'POLZA_EMPTY_TRANSCRIPTION' || errorCode === 'AI_GATEWAY_EMPTY_TRANSCRIPT') {
    return true;
  }

  if (errorCode === 'POLZA_TRANSCRIBE_FAILED' || errorCode === 'AI_GATEWAY_TRANSCRIBE_HTTP_ERROR') {
    if (!Number.isInteger(error?.statusCode)) {
      return true;
    }

    return isRetryableHttpStatus(error.statusCode);
  }

  return false;
}

async function runTranscriptionWithRetry({
  tempFilePath,
  recordFileName,
  requestId,
  callId,
  aiGatewayUrl,
  aiGatewaySecret,
  aiGatewayTranscribePath,
  transcribeModel,
  timeoutMs,
  logger,
  attempts,
  baseBackoffMs
}) {
  const outcomes = [];
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const run = await runTranscriptionAttempt({
      tempFilePath,
      recordFileName,
      requestId,
      callId,
      aiGatewayUrl,
      aiGatewaySecret,
      aiGatewayTranscribePath,
      transcribeModel,
      timeoutMs
    });

    outcomes.push({
      attempt,
      ...run
    });

    if (run.ok) {
      if (attempt > 1) {
        logger.info('tele2_poll_transcription_recovered_after_retry', {
          recordFileName,
          requestId,
          attempt,
          maxAttempts: attempts,
          transcriptLength: run.result.transcript.length
        });
      }

      return {
        ok: true,
        result: run.result,
        outcomes
      };
    }

    const currentError = run.error || new Error('Transcription attempt failed');
    if (!isNonEmptyString(currentError.code) && isNonEmptyString(run.outcome?.errorCode)) {
      currentError.code = run.outcome.errorCode;
    }
    if (!Number.isInteger(currentError.statusCode) && Number.isInteger(run.outcome?.statusCode)) {
      currentError.statusCode = run.outcome.statusCode;
    }

    lastError = currentError;
    const retryable = isRetryableTranscribeError(currentError);

    logger.warn('tele2_poll_transcription_attempt_failed', {
      recordFileName,
      requestId,
      attempt,
      maxAttempts: attempts,
      retryable,
      errorCode: isNonEmptyString(currentError.code) ? currentError.code.trim() : '',
      statusCode: Number.isInteger(currentError.statusCode) ? currentError.statusCode : null,
      errorMessage: truncateMessage(currentError.message || 'Unknown transcription error', 300)
    });

    if (!retryable || attempt >= attempts) {
      return {
        ok: false,
        error: currentError,
        outcomes
      };
    }

    const retryDelayMs = buildBackoffMs(baseBackoffMs, attempt);
    logger.info('tele2_poll_transcription_retry_scheduled', {
      recordFileName,
      requestId,
      attempt,
      nextAttempt: attempt + 1,
      retryDelayMs
    });
    await delayMs(retryDelayMs);
  }

  return {
    ok: false,
    error: lastError || new Error('Unknown transcription retry failure'),
    outcomes
  };
}

async function sendProcessCall({
  processUrl,
  ingestSecret,
  requestId,
  payload,
  timeoutMs
}) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (isNonEmptyString(ingestSecret)) {
    headers['X-Ingest-Secret'] = ingestSecret;
  }

  if (isNonEmptyString(requestId)) {
    headers['x-request-id'] = requestId.trim();
  }

  const response = await fetchWithTimeout(processUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs);

  const raw = await response.text();
  let parsedBody = null;
  try {
    parsedBody = JSON.parse(raw);
  } catch (error) {
    parsedBody = null;
  }

  if (!response.ok) {
    const requestError = new Error(`process-call failed with status ${response.status}`);
    requestError.statusCode = response.status;
    requestError.code = parsedBody?.code || 'PROCESS_CALL_HTTP_ERROR';
    requestError.responseBody = parsedBody || raw;
    throw requestError;
  }

  return {
    statusCode: response.status,
    body: parsedBody || raw
  };
}

async function ensureTele2DedupTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tele2_polled_records (
      id BIGSERIAL PRIMARY KEY,
      record_file_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (
        status IN ('processing', 'processed', 'duplicate', 'ignored', 'skipped', 'failed')
      ),
      attempts INTEGER NOT NULL DEFAULT 1,
      phone_raw TEXT,
      call_datetime_raw TEXT,
      transcript_length INTEGER,
      last_process_status TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tele2_polled_records_status
      ON tele2_polled_records (status)
  `);
}

async function isPhoneIgnoredPreTranscribe(pool, phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return false;
  }

  const result = await pool.query(
    `
    SELECT 1
    FROM ignore_list
    WHERE phone_normalized = $1
      AND is_active = TRUE
    LIMIT 1
    `,
    [normalizedPhone]
  );

  return result.rowCount > 0;
}

async function getDedupStatus(pool, recordFileName) {
  const result = await pool.query(
    `
    SELECT status, attempts, last_error_code, phone_raw, call_datetime_raw
    FROM tele2_polled_records
    WHERE record_file_name = $1
    LIMIT 1
    `,
    [recordFileName]
  );

  return result.rows[0] || null;
}

function shouldRetrySkippedByErrorCode(existingStatus, retrySkippedErrorCodes) {
  if (!existingStatus || existingStatus.status !== 'skipped') {
    return false;
  }

  if (!(retrySkippedErrorCodes instanceof Set) || retrySkippedErrorCodes.size === 0) {
    return false;
  }

  const normalized = normalizeErrorCodeToken(existingStatus.last_error_code || '');
  if (!normalized) {
    return false;
  }

  return retrySkippedErrorCodes.has(normalized);
}

async function reserveDedupRecord(pool, {
  recordFileName,
  retryFailed,
  retrySkippedErrorCodes
}) {
  const inserted = await pool.query(
    `
    INSERT INTO tele2_polled_records (
      record_file_name,
      status,
      attempts,
      last_seen_at,
      updated_at
    )
    VALUES ($1, 'processing', 1, NOW(), NOW())
    ON CONFLICT (record_file_name) DO NOTHING
    RETURNING status
    `,
    [recordFileName]
  );

  if (inserted.rowCount > 0) {
    return {
      acquired: true,
      previousStatus: null
    };
  }

  if (retryFailed) {
    const recovered = await pool.query(
      `
      UPDATE tele2_polled_records
      SET status = 'processing',
          attempts = attempts + 1,
          last_seen_at = NOW(),
          updated_at = NOW(),
          last_error_code = NULL,
          last_error_message = NULL
      WHERE record_file_name = $1 AND status = 'failed'
      RETURNING status
      `,
      [recordFileName]
    );

    if (recovered.rowCount > 0) {
      return {
        acquired: true,
        previousStatus: 'failed'
      };
    }
  }

  if (retrySkippedErrorCodes instanceof Set && retrySkippedErrorCodes.size > 0) {
    const recoverableCodes = Array.from(retrySkippedErrorCodes);
    const recoveredSkipped = await pool.query(
      `
      UPDATE tele2_polled_records
      SET status = 'processing',
          attempts = attempts + 1,
          last_seen_at = NOW(),
          updated_at = NOW(),
          last_error_code = NULL,
          last_error_message = NULL
      WHERE record_file_name = $1
        AND status = 'skipped'
        AND UPPER(COALESCE(last_error_code, '')) = ANY($2::text[])
      RETURNING status
      `,
      [recordFileName, recoverableCodes]
    );

    if (recoveredSkipped.rowCount > 0) {
      return {
        acquired: true,
        previousStatus: 'skipped'
      };
    }
  }

  const existing = await getDedupStatus(pool, recordFileName);
  await pool.query(
    `
    UPDATE tele2_polled_records
    SET last_seen_at = NOW(),
        updated_at = NOW()
    WHERE record_file_name = $1
    `,
    [recordFileName]
  );

  return {
    acquired: false,
    previousStatus: existing?.status || 'unknown'
  };
}

async function finalizeDedupRecord(pool, {
  recordFileName,
  status,
  phoneRaw = '',
  callDateTimeRaw = '',
  transcriptLength = null,
  processStatus = '',
  errorCode = '',
  errorMessage = ''
}) {
  await pool.query(
    `
    UPDATE tele2_polled_records
    SET status = $2,
        phone_raw = $3,
        call_datetime_raw = $4,
        transcript_length = $5,
        last_process_status = $6,
        last_error_code = $7,
        last_error_message = $8,
        last_seen_at = NOW(),
        updated_at = NOW()
    WHERE record_file_name = $1
    `,
    [
      recordFileName,
      status,
      isNonEmptyString(phoneRaw) ? phoneRaw.trim() : null,
      isNonEmptyString(callDateTimeRaw) ? callDateTimeRaw.trim() : null,
      Number.isInteger(transcriptLength) ? transcriptLength : null,
      isNonEmptyString(processStatus) ? processStatus.trim() : null,
      isNonEmptyString(errorCode) ? errorCode.trim() : null,
      isNonEmptyString(errorMessage) ? truncateMessage(errorMessage, 400) : null
    ]
  );
}

function shouldMarkAsSkipped(error) {
  const code = isNonEmptyString(error?.code) ? error.code.trim() : '';
  if (code === 'POLZA_EMPTY_TRANSCRIPTION' || code === 'AI_GATEWAY_EMPTY_TRANSCRIPT') {
    return true;
  }

  if (code === 'T2_FILE_NOT_AUDIO') {
    return true;
  }

  if (code === 'T2_FILE_HTTP_ERROR' && Number.isInteger(error?.statusCode) && error.statusCode === 404) {
    return true;
  }

  return false;
}

function resolvePreTranscribeSkipReasonFromError(error) {
  const code = isNonEmptyString(error?.code) ? error.code.trim() : '';

  if (code === 'T2_FILE_NOT_AUDIO') {
    return PRE_TRANSCRIBE_SKIP_REASONS.UNUSABLE_AUDIO_METADATA;
  }

  if (code === 'T2_FILE_HTTP_ERROR' && Number.isInteger(error?.statusCode) && error.statusCode === 404) {
    return PRE_TRANSCRIBE_SKIP_REASONS.AUDIO_RECORD_NOT_FOUND;
  }

  return '';
}

function normalizeAiUsageInt(value, fallback = null) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (isNonEmptyString(value) && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeAiUsageCost(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Number(value.toFixed(6));
  }

  if (isNonEmptyString(value) && /^[0-9]+([.,][0-9]+)?$/.test(value.trim())) {
    const parsed = Number.parseFloat(value.trim().replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Number(parsed.toFixed(6));
    }
  }

  return null;
}

function normalizeAiUsagePayload(rawUsage = {}, fallback = {}) {
  const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
  const defaults = fallback && typeof fallback === 'object' ? fallback : {};

  return {
    xRequestId: isNonEmptyString(usage.xRequestId)
      ? usage.xRequestId.trim()
      : (isNonEmptyString(defaults.xRequestId) ? defaults.xRequestId.trim() : ''),
    callEventId: normalizeAiUsageInt(usage.callEventId, normalizeAiUsageInt(defaults.callEventId, null)),
    callId: isNonEmptyString(usage.callId)
      ? usage.callId.trim().slice(0, 256)
      : (isNonEmptyString(defaults.callId) ? defaults.callId.trim().slice(0, 256) : ''),
    operation: isNonEmptyString(usage.operation)
      ? usage.operation.trim()
      : (isNonEmptyString(defaults.operation) ? defaults.operation.trim() : 'transcribe'),
    model: isNonEmptyString(usage.model)
      ? usage.model.trim()
      : (isNonEmptyString(defaults.model) ? defaults.model.trim() : ''),
    provider: isNonEmptyString(usage.provider)
      ? usage.provider.trim()
      : (isNonEmptyString(defaults.provider) ? defaults.provider.trim() : 'polza'),
    promptTokens: normalizeAiUsageInt(usage.promptTokens, normalizeAiUsageInt(defaults.promptTokens, null)),
    completionTokens: normalizeAiUsageInt(
      usage.completionTokens,
      normalizeAiUsageInt(defaults.completionTokens, null)
    ),
    totalTokens: normalizeAiUsageInt(usage.totalTokens, normalizeAiUsageInt(defaults.totalTokens, null)),
    transcriptCharsRaw: normalizeAiUsageInt(
      usage.transcriptCharsRaw,
      normalizeAiUsageInt(defaults.transcriptCharsRaw, null)
    ),
    transcriptCharsSent: normalizeAiUsageInt(
      usage.transcriptCharsSent,
      normalizeAiUsageInt(defaults.transcriptCharsSent, null)
    ),
    durationMs: normalizeAiUsageInt(usage.durationMs, normalizeAiUsageInt(defaults.durationMs, null)),
    responseStatus: isNonEmptyString(usage.responseStatus)
      ? usage.responseStatus.trim()
      : (isNonEmptyString(defaults.responseStatus) ? defaults.responseStatus.trim() : 'failed'),
    skipReason: isNonEmptyString(usage.skipReason)
      ? usage.skipReason.trim()
      : (isNonEmptyString(defaults.skipReason) ? defaults.skipReason.trim() : ''),
    estimatedCostRub: normalizeAiUsageCost(usage.estimatedCostRub) ?? normalizeAiUsageCost(defaults.estimatedCostRub),
    createdAt: isNonEmptyString(usage.createdAt)
      ? usage.createdAt.trim()
      : (isNonEmptyString(defaults.createdAt) ? defaults.createdAt.trim() : '')
  };
}

async function appendAiUsageAuditSafely(pool, logger, payload) {
  const record = normalizeAiUsagePayload(payload, {});

  try {
    await pool.query(
      `
      INSERT INTO ai_usage_audit (
        x_request_id,
        call_event_id,
        call_id,
        operation,
        model,
        provider,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        transcript_chars_raw,
        transcript_chars_sent,
        duration_ms,
        response_status,
        skip_reason,
        estimated_cost_rub,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, COALESCE($16::timestamptz, NOW())
      )
      `,
      [
        record.xRequestId || null,
        record.callEventId,
        record.callId || null,
        record.operation || 'transcribe',
        record.model || null,
        record.provider || null,
        record.promptTokens,
        record.completionTokens,
        record.totalTokens,
        record.transcriptCharsRaw,
        record.transcriptCharsSent,
        record.durationMs,
        record.responseStatus || 'failed',
        record.skipReason || null,
        record.estimatedCostRub,
        isNonEmptyString(record.createdAt) ? record.createdAt : null
      ]
    );
  } catch (error) {
    logger.warn('ai_usage_audit_write_failed', {
      requestId: record.xRequestId,
      callId: record.callId || '',
      operation: record.operation || '',
      error: serializeError(error)
    });
  }
}

function normalizeProcessStatus(processCallBody) {
  const raw = processCallBody && typeof processCallBody === 'object'
    ? processCallBody.status
    : '';

  if (!isNonEmptyString(raw)) {
    return 'processed';
  }

  const normalized = raw.trim().toLowerCase();
  if (['processed', 'duplicate', 'ignored'].includes(normalized)) {
    return normalized;
  }

  return 'processed';
}

async function processCandidate({
  record,
  config,
  logger,
  pool,
  stats
}) {
  const requestId = `tele2-poll-${crypto.randomUUID()}`;
  const recordFileName = normalizeRecordFileName(record?.recordFileName);
  const callId = recordFileName || '';

  if (!recordFileName) {
    stats.skipped += 1;
    logger.warn('tele2_poll_candidate_skipped', {
      requestId,
      reason: PRE_TRANSCRIBE_SKIP_REASONS.MISSING_RECORD_FILE_NAME
    });

    await appendAiUsageAuditSafely(pool, logger, {
      xRequestId: requestId,
      callId,
      operation: 'transcribe',
      responseStatus: 'skipped',
      skipReason: PRE_TRANSCRIBE_SKIP_REASONS.MISSING_RECORD_FILE_NAME
    });

    return;
  }

  let dedupReserved = false;

  if (config.dryRun) {
    const existing = await getDedupStatus(pool, recordFileName);
    const canRetryFailed = config.retryFailed && existing?.status === 'failed';
    const canRetrySkipped = shouldRetrySkippedByErrorCode(existing, config.retrySkippedErrorCodes);

    if (existing && !canRetryFailed && !canRetrySkipped) {
      stats.dedupSkipped += 1;
      logger.info('tele2_poll_candidate_duplicate', {
        recordFileName,
        dedupStatus: existing.status,
        requestId,
        dryRun: true
      });
      logger.info('cost_guard_dedup_skip', {
        requestId,
        callId,
        stage: 'before_transcribe',
        reason: PRE_TRANSCRIBE_SKIP_REASONS.DUPLICATE_EVENT_DRY_RUN,
        dedupStatus: existing.status,
        requestedOverrideModel: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : ''
      });
      await appendAiUsageAuditSafely(pool, logger, {
        xRequestId: requestId,
        callId,
        operation: 'transcribe',
        responseStatus: 'skipped',
        skipReason: PRE_TRANSCRIBE_SKIP_REASONS.DUPLICATE_EVENT_DRY_RUN
      });
      return;
    }
  } else {
    const lock = await reserveDedupRecord(pool, {
      recordFileName,
      retryFailed: config.retryFailed,
      retrySkippedErrorCodes: config.retrySkippedErrorCodes
    });

    if (!lock.acquired) {
      stats.dedupSkipped += 1;
      logger.info('tele2_poll_candidate_duplicate', {
        recordFileName,
        dedupStatus: lock.previousStatus,
        requestId,
        dryRun: false
      });
      logger.info('cost_guard_dedup_skip', {
        requestId,
        callId,
        stage: 'before_transcribe',
        reason: PRE_TRANSCRIBE_SKIP_REASONS.DUPLICATE_EVENT,
        dedupStatus: lock.previousStatus,
        requestedOverrideModel: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : ''
      });
      await appendAiUsageAuditSafely(pool, logger, {
        xRequestId: requestId,
        callId,
        operation: 'transcribe',
        responseStatus: 'skipped',
        skipReason: PRE_TRANSCRIBE_SKIP_REASONS.DUPLICATE_EVENT
      });
      return;
    }

    dedupReserved = true;
  }

  let phone = resolvePhoneFromRecord(record);
  let callDateTime = pickFirstNonEmptyString([
    record?.date,
    record?.callDateTime
  ]);

  if (!phone || !callDateTime) {
    const statusFallback = await getDedupStatus(pool, recordFileName);
    if (!phone && isNonEmptyString(statusFallback?.phone_raw)) {
      phone = statusFallback.phone_raw.trim();
    }
    if (!callDateTime && isNonEmptyString(statusFallback?.call_datetime_raw)) {
      callDateTime = statusFallback.call_datetime_raw.trim();
    }
  }

  if (!phone || !callDateTime) {
    stats.skipped += 1;
    logger.warn('tele2_poll_candidate_skipped', {
      recordFileName,
      requestId,
      reason: !phone
        ? PRE_TRANSCRIBE_SKIP_REASONS.UNUSABLE_METADATA_MISSING_PHONE
        : PRE_TRANSCRIBE_SKIP_REASONS.UNUSABLE_METADATA_MISSING_CALL_DATETIME
    });

    await appendAiUsageAuditSafely(pool, logger, {
      xRequestId: requestId,
      callId,
      operation: 'transcribe',
      responseStatus: 'skipped',
      skipReason: !phone
        ? PRE_TRANSCRIBE_SKIP_REASONS.UNUSABLE_METADATA_MISSING_PHONE
        : PRE_TRANSCRIBE_SKIP_REASONS.UNUSABLE_METADATA_MISSING_CALL_DATETIME
    });

    if (dedupReserved) {
      await finalizeDedupRecord(pool, {
        recordFileName,
        status: 'skipped',
        phoneRaw: phone,
        callDateTimeRaw: callDateTime,
        errorCode: !phone ? 'MISSING_PHONE' : 'MISSING_CALL_DATETIME',
        errorMessage: !phone
          ? 'Cannot resolve phone from Tele2 record metadata'
          : 'Cannot resolve callDateTime from Tele2 record metadata'
      });
    }

    return;
  }

  if (await isPhoneIgnoredPreTranscribe(pool, phone)) {
    stats.skipped += 1;
    stats.ignored += 1;

    logger.info('tele2_poll_candidate_skipped', {
      recordFileName,
      requestId,
      reason: PRE_TRANSCRIBE_SKIP_REASONS.INTERNAL_OR_IGNORED_PHONE
    });

    await appendAiUsageAuditSafely(pool, logger, {
      xRequestId: requestId,
      callId,
      operation: 'transcribe',
      responseStatus: 'skipped',
      skipReason: PRE_TRANSCRIBE_SKIP_REASONS.INTERNAL_OR_IGNORED_PHONE
    });

    if (dedupReserved) {
      await finalizeDedupRecord(pool, {
        recordFileName,
        status: 'ignored',
        phoneRaw: phone,
        callDateTimeRaw: callDateTime,
        processStatus: 'ignored',
        errorCode: 'INTERNAL_OR_IGNORED_PHONE',
        errorMessage: 'Phone is in ignore_list and skipped before transcription'
      });
    }

    return;
  }

  const conversationGate = evaluateConversationGate(record);
  if (!conversationGate.shouldAnalyze) {
    stats.skipped += 1;

    if (
      conversationGate.reason === PRE_TRANSCRIBE_SKIP_REASONS.MISSED_CALL ||
      conversationGate.reason === PRE_TRANSCRIBE_SKIP_REASONS.OUTGOING_UNANSWERED
    ) {
      stats.skippedMissed += 1;
    } else if (conversationGate.reason === PRE_TRANSCRIBE_SKIP_REASONS.SHORT_CONVERSATION_LE_10S) {
      stats.skippedShortConversation += 1;
    } else if (conversationGate.reason === PRE_TRANSCRIBE_SKIP_REASONS.MISSING_CONVERSATION_DURATION) {
      stats.skippedMissingDuration += 1;
    }

    logger.info('tele2_poll_candidate_skipped', {
      recordFileName,
      requestId,
      reason: conversationGate.reason,
      durationSeconds: conversationGate.durationSeconds,
      durationSourceField: conversationGate.durationSourceField,
      thresholdSeconds: MIN_CONVERSATION_DURATION_SECONDS
    });

    await appendAiUsageAuditSafely(pool, logger, {
      xRequestId: requestId,
      callId,
      operation: 'transcribe',
      responseStatus: 'skipped',
      skipReason: conversationGate.reason
    });

    if (dedupReserved) {
      await finalizeDedupRecord(pool, {
        recordFileName,
        status: 'skipped',
        phoneRaw: phone,
        callDateTimeRaw: callDateTime,
        errorCode: conversationGate.errorCode,
        errorMessage: conversationGate.errorMessage
      });
    }

    return;
  }

  let audio = null;

  try {
    const downloadResult = await downloadTele2AudioWithRetry({
      recordFileName,
      t2BaseUrl: config.t2BaseUrl,
      t2Token: config.t2Token,
      t2AuthScheme: config.t2AuthScheme,
      timeoutMs: config.timeoutMs,
      logger,
      requestId,
      attempts: config.downloadRetryAttempts,
      baseBackoffMs: config.downloadRetryBackoffMs
    });
    audio = downloadResult.audio;

    stats.downloaded += 1;
    if (downloadResult.attemptsUsed > 1) {
      stats.downloadRetried += 1;
    }
    logger.info('tele2_poll_candidate_downloaded', {
      recordFileName,
      audioBytes: audio.sizeBytes,
      contentType: audio.contentType,
      phoneLast4: phoneLast4(phone),
      downloadAttemptsUsed: downloadResult.attemptsUsed
    });

    if (audio.sizeBytes < config.minAudioBytes) {
      stats.skipped += 1;
      logger.warn('tele2_poll_candidate_skipped', {
        recordFileName,
        requestId,
        reason: PRE_TRANSCRIBE_SKIP_REASONS.AUDIO_TOO_SMALL,
        audioBytes: audio.sizeBytes,
        minAudioBytes: config.minAudioBytes
      });

      await appendAiUsageAuditSafely(pool, logger, {
        xRequestId: requestId,
        callId,
        operation: 'transcribe',
        responseStatus: 'skipped',
        skipReason: PRE_TRANSCRIBE_SKIP_REASONS.AUDIO_TOO_SMALL
      });

      if (dedupReserved) {
        await finalizeDedupRecord(pool, {
          recordFileName,
          status: 'skipped',
          phoneRaw: phone,
          callDateTimeRaw: callDateTime,
          errorCode: 'AUDIO_TOO_SMALL',
          errorMessage: `Audio is smaller than threshold ${config.minAudioBytes} bytes`
        });
      }

      return;
    }

    const primaryAttempt = await runTranscriptionWithRetry({
      tempFilePath: audio.tempFilePath,
      recordFileName,
      requestId,
      callId,
      aiGatewayUrl: config.aiGatewayUrl,
      aiGatewaySecret: config.aiGatewaySecret,
      aiGatewayTranscribePath: config.aiGatewayTranscribePath,
      transcribeModel: config.transcribeModel,
      timeoutMs: config.timeoutMs,
      logger,
      attempts: config.transcribeRetryAttempts,
      baseBackoffMs: config.transcribeRetryBackoffMs
    });

    if (!primaryAttempt.ok) {
      for (const attemptResult of primaryAttempt.outcomes) {
        const normalizedOutcome = attemptResult?.outcome || {};
        const attemptError = attemptResult?.error || {};

        await appendAiUsageAuditSafely(
          pool,
          logger,
          normalizeAiUsagePayload(attemptError.aiUsage, {
            xRequestId: requestId,
            callId,
            operation: 'transcribe',
            model: normalizedOutcome.model,
            provider: 'polza',
            responseStatus: 'failed',
            durationMs: normalizedOutcome.durationMs,
            skipReason: ''
          })
        );
      }

      const finalError = primaryAttempt.error || new Error('Primary transcription failed');
      finalError.transcriptionOutcomes = primaryAttempt.outcomes.map((item, index) => ({
        attempt: Number.isSafeInteger(item?.attempt) ? item.attempt : index + 1,
        status: isNonEmptyString(item?.outcome?.status)
          ? item.outcome.status.trim()
          : (item?.ok ? 'success' : 'failed'),
        model: isNonEmptyString(item?.outcome?.model) ? item.outcome.model.trim() : '',
        errorCode: isNonEmptyString(item?.outcome?.errorCode)
          ? item.outcome.errorCode.trim()
          : (isNonEmptyString(item?.error?.code) ? item.error.code.trim() : ''),
        statusCode: Number.isInteger(item?.outcome?.statusCode)
          ? item.outcome.statusCode
          : (Number.isInteger(item?.error?.statusCode) ? item.error.statusCode : null),
        durationMs: Number.isSafeInteger(item?.outcome?.durationMs) ? item.outcome.durationMs : null,
        transcriptLength: Number.isSafeInteger(item?.outcome?.transcriptLength)
          ? item.outcome.transcriptLength
          : 0,
        errorMessage: isNonEmptyString(item?.outcome?.errorMessage)
          ? truncateMessage(item.outcome.errorMessage, 180)
          : '',
        errorDetails: item?.outcome?.errorDetails && typeof item.outcome.errorDetails === 'object'
          ? item.outcome.errorDetails
          : null
      }));
      finalError.transcriptionAttempts = primaryAttempt.outcomes.length;
      finalError.transcribeRequestedModel = isNonEmptyString(config.transcribeModel) ? config.transcribeModel : '';
      finalError.transcribeGatewayPath = config.aiGatewayTranscribePath;
      finalError.audioBytes = Number.isSafeInteger(audio?.sizeBytes) ? audio.sizeBytes : null;
      finalError.audioContentType = isNonEmptyString(audio?.contentType) ? audio.contentType : '';
      finalError.conversationDurationSeconds = conversationGate.durationSeconds;
      throw finalError;
    }

    const transcription = primaryAttempt.result;

    let successfulTranscribeOutcome = null;
    for (const attemptResult of primaryAttempt.outcomes) {
      const normalizedOutcome = attemptResult?.outcome || {};
      if (attemptResult.ok && !successfulTranscribeOutcome) {
        successfulTranscribeOutcome = normalizedOutcome;
      }

      await appendAiUsageAuditSafely(
        pool,
        logger,
        normalizeAiUsagePayload(attemptResult?.ok ? attemptResult?.result?.aiUsage : attemptResult?.error?.aiUsage, {
          xRequestId: requestId,
          callId,
          operation: 'transcribe',
          model: normalizedOutcome.model,
          provider: 'polza',
          responseStatus: attemptResult.ok ? 'success' : 'failed',
          durationMs: normalizedOutcome.durationMs
        })
      );
    }

    stats.transcribed += 1;
    if (primaryAttempt.outcomes.length > 1) {
      stats.transcribeRetried += 1;
    }
    logger.info('tele2_poll_candidate_transcribed', {
      recordFileName,
      transcriptLength: transcription.transcript.length,
      model: transcription.model || 'unknown',
      durationMs: successfulTranscribeOutcome?.durationMs ?? null,
      requestedModel: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : '',
      phoneLast4: phoneLast4(phone),
      transcribeAttemptsUsed: primaryAttempt.outcomes.length
    });

    let compareAttempt = null;
    if (isNonEmptyString(config.compareTranscribeModel)) {
      compareAttempt = await runTranscriptionAttempt({
        tempFilePath: audio.tempFilePath,
        recordFileName,
        requestId,
        callId,
        aiGatewayUrl: config.aiGatewayUrl,
        aiGatewaySecret: config.aiGatewaySecret,
        aiGatewayTranscribePath: config.aiGatewayTranscribePath,
        transcribeModel: config.compareTranscribeModel,
        timeoutMs: config.timeoutMs
      });

      stats.compareAttempted += 1;
      if (compareAttempt.outcome.status === 'success') {
        stats.compareSuccess += 1;
      } else if (compareAttempt.outcome.status === 'empty') {
        stats.compareEmpty += 1;
      } else {
        stats.compareFailed += 1;
      }

      logger.info('tele2_poll_candidate_compare_result', {
        recordFileName,
        compareStatus: compareAttempt.outcome.status,
        compareModel: compareAttempt.outcome.model,
        compareTranscriptLength: compareAttempt.outcome.transcriptLength,
        compareDurationMs: compareAttempt.outcome.durationMs,
        comparePreview: compareAttempt.outcome.preview,
        compareErrorCode: compareAttempt.outcome.errorCode || '',
        phoneLast4: phoneLast4(phone)
      });

      if (compareAttempt.ok) {
        await appendAiUsageAuditSafely(
          pool,
          logger,
          normalizeAiUsagePayload(compareAttempt.result.aiUsage, {
            xRequestId: requestId,
            callId,
            operation: 'transcribe',
            model: compareAttempt.outcome.model,
            provider: 'polza',
            responseStatus: 'success',
            durationMs: compareAttempt.outcome.durationMs
          })
        );
      } else {
        await appendAiUsageAuditSafely(
          pool,
          logger,
          normalizeAiUsagePayload(compareAttempt.error?.aiUsage, {
            xRequestId: requestId,
            callId,
            operation: 'transcribe',
            model: compareAttempt.outcome.model,
            provider: 'polza',
            responseStatus: 'failed',
            durationMs: compareAttempt.outcome.durationMs
          })
        );
      }
    }

    if (config.dryRun) {
      stats.dryRunReady += 1;
      logger.info('tele2_poll_candidate_dry_run_ready', {
        recordFileName,
        phoneLast4: phoneLast4(phone),
        callDateTime,
        transcriptLength: transcription.transcript.length,
        model: transcription.model || 'unknown',
        compareStatus: compareAttempt?.outcome?.status || '',
        compareModel: compareAttempt?.outcome?.model || ''
      });
      return;
    }

    const processCallPayload = buildProcessCallPayload({
      record,
      phone,
      callDateTime,
      transcript: transcription.transcript
    });

    const processCallResult = await sendProcessCall({
      processUrl: config.processUrl,
      ingestSecret: config.ingestSecret,
      requestId,
      payload: processCallPayload,
      timeoutMs: config.timeoutMs
    });

    const processStatus = normalizeProcessStatus(processCallResult.body);
    if (processStatus === 'processed') {
      stats.processed += 1;
    } else if (processStatus === 'duplicate') {
      stats.processDuplicates += 1;
    } else if (processStatus === 'ignored') {
      stats.ignored += 1;
    }

    await finalizeDedupRecord(pool, {
      recordFileName,
      status: processStatus,
      phoneRaw: phone,
      callDateTimeRaw: callDateTime,
      transcriptLength: transcription.transcript.length,
      processStatus
    });

    logger.info('tele2_poll_candidate_processed', {
      recordFileName,
      requestId,
      processStatus,
      processStatusCode: processCallResult.statusCode,
      phoneLast4: phoneLast4(phone),
      transcriptLength: transcription.transcript.length
    });
  } catch (error) {
    const errorCode = isNonEmptyString(error?.code) ? error.code.trim() : 'TELE2_POLL_RECORD_FAILED';
    const errorMessage = truncateMessage(error?.message || 'Unknown error');
    const emptyDiagnostics = isEmptyTranscriptionCode(errorCode)
      ? buildEmptyTranscriptionDiagnostics({
        recordFileName,
        requestId,
        error,
        audio,
        conversationDurationSeconds: conversationGate.durationSeconds,
        requestedModel: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : '',
        aiGatewayTranscribePath: config.aiGatewayTranscribePath
      })
      : null;
    const errorMessageForDedup = emptyDiagnostics
      ? buildEmptyTranscriptionErrorMessage(emptyDiagnostics)
      : errorMessage;

    if (shouldMarkAsSkipped(error)) {
      stats.skipped += 1;
    } else {
      stats.failed += 1;
    }

    logger.error('tele2_poll_candidate_failed', {
      recordFileName,
      requestId,
      errorCode,
      errorMessage,
      phoneLast4: phoneLast4(phone),
      error: serializeError(error)
    });

    if (emptyDiagnostics) {
      logger.warn('tele2_poll_empty_transcription_diagnostics', emptyDiagnostics);
    }

    const preTranscribeSkipReason = resolvePreTranscribeSkipReasonFromError(error);
    if (preTranscribeSkipReason) {
      await appendAiUsageAuditSafely(pool, logger, {
        xRequestId: requestId,
        callId,
        operation: 'transcribe',
        responseStatus: 'skipped',
        skipReason: preTranscribeSkipReason
      });
    } else if (
      errorCode.startsWith('T2_')
      || errorCode === 'REQUEST_TIMEOUT'
      || errorCode === 'TELE2_POLL_RECORD_FAILED'
    ) {
      await appendAiUsageAuditSafely(pool, logger, {
        xRequestId: requestId,
        callId,
        operation: 'transcribe',
        responseStatus: 'failed',
        skipReason: `download_or_pretranscribe_error:${errorCode}`
      });
    }

    if (dedupReserved) {
      await finalizeDedupRecord(pool, {
        recordFileName,
        status: shouldMarkAsSkipped(error) ? 'skipped' : 'failed',
        phoneRaw: phone,
        callDateTimeRaw: callDateTime,
        errorCode,
        errorMessage: errorMessageForDedup
      });
    }
  } finally {
    if (audio?.tempFilePath) {
      try {
        fs.unlinkSync(audio.tempFilePath);
      } catch (error) {
        logger.warn('tele2_poll_audio_cleanup_failed', {
          recordFileName,
          tempFilePath: audio.tempFilePath
        });
      }
    }
  }
}

function buildDefaultsFromEnv() {
  return {
    recordFileNames: [],
    t2BaseUrl: process.env.T2_API_BASE_URL || DEFAULT_T2_BASE_URL,
    t2Token: process.env.T2_API_TOKEN || process.env.T2_ACCESS_TOKEN || '',
    t2AuthScheme: process.env.T2_AUTH_SCHEME || 'plain',
    timeoutMs: parsePositiveInt(process.env.T2_API_TIMEOUT_MS, 'T2_API_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    lookbackMinutes: parsePositiveInt(
      process.env.TELE2_POLL_LOOKBACK_MINUTES,
      'TELE2_POLL_LOOKBACK_MINUTES',
      DEFAULT_LOOKBACK_MINUTES
    ),
    fetchLimit: parsePositiveInt(
      process.env.TELE2_POLL_FETCH_LIMIT,
      'TELE2_POLL_FETCH_LIMIT',
      DEFAULT_FETCH_LIMIT
    ),
    maxCandidates: parsePositiveInt(
      process.env.TELE2_POLL_MAX_CANDIDATES,
      'TELE2_POLL_MAX_CANDIDATES',
      DEFAULT_MAX_CANDIDATES
    ),
    minAudioBytes: parsePositiveInt(
      process.env.TELE2_POLL_MIN_AUDIO_BYTES,
      'TELE2_POLL_MIN_AUDIO_BYTES',
      DEFAULT_MIN_AUDIO_BYTES
    ),
    downloadRetryAttempts: parsePositiveInt(
      process.env.TELE2_POLL_DOWNLOAD_RETRY_ATTEMPTS,
      'TELE2_POLL_DOWNLOAD_RETRY_ATTEMPTS',
      DEFAULT_DOWNLOAD_RETRY_ATTEMPTS
    ),
    downloadRetryBackoffMs: parsePositiveInt(
      process.env.TELE2_POLL_DOWNLOAD_RETRY_BACKOFF_MS,
      'TELE2_POLL_DOWNLOAD_RETRY_BACKOFF_MS',
      DEFAULT_DOWNLOAD_RETRY_BACKOFF_MS
    ),
    transcribeRetryAttempts: parsePositiveInt(
      process.env.TELE2_POLL_TRANSCRIBE_RETRY_ATTEMPTS,
      'TELE2_POLL_TRANSCRIBE_RETRY_ATTEMPTS',
      DEFAULT_TRANSCRIBE_RETRY_ATTEMPTS
    ),
    transcribeRetryBackoffMs: parsePositiveInt(
      process.env.TELE2_POLL_TRANSCRIBE_RETRY_BACKOFF_MS,
      'TELE2_POLL_TRANSCRIBE_RETRY_BACKOFF_MS',
      DEFAULT_TRANSCRIBE_RETRY_BACKOFF_MS
    ),
    replayFetchLimit: parsePositiveInt(
      process.env.TELE2_POLL_REPLAY_FETCH_LIMIT,
      'TELE2_POLL_REPLAY_FETCH_LIMIT',
      DEFAULT_REPLAY_FETCH_LIMIT
    ),
    retrySkippedErrorCodes: parseErrorCodeList(process.env.TELE2_POLL_RETRY_SKIPPED_ERROR_CODES || ''),
    dryRun: parseBoolean(process.env.TELE2_POLL_DRY_RUN, false),
    retryFailed: parseBoolean(process.env.TELE2_POLL_RETRY_FAILED, true),
    timezoneOffset: process.env.T2_TIMEZONE_OFFSET || DEFAULT_TIMEZONE_OFFSET,
    aiGatewayUrl: process.env.AI_GATEWAY_URL || DEFAULT_AI_GATEWAY_URL,
    aiGatewaySecret: process.env.AI_GATEWAY_SHARED_SECRET || '',
    aiGatewayTranscribePath: process.env.AI_GATEWAY_TRANSCRIBE_PATH || '/transcribe',
    transcribeModel: process.env.TELE2_POLL_TRANSCRIBE_MODEL || '',
    compareTranscribeModel: process.env.TELE2_POLL_COMPARE_TRANSCRIBE_MODEL || '',
    processUrl: process.env.PROCESS_CALL_URL || DEFAULT_PROCESS_URL,
    ingestSecret: process.env.INGEST_SHARED_SECRET || '',
    logLevel: process.env.LOG_LEVEL || 'info'
  };
}

function validateRuntimeConfig(rawConfig) {
  if (!isNonEmptyString(rawConfig.t2Token)) {
    throw new Error('T2_API_TOKEN (or T2_ACCESS_TOKEN) is required');
  }

  if (!isNonEmptyString(rawConfig.aiGatewaySecret)) {
    throw new Error('AI_GATEWAY_SHARED_SECRET is required');
  }

  if (!isNonEmptyString(rawConfig.t2BaseUrl)) {
    throw new Error('T2_API_BASE_URL is required');
  }

  if (!isNonEmptyString(rawConfig.aiGatewayUrl)) {
    throw new Error('AI_GATEWAY_URL is required');
  }

  if (!isNonEmptyString(rawConfig.processUrl)) {
    throw new Error('PROCESS_CALL_URL is required');
  }

  const authScheme = rawConfig.t2AuthScheme.trim().toLowerCase();
  if (!['plain', 'bearer'].includes(authScheme)) {
    throw new Error('T2_AUTH_SCHEME must be "plain" or "bearer"');
  }

  const offsetMeta = validateTimeZoneOffset(rawConfig.timezoneOffset);

  const transcribePath = isNonEmptyString(rawConfig.aiGatewayTranscribePath)
    ? rawConfig.aiGatewayTranscribePath.trim()
    : '/transcribe';
  const transcribeModel = isNonEmptyString(rawConfig.transcribeModel)
    ? rawConfig.transcribeModel.trim()
    : '';
  const compareTranscribeModel = isNonEmptyString(rawConfig.compareTranscribeModel)
    ? rawConfig.compareTranscribeModel.trim()
    : '';

  if (isNonEmptyString(compareTranscribeModel) && !rawConfig.dryRun) {
    throw new Error('compare-transcribe-model is allowed only with --dry-run to keep production flow safe');
  }

  const normalizedConfig = {
    ...rawConfig,
    recordFileNames: Array.isArray(rawConfig.recordFileNames)
      ? Array.from(
        new Set(
          rawConfig.recordFileNames
            .map((item) => normalizeRecordFileName(item))
            .filter(Boolean)
        )
      )
      : [],
    retrySkippedErrorCodes: new Set(
      Array.isArray(rawConfig.retrySkippedErrorCodes)
        ? rawConfig.retrySkippedErrorCodes
          .map((item) => normalizeErrorCodeToken(item))
          .filter(Boolean)
        : []
    ),
    t2AuthScheme: authScheme,
    t2BaseUrl: rawConfig.t2BaseUrl.trim(),
    t2Token: rawConfig.t2Token.trim(),
    aiGatewayUrl: rawConfig.aiGatewayUrl.trim(),
    aiGatewaySecret: rawConfig.aiGatewaySecret.trim(),
    aiGatewayTranscribePath: transcribePath.startsWith('/') ? transcribePath : `/${transcribePath}`,
    transcribeModel,
    compareTranscribeModel,
    processUrl: rawConfig.processUrl.trim(),
    ingestSecret: isNonEmptyString(rawConfig.ingestSecret) ? rawConfig.ingestSecret.trim() : '',
    offsetMeta
  };

  try {
    new URL(normalizedConfig.t2BaseUrl);
    new URL(normalizedConfig.aiGatewayUrl);
    new URL(normalizedConfig.processUrl);
  } catch (error) {
    throw new Error('T2_API_BASE_URL, AI_GATEWAY_URL and PROCESS_CALL_URL must be valid URLs');
  }

  return normalizedConfig;
}

function printHelp() {
  process.stdout.write(`
Tele2 poll-once command (manual, no scheduler)

Usage:
  node src/scripts/pollTele2RecordsOnce.js [options]

Options:
  --dry-run                          Run full fetch/download/transcribe flow, skip /api/process-call
  --no-dry-run                       Force live mode (default)
  --record-file-name <value>         Replay explicit recordFileName (repeatable, supports comma list)
  --lookback-minutes <int>           Lookback window for call-records/info
  --fetch-limit <int>                Tele2 info page size
  --max-candidates <int>             Max unique records to process from fetched list
  --min-audio-bytes <int>            Skip too-small audio files
  --download-retry-attempts <int>    Retry attempts for Tele2 file download (default: ${DEFAULT_DOWNLOAD_RETRY_ATTEMPTS})
  --download-retry-backoff-ms <int>  Base backoff for Tele2 file retry (default: ${DEFAULT_DOWNLOAD_RETRY_BACKOFF_MS})
  --transcribe-retry-attempts <int>  Retry attempts for transcription errors (default: ${DEFAULT_TRANSCRIBE_RETRY_ATTEMPTS})
  --transcribe-retry-backoff-ms <int> Base backoff for transcription retry (default: ${DEFAULT_TRANSCRIBE_RETRY_BACKOFF_MS})
  --retry-skipped-error-codes <csv>  Allow replay of skipped records by last_error_code (example: POLZA_EMPTY_TRANSCRIPTION)
  --replay-fetch-limit <int>         Tele2 info page size used in replay mode (default: ${DEFAULT_REPLAY_FETCH_LIMIT})
                                     Calls are analyzed only when conversation duration > 10 seconds
                                     and call is not marked as unanswered/missed by Tele2 metadata.
  --timeout-ms <int>                 HTTP timeout in ms
  --retry-failed / --no-retry-failed Retry records with failed dedup status
  --timezone-offset <+HH:MM|-HH:MM>  Offset for Tele2 info window
  --t2-base-url <url>                Tele2 OpenAPI base URL
  --t2-token <value>                 Tele2 access token
  --t2-auth-scheme <plain|bearer>    Tele2 auth scheme (default: plain)
  --ai-gateway-url <url>             ai-gateway base URL
  --ai-gateway-secret <value>        ai-gateway shared secret
  --ai-gateway-transcribe-path <p>   Transcribe path (default: /transcribe)
  --transcribe-model <model>         Optional primary model override (example: openai/gpt-4o-mini-transcribe)
  --compare-transcribe-model <m>     Optional compare model (dry-run only, example: openai/whisper-1 or "candidate")
  --process-url <url>                process-call URL
  --ingest-secret <value>            Optional X-Ingest-Secret for process-call
  --help                             Show this help
`);
}

async function main() {
  const defaults = buildDefaultsFromEnv();
  const parsedArgs = parseArgs(process.argv.slice(2), defaults);

  if (parsedArgs.help) {
    printHelp();
    return;
  }

  const config = validateRuntimeConfig(parsedArgs);
  const logger = createLogger({
    level: config.logLevel,
    service: 'tele2-poll-once'
  });

  const appConfig = loadConfig({ validateRuntimeSecrets: false });
  const pool = createPgPool(appConfig.database);

  const window = buildLookbackWindow({
    lookbackMinutes: config.lookbackMinutes,
    offsetMeta: config.offsetMeta
  });

  const stats = {
    fetched: 0,
    candidateRecords: 0,
    selectedRecords: 0,
    replayRequestedRecords: 0,
    replayResolvedRecords: 0,
    replayMissingRecords: 0,
    dedupSkipped: 0,
    downloaded: 0,
    downloadRetried: 0,
    transcribed: 0,
    transcribeRetried: 0,
    compareAttempted: 0,
    compareSuccess: 0,
    compareEmpty: 0,
    compareFailed: 0,
    dryRunReady: 0,
    processed: 0,
    processDuplicates: 0,
    ignored: 0,
    skippedMissed: 0,
    skippedShortConversation: 0,
    skippedMissingDuration: 0,
    skipped: 0,
    failed: 0
  };

  logger.info('tele2_poll_once_started', {
    dryRun: config.dryRun,
    replayMode: config.recordFileNames.length > 0,
    replayRecordCount: config.recordFileNames.length,
    lookbackMinutes: config.lookbackMinutes,
    fetchLimit: config.fetchLimit,
    replayFetchLimit: config.replayFetchLimit,
    maxCandidates: config.maxCandidates,
    minAudioBytes: config.minAudioBytes,
    downloadRetryAttempts: config.downloadRetryAttempts,
    downloadRetryBackoffMs: config.downloadRetryBackoffMs,
    transcribeRetryAttempts: config.transcribeRetryAttempts,
    transcribeRetryBackoffMs: config.transcribeRetryBackoffMs,
    retrySkippedErrorCodes: Array.from(config.retrySkippedErrorCodes),
    minConversationDurationSecondsExclusive: MIN_CONVERSATION_DURATION_SECONDS,
    retryFailed: config.retryFailed,
    transcribeModel: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : '',
    compareTranscribeModel: isNonEmptyString(config.compareTranscribeModel) ? config.compareTranscribeModel : '',
    infoWindowStart: window.start,
    infoWindowEnd: window.end
  });

  try {
    await ensureTele2DedupTable(pool);

    const selected = [];
    let skippedWithoutRecordName = 0;

    if (config.recordFileNames.length > 0) {
      const replaySet = new Set(config.recordFileNames);
      stats.replayRequestedRecords = replaySet.size;

      for (const recordFileName of replaySet) {
        const resolved = await fetchTele2RecordByFileName({
          recordFileName,
          t2BaseUrl: config.t2BaseUrl,
          t2Token: config.t2Token,
          t2AuthScheme: config.t2AuthScheme,
          timeoutMs: config.timeoutMs,
          offsetMeta: config.offsetMeta,
          fetchLimit: config.replayFetchLimit
        });

        if (resolved) {
          stats.replayResolvedRecords += 1;
          selected.push(resolved);
          continue;
        }

        stats.replayMissingRecords += 1;
        selected.push({ recordFileName });
      }

      stats.candidateRecords = selected.length;
      stats.selectedRecords = selected.length;

      logger.info('tele2_poll_once_replay_candidates_built', {
        replayRequestedRecords: stats.replayRequestedRecords,
        replayResolvedRecords: stats.replayResolvedRecords,
        replayMissingRecords: stats.replayMissingRecords
      });
    } else {
      const fetched = await fetchTele2Records({
        t2BaseUrl: config.t2BaseUrl,
        t2Token: config.t2Token,
        t2AuthScheme: config.t2AuthScheme,
        timeoutMs: config.timeoutMs,
        start: window.start,
        end: window.end,
        fetchLimit: config.fetchLimit
      });

      stats.fetched = fetched.length;

      const uniqueRecords = [];
      const seen = new Set();

      for (const item of fetched) {
        const recordFileName = normalizeRecordFileName(item?.recordFileName);
        if (!recordFileName) {
          skippedWithoutRecordName += 1;
          continue;
        }

        if (seen.has(recordFileName)) {
          continue;
        }

        seen.add(recordFileName);
        uniqueRecords.push({
          ...item,
          recordFileName
        });
      }

      stats.candidateRecords = uniqueRecords.length;
      selected.push(...uniqueRecords.slice(0, config.maxCandidates));
      stats.selectedRecords = selected.length;

      logger.info('tele2_poll_once_candidates_built', {
        fetchedCount: stats.fetched,
        candidateRecords: stats.candidateRecords,
        selectedRecords: stats.selectedRecords,
        skippedWithoutRecordName
      });
    }

    for (const record of selected) {
      await processCandidate({
        record,
        config,
        logger,
        pool,
        stats
      });
    }

    if (stats.failed > 0 || stats.skipped > 0) {
      logger.warn('tele2_poll_once_failure_signal_detected', {
        failed: stats.failed,
        skipped: stats.skipped,
        downloadRetried: stats.downloadRetried,
        transcribeRetried: stats.transcribeRetried,
        replayMode: config.recordFileNames.length > 0
      });
    }

    const summary = {
      ok: true,
      dryRun: config.dryRun,
      infoWindow: {
        start: window.start,
        end: window.end
      },
      compareMode: {
        enabled: isNonEmptyString(config.compareTranscribeModel),
        compareModel: isNonEmptyString(config.compareTranscribeModel) ? config.compareTranscribeModel : '',
        primaryModelOverride: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : ''
      },
      stats
    };

    logger.info('tele2_poll_once_finished', summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error?.message || 'Unknown error',
      code: isNonEmptyString(error?.code) ? error.code : '',
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null,
      responseBody: error?.responseBody || null,
      stack: isNonEmptyString(error?.stack) ? error.stack : ''
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  resolvePhoneFromRecord,
  buildProcessCallPayload,
  sendProcessCall,
  downloadTele2AudioWithRetry,
  runTranscriptionWithRetry,
  isRetryableDownloadError,
  isRetryableTranscribeError,
  isEmptyTranscriptionCode,
  classifyEmptyTranscriptionDiagnostics,
  buildEmptyTranscriptionDiagnostics,
  buildEmptyTranscriptionErrorMessage
};
