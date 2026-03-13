#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parsePositiveInt(raw, fallback) {
  if (!isNonEmptyString(raw)) {
    return fallback;
  }

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${raw}`);
  }

  return parsed;
}

function sanitizeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildAuthorizationHeader(token, scheme) {
  if (scheme === 'bearer') {
    return `Bearer ${token}`;
  }

  return token;
}

function parseArgs(argv) {
  const parsed = {
    recordFileName: '',
    processUrl: process.env.PROCESS_CALL_URL || 'http://127.0.0.1:3000/api/process-call',
    aiGatewayUrl: process.env.AI_GATEWAY_URL || 'http://127.0.0.1:3001',
    aiGatewaySecret: process.env.AI_GATEWAY_SHARED_SECRET || '',
    aiGatewayTranscribePath: process.env.AI_GATEWAY_TRANSCRIBE_PATH || '/transcribe',
    transcribeModel: process.env.TELE2_TRANSCRIBE_MODEL || '',
    compareTranscribeModel: process.env.TELE2_COMPARE_TRANSCRIBE_MODEL || '',
    t2BaseUrl: process.env.T2_API_BASE_URL || 'https://ats2.t2.ru/crm/openapi',
    t2Token: process.env.T2_API_TOKEN || process.env.T2_ACCESS_TOKEN || '',
    t2AuthScheme: process.env.T2_AUTH_SCHEME || 'plain',
    ingestSecret: process.env.INGEST_SHARED_SECRET || '',
    timeoutMs: parsePositiveInt(process.env.T2_API_TIMEOUT_MS, 20000),
    timezoneOffset: process.env.T2_TIMEZONE_OFFSET || '+03:00',
    phoneOverride: process.env.TELE2_MANUAL_PHONE || '',
    callDateTimeOverride: process.env.TELE2_MANUAL_CALL_DATETIME || '',
    keepAudio: false
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--keep-audio') {
      parsed.keepAudio = true;
      continue;
    }

    if (arg.startsWith('--record-file-name=')) {
      parsed.recordFileName = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--record-file-name') {
      parsed.recordFileName = args.shift() || '';
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

    if (arg.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = parsePositiveInt(arg.split('=').slice(1).join('='), parsed.timeoutMs);
      continue;
    }

    if (arg === '--timeout-ms') {
      parsed.timeoutMs = parsePositiveInt(args.shift(), parsed.timeoutMs);
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

    if (arg.startsWith('--phone=')) {
      parsed.phoneOverride = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--phone') {
      parsed.phoneOverride = args.shift() || parsed.phoneOverride;
      continue;
    }

    if (arg.startsWith('--call-date-time=')) {
      parsed.callDateTimeOverride = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--call-date-time') {
      parsed.callDateTimeOverride = args.shift() || parsed.callDateTimeOverride;
      continue;
    }

    if (!arg.startsWith('--') && !isNonEmptyString(parsed.recordFileName)) {
      parsed.recordFileName = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function validateOptions(options) {
  if (!isNonEmptyString(options.recordFileName)) {
    throw new Error('recordFileName is required');
  }

  if (!isNonEmptyString(options.t2Token)) {
    throw new Error('Tele2 token is required (T2_API_TOKEN/T2_ACCESS_TOKEN or --t2-token)');
  }

  if (!isNonEmptyString(options.aiGatewaySecret)) {
    throw new Error('AI_GATEWAY_SHARED_SECRET is required (--ai-gateway-secret)');
  }

  const authScheme = options.t2AuthScheme.trim().toLowerCase();
  if (!['plain', 'bearer'].includes(authScheme)) {
    throw new Error('T2 auth scheme must be "plain" or "bearer"');
  }

  const rawTranscribePath = isNonEmptyString(options.aiGatewayTranscribePath)
    ? options.aiGatewayTranscribePath.trim()
    : '/transcribe';
  const normalizedTranscribePath = rawTranscribePath.startsWith('/')
    ? rawTranscribePath
    : `/${rawTranscribePath}`;

  return {
    ...options,
    t2AuthScheme: authScheme,
    recordFileName: options.recordFileName.trim(),
    processUrl: options.processUrl.trim(),
    aiGatewayUrl: options.aiGatewayUrl.trim(),
    aiGatewaySecret: options.aiGatewaySecret.trim(),
    aiGatewayTranscribePath: normalizedTranscribePath,
    transcribeModel: options.transcribeModel.trim(),
    compareTranscribeModel: options.compareTranscribeModel.trim(),
    t2BaseUrl: options.t2BaseUrl.trim(),
    t2Token: options.t2Token.trim(),
    ingestSecret: options.ingestSecret.trim(),
    timezoneOffset: options.timezoneOffset.trim(),
    phoneOverride: options.phoneOverride.trim(),
    callDateTimeOverride: options.callDateTimeOverride.trim()
  };
}

function buildDateRangeFromRecordFileName(recordFileName, timezoneOffset) {
  const datePart = recordFileName.split('/')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return null;
  }

  return {
    start: `${datePart}T00:00:00${timezoneOffset}`,
    end: `${datePart}T23:59:59${timezoneOffset}`
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(`Request timeout after ${timeoutMs} ms: ${url}`);
      timeoutError.code = 'REQUEST_TIMEOUT';
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadTele2Audio({ recordFileName, t2BaseUrl, t2Token, t2AuthScheme, timeoutMs }) {
  const base = t2BaseUrl.endsWith('/') ? t2BaseUrl : `${t2BaseUrl}/`;
  const url = new URL('call-records/file', base);
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
    error.responseBody = bodyBuffer.toString('utf8');
    throw error;
  }

  if (!contentType.toLowerCase().includes('audio')) {
    throw new Error(`Tele2 file response is not audio (content-type: ${contentType || 'unknown'})`);
  }

  const tempFilePath = path.join(os.tmpdir(), `tele2-${sanitizeFileName(recordFileName)}.mp3`);
  fs.writeFileSync(tempFilePath, bodyBuffer);

  return {
    tempFilePath,
    contentType,
    sizeBytes: bodyBuffer.length
  };
}

async function fetchTele2CallInfo({ recordFileName, t2BaseUrl, t2Token, t2AuthScheme, timeoutMs, timezoneOffset }) {
  const range = buildDateRangeFromRecordFileName(recordFileName, timezoneOffset);
  if (!range) {
    return null;
  }

  const base = t2BaseUrl.endsWith('/') ? t2BaseUrl : `${t2BaseUrl}/`;
  const url = new URL('call-records/info', base);
  url.searchParams.set('start', range.start);
  url.searchParams.set('end', range.end);
  url.searchParams.set('is_recorded', 'true');
  url.searchParams.set('size', '200');
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
    const error = new Error(`Tele2 call info request failed with status ${response.status}`);
    error.statusCode = response.status;
    error.responseBody = text;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error('Tele2 call info response is not valid JSON');
  }

  if (!Array.isArray(payload)) {
    throw new Error('Tele2 call info response JSON is not an array');
  }

  return payload.find((item) => item && item.recordFileName === recordFileName) || null;
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
  if (!record || typeof record !== 'object') {
    return '';
  }

  const callType = isNonEmptyString(record.callType) ? record.callType.trim().toUpperCase() : '';
  if (callType === 'OUTGOING') {
    return pickFirstNonEmptyString([
      record.destinationNumber,
      record.calleeNumber,
      record.callerNumber
    ]);
  }

  return pickFirstNonEmptyString([
    record.callerNumber,
    record.destinationNumber,
    record.calleeNumber
  ]);
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
  const base = aiGatewayUrl.endsWith('/') ? aiGatewayUrl : `${aiGatewayUrl}/`;
  const normalizedPath = aiGatewayTranscribePath.replace(/^\/+/, '');
  const url = new URL(normalizedPath, base).toString();
  const uploadFileName = `${sanitizeFileName(recordFileName)}.mp3`;

  const formData = new FormData();
  formData.append('requestId', `manual-${Date.now()}`);
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
  if (!isNonEmptyString(transcript)) {
    throw new Error('ai-gateway returned empty transcript');
  }

  return {
    transcript,
    model: isNonEmptyString(payload?.model) ? payload.model.trim() : '',
    audioBytes: Number.isInteger(payload?.audioBytes) ? payload.audioBytes : audioBuffer.length
  };
}

function buildTranscriptPreview(transcript) {
  if (!isNonEmptyString(transcript)) {
    return '';
  }

  const normalized = transcript.trim();
  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}

function resolveErrorCode(error) {
  if (isNonEmptyString(error?.code)) {
    return error.code.trim();
  }

  if (isNonEmptyString(error?.responseBody?.code)) {
    return error.responseBody.code.trim();
  }

  return 'TRANSCRIBE_FAILED';
}

function isEmptyTranscriptionError(errorCode) {
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
    const errorCode = resolveErrorCode(error);
    return {
      ok: false,
      error,
      outcome: {
        status: isEmptyTranscriptionError(errorCode) ? 'empty' : 'failed',
        model: isNonEmptyString(transcribeModel) ? transcribeModel.trim() : 'default',
        transcriptLength: 0,
        preview: '',
        durationMs,
        errorCode,
        errorMessage: isNonEmptyString(error?.message) ? error.message.trim() : 'Unknown transcription error',
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
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    json = null;
  }

  if (!response.ok) {
    const error = new Error(`process-call failed with status ${response.status}`);
    error.statusCode = response.status;
    error.responseBody = json || raw;
    throw error;
  }

  return {
    statusCode: response.status,
    body: json || raw
  };
}

function printHelp() {
  process.stdout.write(`
