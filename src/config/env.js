const { parseIgnoredPhones } = require('../utils/ignoredPhones');

const DEFAULT_PORT = 3000;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_APP_TIMEZONE = 'Europe/Moscow';
const DEFAULT_TELEGRAM_TIMEOUT_MS = 10000;
const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_DB_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_T2_TIMEOUT_MS = 10000;
const DEFAULT_AI_GATEWAY_TIMEOUT_MS = 20000;
const DEFAULT_AI_ANALYZE_MIN_TRANSCRIPT_CHARS = 16;
const DEFAULT_TELEGRAM_UPDATES_POLL_TIMEOUT_SEC = 8;
const DEFAULT_TELEGRAM_UPDATES_IDLE_DELAY_MS = 400;
const DEFAULT_TELEGRAM_UPDATES_ERROR_DELAY_MS = 3000;
const DEFAULT_TELEGRAM_UPDATES_MAX_BATCH_SIZE = 25;

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

  if (raw === undefined || raw === null || raw === '') {
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

function parseBoolean(name, defaultValue) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  throw new Error(`${name} must be a boolean (true/false)`);
}

function validateTimeZone(timeZone) {
  if (!isNonEmptyString(timeZone)) {
    throw new Error('APP_TIMEZONE must be a non-empty string');
  }

  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone.trim() }).format(new Date());
    return timeZone.trim();
  } catch (error) {
    throw new Error(`Invalid APP_TIMEZONE value: ${timeZone}`);
  }
}

