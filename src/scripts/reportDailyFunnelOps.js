#!/usr/bin/env node

const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createPgPool } = require('../db/createPgPool');

dotenv.config();

const DEFAULT_TIME_ZONE = process.env.APP_TIMEZONE || 'Europe/Moscow';
const DEFAULT_SOURCE_FETCH_LIMIT = 500;
const DEFAULT_T2_BASE_URL = 'https://ats2.t2.ru/crm/openapi';
const DEFAULT_TIMEZONE_OFFSET = process.env.T2_TIMEZONE_OFFSET || '+03:00';
const RECOVERABLE_ERROR_CODES = new Set([
  'T2_FILE_HTTP_ERROR',
  'POLZA_EMPTY_TRANSCRIPTION',
  'AI_GATEWAY_EMPTY_TRANSCRIPT',
  'REQUEST_TIMEOUT',
  'AI_GATEWAY_TIMEOUT',
  'POLZA_TRANSCRIBE_FAILED',
  'AI_GATEWAY_TRANSCRIBE_HTTP_ERROR'
]);
const POLICY_NON_SENDABLE_SKIP_CODES = new Set([
  'INTERNAL_OR_IGNORED_PHONE',
  'MISSED_CALL',
  'OUTGOING_UNANSWERED',
  'CONVERSATION_DURATION_TOO_SHORT',
  'CONVERSATION_DURATION_MISSING'
]);
const INPUT_NON_SENDABLE_CODES = new Set([
  'MISSING_PHONE',
  'MISSING_CALL_DATETIME',
  'AUDIO_TOO_SMALL',
  'T2_FILE_NOT_AUDIO',
  'AUDIO_RECORD_NOT_FOUND'
]);

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

function buildAuthorizationHeader(token, scheme) {
  if (scheme === 'bearer') {
    return `Bearer ${token}`;
  }

  return token;
}

function resolveUrl(baseUrl, pathname) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return new URL(normalizedPath, normalizedBase);
}

function getTodayDateInTimeZone(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((item) => item.type === 'year')?.value || '1970';
  const month = parts.find((item) => item.type === 'month')?.value || '01';
  const day = parts.find((item) => item.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

function parseArgs(argv) {
  const parsed = {
    date: '',
    timeZone: DEFAULT_TIME_ZONE,
    withSource: true,
    failOnAnomaly: false,
    sourceFetchLimit: DEFAULT_SOURCE_FETCH_LIMIT,
    t2BaseUrl: process.env.T2_API_BASE_URL || DEFAULT_T2_BASE_URL,
    t2Token: process.env.T2_API_TOKEN || process.env.T2_ACCESS_TOKEN || '',
    t2AuthScheme: process.env.T2_AUTH_SCHEME || 'plain',
    timezoneOffset: DEFAULT_TIMEZONE_OFFSET,
    json: true
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg.startsWith('--date=')) {
      parsed.date = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--date') {
      parsed.date = args.shift() || '';
      continue;
    }

    if (arg.startsWith('--timezone=')) {
      parsed.timeZone = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--timezone') {
      parsed.timeZone = args.shift() || parsed.timeZone;
      continue;
    }

    if (arg === '--no-source') {
      parsed.withSource = false;
      continue;
    }

    if (arg === '--with-source') {
      parsed.withSource = true;
      continue;
    }

    if (arg === '--fail-on-anomaly') {
      parsed.failOnAnomaly = true;
      continue;
    }

    if (arg === '--no-fail-on-anomaly') {
      parsed.failOnAnomaly = false;
      continue;
    }

    if (arg.startsWith('--source-fetch-limit=')) {
      parsed.sourceFetchLimit = parsePositiveInt(
        arg.split('=').slice(1).join('='),
        'source-fetch-limit',
        parsed.sourceFetchLimit
      );
      continue;
    }

    if (arg === '--source-fetch-limit') {
      parsed.sourceFetchLimit = parsePositiveInt(
        args.shift(),
        'source-fetch-limit',
        parsed.sourceFetchLimit
      );
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

    if (arg.startsWith('--timezone-offset=')) {
      parsed.timezoneOffset = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--timezone-offset') {
      parsed.timezoneOffset = args.shift() || parsed.timezoneOffset;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '--no-json') {
      parsed.json = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function validateConfig(rawConfig) {
  const normalizedDate = isNonEmptyString(rawConfig.date)
    ? rawConfig.date.trim()
    : getTodayDateInTimeZone(rawConfig.timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error('date must be in YYYY-MM-DD format');
  }

  const authScheme = isNonEmptyString(rawConfig.t2AuthScheme)
    ? rawConfig.t2AuthScheme.trim().toLowerCase()
    : 'plain';
  if (!['plain', 'bearer'].includes(authScheme)) {
    throw new Error('t2-auth-scheme must be "plain" or "bearer"');
  }

  if (!/^[+-][0-9]{2}:[0-9]{2}$/.test(rawConfig.timezoneOffset.trim())) {
    throw new Error('timezone-offset must be in format +HH:MM or -HH:MM');
  }

  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: rawConfig.timeZone.trim() }).format(new Date());
  } catch (error) {
    throw new Error(`Invalid timezone value: ${rawConfig.timeZone}`);
  }

  return {
    ...rawConfig,
    date: normalizedDate,
    timeZone: rawConfig.timeZone.trim(),
    t2BaseUrl: rawConfig.t2BaseUrl.trim(),
    t2Token: isNonEmptyString(rawConfig.t2Token) ? rawConfig.t2Token.trim() : '',
    t2AuthScheme: authScheme,
    timezoneOffset: rawConfig.timezoneOffset.trim()
  };
}

async function fetchTele2SourceCount({
  date,
  t2BaseUrl,
  t2Token,
  t2AuthScheme,
  sourceFetchLimit,
  timezoneOffset
}) {
  if (!isNonEmptyString(t2Token)) {
    return {
      available: false,
      reason: 'missing_t2_token',
      count: null
    };
  }

  const url = resolveUrl(t2BaseUrl, 'call-records/info');
  url.searchParams.set('start', `${date}T00:00:00${timezoneOffset}`);
  url.searchParams.set('end', `${date}T23:59:59${timezoneOffset}`);
  url.searchParams.set('is_recorded', 'true');
  url.searchParams.set('size', String(sourceFetchLimit));
  url.searchParams.set('sort', 'date,DESC');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: buildAuthorizationHeader(t2Token, t2AuthScheme)
    }
  });

  const rawText = await response.text();
  if (!response.ok) {
    return {
      available: false,
      reason: `source_http_${response.status}`,
      count: null
    };
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (error) {
    return {
      available: false,
      reason: 'source_invalid_json',
      count: null
    };
  }

  if (!Array.isArray(payload)) {
    return {
      available: false,
      reason: 'source_invalid_shape',
      count: null
    };
  }

  return {
    available: true,
    reason: '',
    count: payload.length
  };
}

