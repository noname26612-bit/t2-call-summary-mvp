#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createPgPool } = require('../db/createPgPool');
const { createLogger, serializeError } = require('../services/logger');

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

function parseArgs(argv, defaults) {
  const parsed = { ...defaults };
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
  const callType = isNonEmptyString(record?.callType)
    ? record.callType.trim().toUpperCase()
    : '';

  if (callType === 'OUTGOING') {
    return pickFirstNonEmptyString([
      record.destinationNumber,
      record.calleeNumber,
      record.callerNumber,
      record.phone
    ]);
  }

  return pickFirstNonEmptyString([
    record.callerNumber,
    record.destinationNumber,
    record.calleeNumber,
    record.phone
  ]);
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

async function transcribeViaGateway({
  tempFilePath,
  recordFileName,
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
  formData.append('requestId', `tele2-poll-${crypto.randomUUID()}`);
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
      'x-gateway-secret': aiGatewaySecret
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
    audioBytes: Number.isInteger(payload?.audioBytes) ? payload.audioBytes : audioBuffer.length
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

async function runTranscriptionAttempt({
  tempFilePath,
  recordFileName,
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
        statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null
      }
    };
  }
}

async function sendProcessCall({
  processUrl,
  ingestSecret,
  phone,
  callDateTime,
  transcript,
  timeoutMs
}) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (isNonEmptyString(ingestSecret)) {
    headers['X-Ingest-Secret'] = ingestSecret;
  }

  const response = await fetchWithTimeout(processUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      phone,
      callDateTime,
      transcript
    })
  }, timeoutMs);

  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const requestError = new Error(`process-call failed with status ${response.status}`);
    requestError.statusCode = response.status;
    requestError.code = payload?.code || 'PROCESS_CALL_HTTP_ERROR';
    requestError.responseBody = payload || raw;
    throw requestError;
  }

  return {
    statusCode: response.status,
    body: payload || raw
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

async function getDedupStatus(pool, recordFileName) {
  const result = await pool.query(
    `
    SELECT status, attempts
    FROM tele2_polled_records
    WHERE record_file_name = $1
    LIMIT 1
    `,
    [recordFileName]
  );

  return result.rows[0] || null;
}

async function reserveDedupRecord(pool, { recordFileName, retryFailed }) {
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
  return code === 'POLZA_EMPTY_TRANSCRIPTION' || code === 'AI_GATEWAY_EMPTY_TRANSCRIPT';
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
  const recordFileName = normalizeRecordFileName(record?.recordFileName);
  if (!recordFileName) {
    stats.skipped += 1;
    logger.warn('tele2_poll_candidate_skipped', {
      reason: 'missing_record_file_name'
    });
    return;
  }

  let dedupReserved = false;

  if (config.dryRun) {
    const existing = await getDedupStatus(pool, recordFileName);
    if (existing && !(config.retryFailed && existing.status === 'failed')) {
      stats.dedupSkipped += 1;
      logger.info('tele2_poll_candidate_duplicate', {
        recordFileName,
        dedupStatus: existing.status,
        dryRun: true
      });
      return;
    }
  } else {
    const lock = await reserveDedupRecord(pool, {
      recordFileName,
      retryFailed: config.retryFailed
    });

    if (!lock.acquired) {
      stats.dedupSkipped += 1;
      logger.info('tele2_poll_candidate_duplicate', {
        recordFileName,
        dedupStatus: lock.previousStatus,
        dryRun: false
      });
      return;
    }

    dedupReserved = true;
  }

  const phone = resolvePhoneFromRecord(record);
  const callDateTime = pickFirstNonEmptyString([
    record?.date,
    record?.callDateTime
  ]);

  if (!phone || !callDateTime) {
    stats.skipped += 1;
    logger.warn('tele2_poll_candidate_skipped', {
      recordFileName,
      reason: !phone ? 'missing_phone' : 'missing_call_datetime'
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

  let audio = null;

  try {
    audio = await downloadTele2Audio({
      recordFileName,
      t2BaseUrl: config.t2BaseUrl,
      t2Token: config.t2Token,
      t2AuthScheme: config.t2AuthScheme,
      timeoutMs: config.timeoutMs
    });

    stats.downloaded += 1;
    logger.info('tele2_poll_candidate_downloaded', {
      recordFileName,
      audioBytes: audio.sizeBytes,
      contentType: audio.contentType,
      phoneLast4: phoneLast4(phone)
    });

    if (audio.sizeBytes < config.minAudioBytes) {
      stats.skipped += 1;
      logger.warn('tele2_poll_candidate_skipped', {
        recordFileName,
        reason: 'audio_too_small',
        audioBytes: audio.sizeBytes,
        minAudioBytes: config.minAudioBytes
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

    const primaryAttempt = await runTranscriptionAttempt({
      tempFilePath: audio.tempFilePath,
      recordFileName,
      aiGatewayUrl: config.aiGatewayUrl,
      aiGatewaySecret: config.aiGatewaySecret,
      aiGatewayTranscribePath: config.aiGatewayTranscribePath,
      transcribeModel: config.transcribeModel,
      timeoutMs: config.timeoutMs
    });

    if (!primaryAttempt.ok) {
      const primaryError = primaryAttempt.error || new Error('Primary transcription failed');
      if (!isNonEmptyString(primaryError.code) && isNonEmptyString(primaryAttempt.outcome?.errorCode)) {
        primaryError.code = primaryAttempt.outcome.errorCode;
      }

      if (!Number.isInteger(primaryError.statusCode) && Number.isInteger(primaryAttempt.outcome?.statusCode)) {
        primaryError.statusCode = primaryAttempt.outcome.statusCode;
      }

      throw primaryError;
    }

    const transcription = primaryAttempt.result;

    stats.transcribed += 1;
    logger.info('tele2_poll_candidate_transcribed', {
      recordFileName,
      transcriptLength: transcription.transcript.length,
      model: transcription.model || 'unknown',
      durationMs: primaryAttempt.outcome.durationMs,
      requestedModel: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : '',
      phoneLast4: phoneLast4(phone)
    });

    let compareAttempt = null;
    if (isNonEmptyString(config.compareTranscribeModel)) {
      compareAttempt = await runTranscriptionAttempt({
        tempFilePath: audio.tempFilePath,
        recordFileName,
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

    const processCallResult = await sendProcessCall({
      processUrl: config.processUrl,
      ingestSecret: config.ingestSecret,
      phone,
      callDateTime,
      transcript: transcription.transcript,
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
      processStatus,
      processStatusCode: processCallResult.statusCode,
      phoneLast4: phoneLast4(phone),
      transcriptLength: transcription.transcript.length
    });
  } catch (error) {
    const errorCode = isNonEmptyString(error?.code) ? error.code.trim() : 'TELE2_POLL_RECORD_FAILED';
    const errorMessage = truncateMessage(error?.message || 'Unknown error');

    if (shouldMarkAsSkipped(error)) {
      stats.skipped += 1;
    } else {
      stats.failed += 1;
    }

    logger.error('tele2_poll_candidate_failed', {
      recordFileName,
      errorCode,
      errorMessage,
      phoneLast4: phoneLast4(phone),
      error: serializeError(error)
    });

    if (dedupReserved) {
      await finalizeDedupRecord(pool, {
        recordFileName,
        status: shouldMarkAsSkipped(error) ? 'skipped' : 'failed',
        phoneRaw: phone,
        callDateTimeRaw: callDateTime,
        errorCode,
        errorMessage
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
  --lookback-minutes <int>           Lookback window for call-records/info
  --fetch-limit <int>                Tele2 info page size
  --max-candidates <int>             Max unique records to process from fetched list
  --min-audio-bytes <int>            Skip too-small audio files
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
    dedupSkipped: 0,
    downloaded: 0,
    transcribed: 0,
    compareAttempted: 0,
    compareSuccess: 0,
    compareEmpty: 0,
    compareFailed: 0,
    dryRunReady: 0,
    processed: 0,
    processDuplicates: 0,
    ignored: 0,
    skipped: 0,
    failed: 0
  };

  logger.info('tele2_poll_once_started', {
    dryRun: config.dryRun,
    lookbackMinutes: config.lookbackMinutes,
    fetchLimit: config.fetchLimit,
    maxCandidates: config.maxCandidates,
    minAudioBytes: config.minAudioBytes,
    retryFailed: config.retryFailed,
    transcribeModel: isNonEmptyString(config.transcribeModel) ? config.transcribeModel : '',
    compareTranscribeModel: isNonEmptyString(config.compareTranscribeModel) ? config.compareTranscribeModel : '',
    infoWindowStart: window.start,
    infoWindowEnd: window.end
  });

  try {
    await ensureTele2DedupTable(pool);

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
    let skippedWithoutRecordName = 0;

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
    const selected = uniqueRecords.slice(0, config.maxCandidates);
    stats.selectedRecords = selected.length;

    logger.info('tele2_poll_once_candidates_built', {
      fetchedCount: stats.fetched,
      candidateRecords: stats.candidateRecords,
      selectedRecords: stats.selectedRecords,
      skippedWithoutRecordName
    });

    for (const record of selected) {
      await processCandidate({
        record,
        config,
        logger,
        pool,
        stats
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
