const DEFAULT_PORT = 8080;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_POLZA_BASE_URL = 'https://polza.ai/api/v1';
const DEFAULT_POLZA_MODEL = 'gpt-4.1-mini';
const DEFAULT_POLZA_TIMEOUT_MS = 20000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_BODY_LIMIT = '1mb';

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

function loadConfig() {
  return {
    nodeEnv: getOptionalStringFromNames(['NODE_ENV'], 'development'),
    port: parsePositiveIntFromNames('PORT', [], DEFAULT_PORT),
    logLevel: getOptionalStringFromNames(['LOG_LEVEL'], DEFAULT_LOG_LEVEL),
    bodyLimit: getOptionalStringFromNames(['BODY_LIMIT'], DEFAULT_BODY_LIMIT),
    shutdownTimeoutMs: parsePositiveIntFromNames('SHUTDOWN_TIMEOUT_MS', [], DEFAULT_SHUTDOWN_TIMEOUT_MS),
    gatewaySharedSecret: getRequiredStringFromNames('AI_GATEWAY_SHARED_SECRET'),
    openai: {
      apiKey: getRequiredStringFromNames('POLZA_API_KEY'),
      baseUrl: getOptionalStringFromNames(['POLZA_BASE_URL'], DEFAULT_POLZA_BASE_URL),
      model: getOptionalStringFromNames(['POLZA_MODEL'], DEFAULT_POLZA_MODEL),
      timeoutMs: parsePositiveIntFromNames('POLZA_TIMEOUT_MS', [], DEFAULT_POLZA_TIMEOUT_MS)
    }
  };
}

module.exports = {
  loadConfig,
  isNonEmptyString
};