async function loadDbStats(pool, datePrefix) {
  const polledByStatusRows = await pool.query(
    `
    SELECT status, COUNT(*)::int AS count
    FROM tele2_polled_records
    WHERE record_file_name LIKE $1
    GROUP BY status
    ORDER BY status
    `,
    [`${datePrefix}/%`]
  );

  const polledByReasonRows = await pool.query(
    `
    SELECT COALESCE(last_error_code, '(none)') AS reason_code, status, COUNT(*)::int AS count
    FROM tele2_polled_records
    WHERE record_file_name LIKE $1
    GROUP BY status, COALESCE(last_error_code, '(none)')
    ORDER BY status, count DESC
    `,
    [`${datePrefix}/%`]
  );

  const callEventsRows = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'processed')::int AS processed,
      COUNT(*) FILTER (WHERE telegram_status = 'sent')::int AS telegram_sent
    FROM call_events
    WHERE call_datetime_raw LIKE $1
    `,
    [`${datePrefix}%`]
  );

  const aiUsageRows = await pool.query(
    `
    SELECT operation, response_status, COALESCE(skip_reason, '') AS skip_reason, COUNT(*)::int AS count
    FROM ai_usage_audit
    WHERE call_id LIKE $1
    GROUP BY operation, response_status, COALESCE(skip_reason, '')
    ORDER BY operation, response_status, skip_reason
    `,
    [`${datePrefix}/%`]
  );

  const telegramCallRows = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
      COUNT(*) FILTER (WHERE status <> 'sent')::int AS failed
    FROM telegram_deliveries td
    JOIN audit_events ae ON ae.call_event_id = td.call_event_id
    WHERE ae.event_type = 'call_received'
      AND ae.payload->>'externalCallId' LIKE $1
    `,
    [`${datePrefix}/%`]
  );

  const telegramRecipientRows = await pool.query(
    `
    SELECT r->>'chatId' AS chat_id, r->>'status' AS status, COUNT(*)::int AS count
    FROM telegram_deliveries td
    JOIN audit_events ae ON ae.call_event_id = td.call_event_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(td.response_payload->'recipients', '[]'::jsonb)) AS r
    WHERE ae.event_type = 'call_received'
      AND ae.payload->>'externalCallId' LIKE $1
    GROUP BY r->>'chatId', r->>'status'
    ORDER BY chat_id, status
    `,
    [`${datePrefix}/%`]
  );

  const employeeRows = await pool.query(
    `
    SELECT
      COALESCE(epd.employee_name, '(unknown)') AS employee_name,
      ae.payload->>'employeePhone' AS employee_phone,
      COUNT(*)::int AS call_events,
      COUNT(*) FILTER (WHERE td.status = 'sent')::int AS telegram_sent
    FROM audit_events ae
    LEFT JOIN employee_phone_directory epd
      ON epd.phone_normalized = ae.payload->>'employeePhone'
     AND epd.is_active = TRUE
    LEFT JOIN telegram_deliveries td ON td.call_event_id = ae.call_event_id
    WHERE ae.event_type = 'call_received'
      AND ae.payload->>'externalCallId' LIKE $1
    GROUP BY COALESCE(epd.employee_name, '(unknown)'), ae.payload->>'employeePhone'
    ORDER BY employee_name
    `,
    [`${datePrefix}/%`]
  );

  const recoverableRows = await pool.query(
    `
    SELECT COALESCE(last_error_code, '(none)') AS reason_code, COUNT(*)::int AS count
    FROM tele2_polled_records
    WHERE record_file_name LIKE $1
      AND COALESCE(last_error_code, '') IN ('T2_FILE_HTTP_ERROR', 'POLZA_EMPTY_TRANSCRIPTION', 'AI_GATEWAY_EMPTY_TRANSCRIPT')
    GROUP BY COALESCE(last_error_code, '(none)')
    ORDER BY reason_code
    `,
    [`${datePrefix}/%`]
  );

  const skippedRows = await pool.query(
    `
    SELECT
      record_file_name,
      status,
      attempts,
      COALESCE(last_error_code, '') AS last_error_code,
      COALESCE(last_error_message, '') AS last_error_message,
      COALESCE(phone_raw, '') AS phone_raw,
      COALESCE(call_datetime_raw, '') AS call_datetime_raw,
      transcript_length
    FROM tele2_polled_records
    WHERE record_file_name LIKE $1
      AND status = 'skipped'
    ORDER BY record_file_name
    `,
    [`${datePrefix}/%`]
  );

  const failedRows = await pool.query(
    `
    SELECT
      record_file_name,
      status,
      attempts,
      COALESCE(last_error_code, '') AS last_error_code,
      COALESCE(last_error_message, '') AS last_error_message,
      COALESCE(phone_raw, '') AS phone_raw,
      COALESCE(call_datetime_raw, '') AS call_datetime_raw,
      transcript_length
    FROM tele2_polled_records
    WHERE record_file_name LIKE $1
      AND status = 'failed'
    ORDER BY record_file_name
    `,
    [`${datePrefix}/%`]
  );

  const aiAttemptsRows = await pool.query(
    `
    SELECT
      call_id,
      COUNT(*) FILTER (WHERE operation = 'transcribe')::int AS transcribe_attempts,
      COUNT(*) FILTER (WHERE operation = 'transcribe' AND response_status = 'failed')::int AS transcribe_failed_attempts,
      COUNT(*) FILTER (WHERE operation = 'transcribe' AND response_status = 'success')::int AS transcribe_success_attempts,
      STRING_AGG(
        DISTINCT NULLIF(BTRIM(model), ''),
        ', '
        ORDER BY NULLIF(BTRIM(model), '')
      ) AS transcribe_models
    FROM ai_usage_audit
    WHERE call_id LIKE $1
    GROUP BY call_id
    `,
    [`${datePrefix}/%`]
  );

  const aiAttemptMap = toAiAttemptMap(aiAttemptsRows.rows);
  const skippedRecords = enrichTerminalRecords(skippedRows.rows, aiAttemptMap);
  const failedRecords = enrichTerminalRecords(failedRows.rows, aiAttemptMap);

  const polledTotal = polledByStatusRows.rows.reduce((sum, row) => sum + row.count, 0);
  const callEventsSummary = callEventsRows.rows[0] || { total: 0, processed: 0, telegram_sent: 0 };
  const telegramCallSummary = telegramCallRows.rows[0] || { total: 0, sent: 0, failed: 0 };

  return {
    polledTotal,
    polledByStatus: polledByStatusRows.rows,
    polledByReason: polledByReasonRows.rows,
    callEvents: callEventsSummary,
    aiUsage: aiUsageRows.rows,
    telegramCall: telegramCallSummary,
    telegramRecipient: telegramRecipientRows.rows,
    employeeBreakdown: employeeRows.rows,
    recoverableFailures: recoverableRows.rows,
    skippedRecords,
    failedRecords
  };
}