function buildDatabaseConfig() {
  const connectionString = getOptionalString('DATABASE_URL', '');
  const sslEnabled = parseBoolean('DB_SSL', false);
  const sslRejectUnauthorized = parseBoolean('DB_SSL_REJECT_UNAUTHORIZED', true);
  const ssl = sslEnabled
    ? { rejectUnauthorized: sslRejectUnauthorized }
    : undefined;

  const baseConfig = {
    max: parsePositiveInt('DB_POOL_MAX', DEFAULT_DB_POOL_MAX),
    idleTimeoutMillis: parsePositiveInt('DB_POOL_IDLE_TIMEOUT_MS', DEFAULT_DB_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: parsePositiveInt('DB_CONNECT_TIMEOUT_MS', DEFAULT_DB_CONNECT_TIMEOUT_MS),
    application_name: getOptionalString('DB_APPLICATION_NAME', 'ats-call-summary')
  };

  if (isNonEmptyString(connectionString)) {
    return {
      ...baseConfig,
      connectionString,
      ssl
    };
  }

  return {
    ...baseConfig,
    host: getRequiredString('DB_HOST'),
    port: parsePositiveInt('DB_PORT', 5432),
    database: getRequiredString('DB_NAME'),
    user: getRequiredString('DB_USER'),
    password: getRequiredString('DB_PASSWORD'),
    ssl
  };
}

function loadConfig(options = {}) {
  const { validateRuntimeSecrets = true } = options;

  const appTimezone = validateTimeZone(getOptionalString('APP_TIMEZONE', DEFAULT_APP_TIMEZONE));

  return {
    nodeEnv: getOptionalString('NODE_ENV', 'development'),
    port: parsePositiveInt('PORT', DEFAULT_PORT),
    logLevel: getOptionalString('LOG_LEVEL', DEFAULT_LOG_LEVEL),
    appTimezone,
    shutdownTimeoutMs: parsePositiveInt('SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS),
    autoRunMigrations: parseBoolean('AUTO_RUN_MIGRATIONS', false),
    ignoreListBootstrapFromEnv: parseBoolean('IGNORE_LIST_BOOTSTRAP_FROM_ENV', true),
    ignoredPhonesFromEnv: parseIgnoredPhones(getOptionalString('IGNORED_PHONES', '')),
    aiGateway: {
      url: validateRuntimeSecrets
        ? getRequiredString('AI_GATEWAY_URL')
        : getOptionalString('AI_GATEWAY_URL', ''),
      sharedSecret: validateRuntimeSecrets
        ? getRequiredString('AI_GATEWAY_SHARED_SECRET')
        : getOptionalString('AI_GATEWAY_SHARED_SECRET', ''),
      timeoutMs: parsePositiveInt('AI_GATEWAY_TIMEOUT_MS', DEFAULT_AI_GATEWAY_TIMEOUT_MS)
    },
    costGuards: {
      analyzeMinTranscriptChars: parsePositiveInt(
        'AI_ANALYZE_MIN_TRANSCRIPT_CHARS',
        DEFAULT_AI_ANALYZE_MIN_TRANSCRIPT_CHARS
      )
    },
    ingest: {
      sharedSecret: getOptionalString('INGEST_SHARED_SECRET', '')
    },
    telegram: {
      botToken: validateRuntimeSecrets
        ? getRequiredString('TELEGRAM_BOT_TOKEN')
        : getOptionalString('TELEGRAM_BOT_TOKEN', ''),
      chatId: validateRuntimeSecrets
        ? getRequiredString('TELEGRAM_CHAT_ID')
        : getOptionalString('TELEGRAM_CHAT_ID', ''),
      apiTimeoutMs: parsePositiveInt('TELEGRAM_API_TIMEOUT_MS', DEFAULT_TELEGRAM_TIMEOUT_MS),
      webhookSecret: getOptionalString('TELEGRAM_WEBHOOK_SECRET', ''),
      polling: {
        enabled: parseBoolean('TELEGRAM_UPDATES_POLLING_ENABLED', true),
        timeoutSec: parsePositiveInt(
          'TELEGRAM_UPDATES_POLL_TIMEOUT_SEC',
          DEFAULT_TELEGRAM_UPDATES_POLL_TIMEOUT_SEC
        ),
        idleDelayMs: parsePositiveInt(
          'TELEGRAM_UPDATES_POLL_IDLE_DELAY_MS',
          DEFAULT_TELEGRAM_UPDATES_IDLE_DELAY_MS
        ),
        errorDelayMs: parsePositiveInt(
          'TELEGRAM_UPDATES_POLL_ERROR_DELAY_MS',
          DEFAULT_TELEGRAM_UPDATES_ERROR_DELAY_MS
        ),
        maxBatchSize: parsePositiveInt(
          'TELEGRAM_UPDATES_POLL_MAX_BATCH_SIZE',
          DEFAULT_TELEGRAM_UPDATES_MAX_BATCH_SIZE
        ),
        offsetKey: getOptionalString('TELEGRAM_UPDATES_OFFSET_KEY', 'transcript_callback'),
        clearWebhookOnStart: parseBoolean('TELEGRAM_UPDATES_CLEAR_WEBHOOK_ON_START', true),
        skipBacklogOnFirstStart: parseBoolean('TELEGRAM_UPDATES_SKIP_BACKLOG_ON_FIRST_START', false)
      }
    },
    t2: {
      ingestEnabled: parseBoolean('TELE2_INGEST_ENABLED', false),
      apiBaseUrl: getOptionalString('T2_API_BASE_URL', ''),
      apiToken: getOptionalString('T2_API_TOKEN', ''),
      apiTimeoutMs: parsePositiveInt('T2_API_TIMEOUT_MS', DEFAULT_T2_TIMEOUT_MS),
      adapter: {
        phoneFieldPath: getOptionalString('TELE2_PHONE_FIELD_PATH', ''),
        callDateTimeFieldPath: getOptionalString('TELE2_CALL_DATETIME_FIELD_PATH', ''),
        transcriptFieldPath: getOptionalString('TELE2_TRANSCRIPT_FIELD_PATH', ''),
        callIdFieldPath: getOptionalString('TELE2_CALL_ID_FIELD_PATH', '')
      }
    },
    database: buildDatabaseConfig()
  };
}

module.exports = {
  loadConfig,
  isNonEmptyString
};
