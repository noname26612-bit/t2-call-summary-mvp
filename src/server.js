const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const { loadConfig } = require('./config/env');
const { createLogger, createRequestLoggerMiddleware, serializeError } = require('./services/logger');
const { createStorage } = require('./storage');
const { runMigrations } = require('./db/migrations');
const { createGatewayAnalyzeCall } = require('./services/gatewayAnalyzeCall');
const { createTelegramSender } = require('./services/sendTelegramMessage');
const { createCallProcessor, validateCallPayload } = require('./services/callProcessor');
const { createT2IngestService } = require('./services/t2IngestService');

dotenv.config();

function sendKnownError(res, error, logger, context) {
  if (error && Number.isInteger(error.statusCode)) {
    logger.warn('request_failed_known_error', {
      context,
      error: serializeError(error)
    });

    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code
    });
  }

  logger.error('request_failed_unhandled_error', {
    context,
    error: serializeError(error)
  });

  return res.status(500).json({ error: 'Internal server error' });
}

function createApp({ logger, storage, processCall, ingestT2Call, appTimezone }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(createRequestLoggerMiddleware(logger));

  app.get('/health', async (req, res) => {
    try {
      await storage.healthcheck();
      return res.json({ status: 'ok' });
    } catch (error) {
      logger.error('healthcheck_failed', { error: serializeError(error) });
      return res.status(503).json({ status: 'degraded' });
    }
  });

  app.get('/healthz', async (req, res) => {
    try {
      await storage.healthcheck();
      return res.status(200).json({
        status: 'ok',
        database: 'ok',
        timezone: appTimezone
      });
    } catch (error) {
      logger.error('healthz_failed', { error: serializeError(error) });
      return res.status(503).json({
        status: 'degraded',
        database: 'error',
        timezone: appTimezone
      });
    }
  });

  app.post('/dev/mock-call', (req, res) => {
    const { phone = '', callDateTime = '', transcript } = req.body || {};

    if (typeof transcript !== 'string' || transcript.trim() === '') {
      return res.status(400).json({
        error: 'Field "transcript" is required and must be a non-empty string'
      });
    }

    return res.json({
      phone,
      callDateTime,
      transcript,
      status: 'received'
    });
  });

  app.post('/dev/t2-ingest', async (req, res) => {
    try {
      const response = await ingestT2Call(req.body || {}, {
        requestId: req.requestId
      });

      if (response && response.status === 'invalid_t2_payload') {
        return res.status(400).json(response);
      }

      return res.status(200).json(response);
    } catch (error) {
      return sendKnownError(res, error, logger, 'dev_t2_ingest');
    }
  });

  app.post('/api/process-call', async (req, res) => {
    const payload = req.body || {};
    const validationErrors = validateCallPayload(payload);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: validationErrors
      });
    }

    try {
      const response = await processCall(payload, {
        source: 'api_process_call',
        requestId: req.requestId
      });
      return res.json(response);
    } catch (error) {
      return sendKnownError(res, error, logger, 'api_process_call');
    }
  });

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    logger.error('express_unhandled_error', {
      requestId: req.requestId,
      error: serializeError(err)
    });
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function registerGracefulShutdown({ server, storage, logger, shutdownTimeoutMs }) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('shutdown_started', { signal });

    const forceTimer = setTimeout(() => {
      logger.error('shutdown_timeout_force_exit', {
        signal,
        timeoutMs: shutdownTimeoutMs
      });
      process.exit(1);
    }, shutdownTimeoutMs);

    forceTimer.unref();

    server.close(async (serverError) => {
      if (serverError) {
        logger.error('http_server_close_failed', {
          error: serializeError(serverError)
        });
      }

      try {
        await storage.close();
        logger.info('shutdown_finished', {
          signal
        });
        clearTimeout(forceTimer);
        process.exit(serverError ? 1 : 0);
      } catch (storageError) {
        logger.error('storage_close_failed', {
          error: serializeError(storageError)
        });
        clearTimeout(forceTimer);
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', {
      error: serializeError(error)
    });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', {
      reason: reason instanceof Error ? serializeError(reason) : reason
    });
  });
}

async function bootstrap() {
  const config = loadConfig({ validateRuntimeSecrets: true });
  const logger = createLogger({
    level: config.logLevel,
    service: 'ats-call-summary'
  });

  const storage = createStorage({
    databaseConfig: config.database,
    logger
  });

  if (config.autoRunMigrations) {
    await runMigrations({
      pool: storage.pool,
      migrationsDir: path.resolve(__dirname, '../migrations'),
      logger
    });
  }

  await storage.healthcheck();

  if (config.ignoreListBootstrapFromEnv && config.ignoredPhonesFromEnv.length > 0) {
    const upserted = await storage.seedIgnoreList(config.ignoredPhonesFromEnv);

    logger.info('ignore_list_bootstrap_completed', {
      fromEnvCount: config.ignoredPhonesFromEnv.length,
      upserted
    });
  }

  const analyzeCall = createGatewayAnalyzeCall(config.aiGateway);
  const sendTelegramMessage = createTelegramSender({
    ...config.telegram,
    timeZone: config.appTimezone
  }, logger.child({ component: 'telegram' }));

  const { processCall } = createCallProcessor({
    storage,
    analyzeCall,
    sendTelegramMessage,
    logger: logger.child({ component: 'call_processor' })
  });

  const { ingestT2Call } = createT2IngestService({ processCall });

  const app = createApp({
    logger,
    storage,
    processCall,
    ingestT2Call,
    appTimezone: config.appTimezone
  });

  const server = app.listen(config.port, () => {
    logger.info('server_started', {
      port: config.port,
      timezone: config.appTimezone,
      nodeEnv: config.nodeEnv
    });
  });

  registerGracefulShutdown({
    server,
    storage,
    logger,
    shutdownTimeoutMs: config.shutdownTimeoutMs
  });
}

bootstrap().catch((error) => {
  const fallbackLogger = createLogger({ level: 'error', service: 'ats-call-summary' });
  fallbackLogger.error('bootstrap_failed', {
    error: serializeError(error)
  });
  process.exit(1);
});
