const DEFAULT_PORT = 8080;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_OPENAI_TIMEOUT_MS = 20000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_BODY_LIMIT = '1mb';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function getRequiredString(name) {
  const value = process.env[name];

  if (!isNonEmptyString(value)) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function getOptionalString(name, defaultValue = '') {
  const value = process.env[name];
  return isNonEmptyString(value) ? value.trim() : defaultValue;
}

function parsePositiveInt(name, defaultValue) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }

  if (!/^[0-9]+$/.test(String(raw).trim())) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function loadConfig() {
  return {
    nodeEnv: getOptionalString('NODE_ENV', 'development'),
    port: parsePositiveInt('PORT', DEFAULT_PORT),
    logLevel: getOptionalString('LOG_LEVEL', DEFAULT_LOG_LEVEL),
    bodyLimit: getOptionalString('BODY_LIMIT', DEFAULT_BODY_LIMIT),
    shutdownTimeoutMs: parsePositiveInt('SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS),
    gatewaySharedSecret: getRequiredString('GATEWAY_SHARED_SECRET'),
    openai: {
      apiKey: getRequiredString('OPENAI_API_KEY'),
      model: getOptionalString('OPENAI_MODEL', DEFAULT_OPENAI_MODEL),
      timeoutMs: parsePositiveInt('OPENAI_TIMEOUT_MS', DEFAULT_OPENAI_TIMEOUT_MS)
    }
  };
}

module.exports = {
  loadConfig,
  isNonEmptyString
};
