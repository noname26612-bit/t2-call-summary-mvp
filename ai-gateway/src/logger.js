const crypto = require('crypto');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function serializeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    statusCode: error.statusCode
  };
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return {};
  }

  const normalized = {};

  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = serializeError(value);
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

function createLogger(options = {}) {
  const {
    level = 'info',
    service = 'ai-gateway',
    bindings = {}
  } = options;

  const threshold = LEVELS[level] || LEVELS.info;

  function log(recordLevel, message, meta = {}) {
    if ((LEVELS[recordLevel] || 0) < threshold) {
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      level: recordLevel,
      service,
      message,
      pid: process.pid,
      ...bindings,
      ...normalizeMeta(meta)
    };

    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  return {
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    child: (extraBindings = {}) => createLogger({
      level,
      service,
      bindings: {
        ...bindings,
        ...normalizeMeta(extraBindings)
      }
    })
  };
}

function normalizeRequestId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function createRequestLoggerMiddleware(logger) {
  return (req, res, next) => {
    const headerRequestId = normalizeRequestId(req.get('x-request-id'));
    const bodyRequestId = normalizeRequestId(req.body && req.body.requestId);
    const requestId = headerRequestId || bodyRequestId || crypto.randomUUID();
    const startedAt = process.hrtime.bigint();

    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const durationNs = process.hrtime.bigint() - startedAt;
      const durationMs = Number(durationNs) / 1_000_000;

      logger.info('http_request', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        userAgent: req.get('user-agent') || '',
        remoteAddress: req.ip
      });
    });

    next();
  };
}

module.exports = {
  createLogger,
  createRequestLoggerMiddleware,
  serializeError
};