Manual Tele2 one-record processing helper

Usage:
  node src/scripts/processTele2RecordManual.js <recordFileName> [options]

Example:
  node src/scripts/processTele2RecordManual.js 2026-03-13/177342115767354776

Options:
  --record-file-name <value>      Tele2 recordFileName (or use positional arg)
  --process-url <url>             process-call URL (default: http://127.0.0.1:3000/api/process-call)
  --ai-gateway-url <url>          ai-gateway base URL (default: http://127.0.0.1:3001)
  --ai-gateway-secret <value>     ai-gateway shared secret (x-gateway-secret)
  --ai-gateway-transcribe-path    Transcribe endpoint path (default: /transcribe)
  --transcribe-model <value>      Optional primary model override (example: openai/gpt-4o-mini-transcribe)
  --compare-transcribe-model <v>  Optional compare model (example: openai/whisper-1 or "candidate")
  --t2-base-url <url>             Tele2 OpenAPI base (default: https://ats2.t2.ru/crm/openapi)
  --t2-token <token>              Tele2 access token (env fallback: T2_API_TOKEN/T2_ACCESS_TOKEN)
  --t2-auth-scheme <plain|bearer> Tele2 auth scheme (default: plain)
  --ingest-secret <value>         Optional X-Ingest-Secret header for process-call
  --timezone-offset <value>       Offset for info query date range (default: +03:00)
  --phone <value>                 Override phone for process-call payload
  --call-date-time <value>        Override callDateTime for process-call payload
  --timeout-ms <int>              HTTP timeout in ms (default: 20000)
  --keep-audio                    Keep downloaded audio in /tmp
  --help                          Show this help
`);
}

async function main() {
  const rawOptions = parseArgs(process.argv.slice(2));
  if (rawOptions.help) {
    printHelp();
    return;
  }

  const options = validateOptions(rawOptions);
  const infoRecord = await fetchTele2CallInfo({
    recordFileName: options.recordFileName,
    t2BaseUrl: options.t2BaseUrl,
    t2Token: options.t2Token,
    t2AuthScheme: options.t2AuthScheme,
    timeoutMs: options.timeoutMs,
    timezoneOffset: options.timezoneOffset
  });

  const phone = isNonEmptyString(options.phoneOverride)
    ? options.phoneOverride
    : resolvePhoneFromRecord(infoRecord);
  const callDateTime = isNonEmptyString(options.callDateTimeOverride)
    ? options.callDateTimeOverride
    : pickFirstNonEmptyString([infoRecord?.date]);

  if (!isNonEmptyString(phone)) {
    throw new Error('Cannot resolve phone for process-call payload (use --phone)');
  }

  if (!isNonEmptyString(callDateTime)) {
    throw new Error('Cannot resolve callDateTime for process-call payload (use --call-date-time)');
  }

  const audio = await downloadTele2Audio({
    recordFileName: options.recordFileName,
    t2BaseUrl: options.t2BaseUrl,
    t2Token: options.t2Token,
    t2AuthScheme: options.t2AuthScheme,
    timeoutMs: options.timeoutMs
  });

  let primaryAttempt = null;
  let compareAttempt = null;

  try {
    primaryAttempt = await runTranscriptionAttempt({
      tempFilePath: audio.tempFilePath,
      recordFileName: options.recordFileName,
      aiGatewayUrl: options.aiGatewayUrl,
      aiGatewaySecret: options.aiGatewaySecret,
      aiGatewayTranscribePath: options.aiGatewayTranscribePath,
      transcribeModel: options.transcribeModel,
      timeoutMs: options.timeoutMs
    });

    if (!primaryAttempt.ok) {
      const wrappedError = new Error(primaryAttempt.outcome.errorMessage || 'Primary transcription failed');
      wrappedError.code = primaryAttempt.outcome.errorCode || 'PRIMARY_TRANSCRIPTION_FAILED';
      wrappedError.statusCode = primaryAttempt.outcome.statusCode;
      wrappedError.responseBody = primaryAttempt.error?.responseBody;
      throw wrappedError;
    }

    if (isNonEmptyString(options.compareTranscribeModel)) {
      compareAttempt = await runTranscriptionAttempt({
        tempFilePath: audio.tempFilePath,
        recordFileName: options.recordFileName,
        aiGatewayUrl: options.aiGatewayUrl,
        aiGatewaySecret: options.aiGatewaySecret,
        aiGatewayTranscribePath: options.aiGatewayTranscribePath,
        transcribeModel: options.compareTranscribeModel,
        timeoutMs: options.timeoutMs
      });
    }
  } finally {
    if (!options.keepAudio) {
      try {
        fs.unlinkSync(audio.tempFilePath);
      } catch (error) {
        // keep non-critical cleanup errors silent
      }
    }
  }

  const transcript = primaryAttempt.result.transcript;

  const processCallResult = await sendProcessCall({
    processUrl: options.processUrl,
    ingestSecret: options.ingestSecret,
    phone,
    callDateTime,
    transcript,
    timeoutMs: options.timeoutMs
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    recordFileName: options.recordFileName,
    phone,
    callDateTime,
    download: {
      contentType: audio.contentType,
      sizeBytes: audio.sizeBytes,
      keptFilePath: options.keepAudio ? audio.tempFilePath : ''
    },
    transcription: {
      ...primaryAttempt.outcome,
      source: 'ai-gateway',
      requestedModel: isNonEmptyString(options.transcribeModel) ? options.transcribeModel : 'default'
    },
    compareTranscription: compareAttempt
      ? {
          ...compareAttempt.outcome,
          source: 'ai-gateway',
          requestedModel: options.compareTranscribeModel
        }
      : null,
    compareMode: {
      enabled: Boolean(compareAttempt),
      compareModel: isNonEmptyString(options.compareTranscribeModel) ? options.compareTranscribeModel : ''
    },
    aiGateway: {
      url: options.aiGatewayUrl,
      transcribePath: options.aiGatewayTranscribePath
    },
    processCall: {
      url: options.processUrl,
      statusCode: processCallResult.statusCode,
      body: processCallResult.body
    }
  }, null, 2)}\n`);
}

main().catch((error) => {
  const body = error?.responseBody;
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error?.message || 'Unknown error',
    code: error?.code || '',
    statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null,
    responseBody: body === undefined ? null : body
  }, null, 2)}\n`);
  process.exit(1);
});
