const DEFAULT_PORT = 8080;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_POLZA_BASE_URL = 'https://polza.ai/api/v1';
const DEFAULT_POLZA_MODEL = 'openai/gpt-5-mini';
const DEFAULT_POLZA_TRANSCRIBE_MODEL = 'openai/gpt-4o-transcribe';
const DEFAULT_POLZA_TIMEOUT_MS = 20000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_BODY_LIMIT = '1mb';
const DEFAULT_TRANSCRIBE_FILE_MAX_BYTES = 20 * 1024 * 1024;
const OPENAI_PROVIDER_PREFIX = 'openai/';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function getRequiredStringFromNames(canonicalName, fallbackNames = []) {
  const candidates = [canonicalName, ...fallbackNames];

  for (const name of candidates) {
    const value = process.env[name];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  throw new Error(
    `Missing required environment variable: ${canonicalName}` +
      (fallbackNames.length > 0 ? ` (fallbacks checked: ${fallbackNames.join(', ')})` : '')
  );
}

function getOptionalStringFromNames(candidates, defaultValue = '') {
  for (const name of candidates) {
    const value = process.env[name];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  return defaultValue;
}

function parsePositiveIntValue(rawValue, nameForError) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return null;
  }

  if (!/^[0-9]+$/.test(String(rawValue).trim())) {
    throw new Error(`${nameForError} must be a positive integer`);
  }

  const parsed = Number.parseInt(String(rawValue).trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${nameForError} must be a positive integer`);
  }

  return parsed;
}

function parsePositiveIntFromNames(canonicalName, fallbackNames = [], defaultValue) {
  const candidates = [canonicalName, ...fallbackNames];

  for (const name of candidates) {
    const parsed = parsePositiveIntValue(process.env[name], name);
    if (parsed !== null) {
      return parsed;
    }
  }

  return defaultValue;
}

function normalizeModelId(value) {
  return isNonEmptyString(value) ? value.trim() : '';
}

function stripOpenAIProviderPrefix(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return '';
  }

  return normalized.replace(/^openai\//i, '');
}

function ensureOpenAIProviderPrefix(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return '';
  }

  if (/^openai\//i.test(normalized)) {
    return `${OPENAI_PROVIDER_PREFIX}${stripOpenAIProviderPrefix(normalized)}`;
  }

  if (normalized.includes('/')) {
    return normalized;
  }

  return `${OPENAI_PROVIDER_PREFIX}${normalized}`;
}

// Keep model-id compatibility centralized: env may use provider-prefixed aliases.
// Upstream (Polza OpenAI-compatible) accepts both bare and provider-prefixed ids;
// we normalize to bare OpenAI ids for both analyze and transcribe upstream calls.
function resolveUpstreamModelId(modelId, { preferBareOpenAI = false, preferPrefixedOpenAI = false } = {}) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return '';
  }

  if (preferBareOpenAI) {
    return stripOpenAIProviderPrefix(normalized);
  }

  if (preferPrefixedOpenAI) {
    return ensureOpenAIProviderPrefix(normalized);
  }

  return normalized;
}

function loadConfig() {
  const configuredAnalyzeModel = getOptionalStringFromNames(['POLZA_MODEL'], DEFAULT_POLZA_MODEL);
  const configuredTranscribeModel = getOptionalStringFromNames(
    ['POLZA_TRANSCRIBE_MODEL'],
    DEFAULT_POLZA_TRANSCRIBE_MODEL
  );
  const configuredTranscribeCandidateModel = getOptionalStringFromNames(
    ['POLZA_TRANSCRIBE_MODEL_CANDIDATE'],
    ''
  );

  return {
    nodeEnv: getOptionalStringFromNames(['NODE_ENV'], 'development'),
    port: parsePositiveIntFromNames('PORT', [], DEFAULT_PORT),
    logLevel: getOptionalStringFromNames(['LOG_LEVEL'], DEFAULT_LOG_LEVEL),
    bodyLimit: getOptionalStringFromNames(['BODY_LIMIT'], DEFAULT_BODY_LIMIT),
    transcribeFileMaxBytes: parsePositiveIntFromNames(
      'TRANSCRIBE_FILE_MAX_BYTES',
      [],
      DEFAULT_TRANSCRIBE_FILE_MAX_BYTES
    ),
    shutdownTimeoutMs: parsePositiveIntFromNames('SHUTDOWN_TIMEOUT_MS', [], DEFAULT_SHUTDOWN_TIMEOUT_MS),
    gatewaySharedSecret: getRequiredStringFromNames('AI_GATEWAY_SHARED_SECRET'),
    openai: {
      apiKey: getRequiredStringFromNames('POLZA_API_KEY'),
      baseUrl: getOptionalStringFromNames(['POLZA_BASE_URL'], DEFAULT_POLZA_BASE_URL),
      modelConfigured: configuredAnalyzeModel,
      model: resolveUpstreamModelId(configuredAnalyzeModel, { preferBareOpenAI: true }),
      transcribeModelConfigured: configuredTranscribeModel,
      transcribeModel: resolveUpstreamModelId(configuredTranscribeModel, { preferBareOpenAI: true }),
      transcribeCandidateModelConfigured: configuredTranscribeCandidateModel,
      transcribeCandidateModel: resolveUpstreamModelId(configuredTranscribeCandidateModel, {
        preferBareOpenAI: true
      }),
      timeoutMs: parsePositiveIntFromNames('POLZA_TIMEOUT_MS', [], DEFAULT_POLZA_TIMEOUT_MS)
    }
  };
}

module.exports = {
  loadConfig,
  isNonEmptyString
};