function toMap(rows, keyField, valueField) {
  const map = new Map();
  for (const row of rows) {
    map.set(row[keyField], row[valueField]);
  }
  return map;
}

function normalizeErrorCodeToken(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value.trim().toUpperCase();
}

function isT2FileHttp404(record) {
  const code = normalizeErrorCodeToken(record?.last_error_code);
  const message = isNonEmptyString(record?.last_error_message)
    ? record.last_error_message.toLowerCase()
    : '';
  return code === 'T2_FILE_HTTP_ERROR' && message.includes('status 404');
}

function classifySkippedRecord(rawRecord) {
  const record = rawRecord && typeof rawRecord === 'object' ? rawRecord : {};
  const code = normalizeErrorCodeToken(record.last_error_code);

  if (POLICY_NON_SENDABLE_SKIP_CODES.has(code)) {
    return {
      ...record,
      errorCode: code,
      classification: 'policy_non_sendable',
      expectedToSend: false,
      recoverable: false,
      expectedBehavior: true
    };
  }

  if (INPUT_NON_SENDABLE_CODES.has(code) || isT2FileHttp404(record)) {
    return {
      ...record,
      errorCode: code || 'UNKNOWN_INPUT',
      classification: 'input_non_sendable',
      expectedToSend: false,
      recoverable: false,
      expectedBehavior: true
    };
  }

  if (RECOVERABLE_ERROR_CODES.has(code)) {
    return {
      ...record,
      errorCode: code,
      classification: 'recoverable_skipped_loss',
      expectedToSend: true,
      recoverable: true,
      expectedBehavior: false
    };
  }

  return {
    ...record,
    errorCode: code || 'UNKNOWN',
    classification: 'unknown_skipped_loss',
    expectedToSend: true,
    recoverable: false,
    expectedBehavior: false
  };
}

function classifyFailedRecord(rawRecord) {
  const record = rawRecord && typeof rawRecord === 'object' ? rawRecord : {};
  const code = normalizeErrorCodeToken(record.last_error_code);

  if (RECOVERABLE_ERROR_CODES.has(code)) {
    return {
      ...record,
      errorCode: code,
      classification: 'recoverable_failed_loss',
      expectedToSend: true,
      recoverable: true,
      expectedBehavior: false
    };
  }

  if (INPUT_NON_SENDABLE_CODES.has(code)) {
    return {
      ...record,
      errorCode: code,
      classification: 'input_non_sendable_failed',
      expectedToSend: false,
      recoverable: false,
      expectedBehavior: true
    };
  }

  return {
    ...record,
    errorCode: code || 'UNKNOWN',
    classification: 'unknown_failed_loss',
    expectedToSend: true,
    recoverable: false,
    expectedBehavior: false
  };
}

function toAiAttemptMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const callId = isNonEmptyString(row.call_id) ? row.call_id.trim() : '';
    if (!callId) {
      continue;
    }

    map.set(callId, {
      transcribeAttempts: Number.isInteger(row.transcribe_attempts) ? row.transcribe_attempts : 0,
      transcribeFailedAttempts: Number.isInteger(row.transcribe_failed_attempts) ? row.transcribe_failed_attempts : 0,
      transcribeSuccessAttempts: Number.isInteger(row.transcribe_success_attempts) ? row.transcribe_success_attempts : 0,
      transcribeModels: isNonEmptyString(row.transcribe_models) ? row.transcribe_models : ''
    });
  }

  return map;
}

function enrichTerminalRecords(records, aiAttemptMap) {
  if (!Array.isArray(records)) {
    return [];
  }

  return records.map((record) => {
    const key = isNonEmptyString(record.record_file_name) ? record.record_file_name.trim() : '';
    const ai = key ? aiAttemptMap.get(key) : null;
    return {
      ...record,
      transcribeAttempts: ai?.transcribeAttempts || 0,
      transcribeFailedAttempts: ai?.transcribeFailedAttempts || 0,
      transcribeSuccessAttempts: ai?.transcribeSuccessAttempts || 0,
      transcribeModels: ai?.transcribeModels || ''
    };
  });
}

function buildDeliveryModel({ source, dbStats, statusMap }) {
  const ignored = statusMap.get('ignored') || 0;
  const duplicate = statusMap.get('duplicate') || 0;
  const processed = statusMap.get('processed') || 0;
  const telegramSent = dbStats.telegramCall.sent || 0;

  const skippedClassified = Array.isArray(dbStats.skippedRecords)
    ? dbStats.skippedRecords.map(classifySkippedRecord)
    : [];
  const failedClassified = Array.isArray(dbStats.failedRecords)
    ? dbStats.failedRecords.map(classifyFailedRecord)
    : [];

  const skippedExpectedNonSendable = skippedClassified.filter((item) => !item.expectedToSend).length;
  const failedExpectedNonSendable = failedClassified.filter((item) => !item.expectedToSend).length;
  const skippedActionable = skippedClassified.filter((item) => item.expectedToSend).length;
  const failedActionable = failedClassified.filter((item) => item.expectedToSend).length;
  const expectedSendable = Math.max(
    0,
    dbStats.polledTotal - ignored - duplicate - skippedExpectedNonSendable - failedExpectedNonSendable
  );
  const unexpectedLoss = Math.max(0, expectedSendable - telegramSent);

  return {
    sourceTotal: source.available && Number.isInteger(source.count) ? source.count : null,
    sourceNotPolled: source.available && Number.isInteger(source.count)
      ? Math.max(0, source.count - dbStats.polledTotal)
      : null,
    polledTotal: dbStats.polledTotal,
    ignored,
    duplicate,
    processed,
    skippedTotal: skippedClassified.length,
    skippedExpectedNonSendable,
    skippedActionable,
    failedTotal: failedClassified.length,
    failedExpectedNonSendable,
    failedActionable,
    expectedSendable,
    actualSent: telegramSent,
    unexpectedLoss,
    skippedDetails: skippedClassified,
    failedDetails: failedClassified
  };
}

function buildWarnings({ source, dbStats }) {
  const warnings = [];

  const statusMap = toMap(dbStats.polledByStatus, 'status', 'count');
  const ignored = statusMap.get('ignored') || 0;
  const processed = statusMap.get('processed') || 0;
  const failed = statusMap.get('failed') || 0;
  const skipped = statusMap.get('skipped') || 0;
  const deliveryModel = buildDeliveryModel({
    source,
    dbStats,
    statusMap
  });

  if (source.available && Number.isInteger(source.count) && dbStats.polledTotal < source.count) {
    warnings.push({
      code: 'SOURCE_NOT_FULLY_POLLED',
      message: `Poller saw ${dbStats.polledTotal} of ${source.count} source records`,
      details: {
        sourceCount: source.count,
        polledCount: dbStats.polledTotal
      }
    });
  }

  const t2FileErrors = dbStats.recoverableFailures.find((item) => item.reason_code === 'T2_FILE_HTTP_ERROR')?.count || 0;
  if (t2FileErrors > 0) {
    warnings.push({
      code: 'T2_FILE_HTTP_ERROR_DETECTED',
      message: `Detected ${t2FileErrors} records with T2_FILE_HTTP_ERROR`,
      details: { count: t2FileErrors }
    });
  }

  const emptyTranscription = dbStats.recoverableFailures
    .filter((item) => item.reason_code === 'POLZA_EMPTY_TRANSCRIPTION' || item.reason_code === 'AI_GATEWAY_EMPTY_TRANSCRIPT')
    .reduce((sum, item) => sum + item.count, 0);
  if (emptyTranscription > 0) {
    warnings.push({
      code: 'POLZA_EMPTY_TRANSCRIPTION_DETECTED',
      message: `Detected ${emptyTranscription} records with POLZA_EMPTY_TRANSCRIPTION`,
      details: { count: emptyTranscription }
    });
  }

  if ((dbStats.telegramCall.sent || 0) < processed) {
    warnings.push({
      code: 'PROCESSED_TO_TELEGRAM_GAP',
      message: `Processed ${processed} calls but only ${dbStats.telegramCall.sent || 0} telegram sent rows`,
      details: {
        processed,
        telegramSent: dbStats.telegramCall.sent || 0
      }
    });
  }

  if (deliveryModel.unexpectedLoss > 0) {
    warnings.push({
      code: 'LOW_SENT_VS_SOURCE',
      message: `Telegram sent ${deliveryModel.actualSent} vs expected sendable ${deliveryModel.expectedSendable} (unexpected_loss=${deliveryModel.unexpectedLoss})`,
      details: {
        sourceCount: deliveryModel.sourceTotal,
        polledTotal: deliveryModel.polledTotal,
        ignored: deliveryModel.ignored,
        duplicate: deliveryModel.duplicate,
        skippedExpectedNonSendable: deliveryModel.skippedExpectedNonSendable,
        skippedActionable: deliveryModel.skippedActionable,
        failedExpectedNonSendable: deliveryModel.failedExpectedNonSendable,
        failedActionable: deliveryModel.failedActionable,
        expectedSendable: deliveryModel.expectedSendable,
        telegramSent: deliveryModel.actualSent,
        unexpectedLoss: deliveryModel.unexpectedLoss
      }
    });
  }

  return warnings;
}

function printPlainReport(report) {
  process.stdout.write(`Date: ${report.date}\n`);
  process.stdout.write(`Timezone: ${report.timeZone}\n`);
  process.stdout.write(`Source count: ${report.source.available ? report.source.count : `n/a (${report.source.reason})`}\n`);
  process.stdout.write(`Polled total: ${report.funnel.polledTotal}\n`);
  process.stdout.write(`Call events processed: ${report.funnel.callEvents.processed}\n`);
  process.stdout.write(`Telegram sent (call-level): ${report.funnel.telegramCall.sent}\n`);
  process.stdout.write(`Expected sendable (delivery model): ${report.delivery.expectedSendable}\n`);
  process.stdout.write(`Unexpected loss (delivery model): ${report.delivery.unexpectedLoss}\n`);
  process.stdout.write(`Warnings: ${report.warnings.length}\n`);

  for (const warning of report.warnings) {
    process.stdout.write(`- [${warning.code}] ${warning.message}\n`);
  }
}

async function main() {
  const rawConfig = parseArgs(process.argv.slice(2));
  if (rawConfig.help) {
    process.stdout.write(`
Daily funnel ops report

Usage:
  node src/scripts/reportDailyFunnelOps.js [options]

Options:
  --date YYYY-MM-DD           Report day (default: today in --timezone)
  --timezone <IANA>           Timezone for default date (default: APP_TIMEZONE/Europe/Moscow)
  --with-source / --no-source Include Tele2 source request (default: with-source)
  --t2-base-url <url>         Tele2 API base URL
  --t2-token <token>          Tele2 token override (else T2_API_TOKEN/T2_ACCESS_TOKEN)
  --t2-auth-scheme <v>        plain|bearer (default: plain)
  --timezone-offset <+HH:MM>  Offset used for source day window (default: T2_TIMEZONE_OFFSET or +03:00)
  --source-fetch-limit <int>  Source fetch size limit (default: ${DEFAULT_SOURCE_FETCH_LIMIT})
  --fail-on-anomaly           Exit code 2 when anomalies are detected
  --json / --no-json          Output JSON (default: --json)
  --help                      Show this help
`);
    return;
  }

  const config = validateConfig(rawConfig);
  const appConfig = loadConfig({ validateRuntimeSecrets: false });
  const pool = createPgPool(appConfig.database);

  try {
    const source = config.withSource
      ? await fetchTele2SourceCount({
        date: config.date,
        t2BaseUrl: config.t2BaseUrl,
        t2Token: config.t2Token,
        t2AuthScheme: config.t2AuthScheme,
        sourceFetchLimit: config.sourceFetchLimit,
        timezoneOffset: config.timezoneOffset
      })
      : {
        available: false,
        reason: 'source_disabled',
        count: null
      };

    const dbStats = await loadDbStats(pool, config.date);
    const warnings = buildWarnings({
      source,
      dbStats
    });
    const statusMap = toMap(dbStats.polledByStatus, 'status', 'count');
    const delivery = buildDeliveryModel({
      source,
      dbStats,
      statusMap
    });

    const report = {
      generatedAt: new Date().toISOString(),
      date: config.date,
      timeZone: config.timeZone,
      source,
      funnel: dbStats,
      delivery,
      warnings
    };

    if (config.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printPlainReport(report);
    }

    if (config.failOnAnomaly && warnings.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error?.message || 'Unknown error'
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildWarnings,
  buildDeliveryModel,
  classifySkippedRecord,
  classifyFailedRecord
};
