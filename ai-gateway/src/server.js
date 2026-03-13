const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const { loadConfig, isNonEmptyString } = require('./config');
const { createLogger, createRequestLoggerMiddleware, serializeError } = require('./logger');
const {
  createOpenAIAnalyzer,
  createOpenAITranscriber,
  OpenAIClientError
} = require('./openaiClient');

dotenv.config();

function normalizeOptionalString(value) {
  return isNonEmptyString(value) ? value.trim() : '';
}

function buildValidationErrors(payload) {
  const errors = [];

  if (!isNonEmptyString(payload.transcript)) {
    errors.push({
      field: 'transcript',
      message: 'transcript is required and must be a non-empty string'
    });
  }

  return errors;
}

function buildTranscriptionValidationErrors(payload, hasAudioFile) {
  const errors = [];

  if (!hasAudioFile && !isNonEmptyString(payload.audioBase64)) {
    errors.push({
      field: 'audio',
      message: 'audio multipart file (field "audio") or audioBase64 is required'
    });
  }

  return errors;
}

function isAuthorized(req, sharedSecret) {
  const providedSecret = req.get('x-gateway-secret');
  return isNonEmptyString(providedSecret) && providedSecret === sharedSecret;
}

function isLikelyAudioMimeType(value) {
  if (!isNonEmptyString(value)) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('audio/') || normalized === 'application/octet-stream';
}

function createAuthGuard({ logger, sharedSecret, route }) {
  return function routeAuthGuard(req, res, next) {
    if (!isAuthorized(req, sharedSecret)) {
      logger.warn('gateway_auth_failed', {
        requestId: req.requestId,
        route
      });

      return res.status(401).json({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED'
      });
    }

    return next();
  };
}

function sendKnownError(res, error, logger, requestId) {
  if (error instanceof OpenAIClientError) {
    logger.warn('analyze_failed_known_error', {
      requestId,
      error: serializeError(error)
    });

    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code
    });
  }

  logger.error('analyze_failed_unhandled_error', {
    requestId,
    error: serializeError(error)
  });

  return res.status(500).json({ error: 'Internal server error' });
}

function createApp({ config, logger, analyzeCall, transcribeAudio }) {
  const app = express();
  const transcribeUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.transcribeFileMaxBytes
    }
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(createRequestLoggerMiddleware(logger));
  const transcribeAuthGuard = createAuthGuard({
    logger,
    sharedSecret: config.gatewaySharedSecret,
    route: '/transcribe'
  });

  app.get('/healthz', (req, res) => {
    return res.status(200).json({ status: 'ok' });
  });

  app.post('/analyze', async (req, res) => {
    if (!isAuthorized(req, config.gatewaySharedSecret)) {
      logger.warn('gateway_auth_failed', {
        requestId: req.requestId,
        route: '/analyze'
      });

      return res.status(401).json({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED'
      });
    }

    const payload = req.body || {};
    const validationErrors = buildValidationErrors(payload);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: validationErrors
      });
    }

    try {
      const analysis = await analyzeCall({
        requestId: normalizeOptionalString(payload.requestId) || req.requestId,
        phone: normalizeOptionalString(payload.phone),
        callDateTime: normalizeOptionalString(payload.callDateTime),
        transcript: payload.transcript.trim()
      });

      return res.status(200).json(analysis);
    } catch (error) {
      return sendKnownError(res, error, logger, req.requestId);
    }
  });

  app.post('/transcribe', transcribeAuthGuard, transcribeUpload.single('audio'), async (req, res) => {
    const payload = req.body || {};
    const hasAudioFile = Buffer.isBuffer(req?.file?.buffer) && req.file.buffer.length > 0;
    const effectiveMimeType = normalizeOptionalString(payload.mimeType) || normalizeOptionalString(req?.file?.mimetype);
    const validationErrors = buildTranscriptionValidationErrors(payload, hasAudioFile);

    if (hasAudioFile && !isLikelyAudioMimeType(effectiveMimeType)) {
      validationErrors.push({
        field: 'mimeType',
        message: 'uploaded file mimeType must be audio/* (or application/octet-stream)'
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: validationErrors
      });
    }

    try {
      const response = await transcribeAudio({
        requestId: normalizeOptionalString(payload.requestId) || req.requestId,
        audioBuffer: hasAudioFile ? req.file.buffer : undefined,
        audioBase64: !hasAudioFile ? normalizeOptionalString(payload.audioBase64) : '',
        fileName: normalizeOptionalString(payload.fileName) || normalizeOptionalString(req?.file?.originalname),
        mimeType: effectiveMimeType
      });

      return res.status(200).json(response);
    } catch (error) {
      return sendKnownError(res, error, logger, req.requestId);
    }
  });

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `Uploaded audio file is too large (max ${config.transcribeFileMaxBytes} bytes)`,
          code: 'TRANSCRIBE_AUDIO_TOO_LARGE'
        });
      }

      return res.status(400).json({
        error: 'Invalid multipart form-data',
        code: 'TRANSCRIBE_MULTIPART_INVALID'
      });
    }

    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'Request body is too large',
        code: 'PAYLOAD_TOO_LARGE'
      });
    }

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

function registerGracefulShutdown({ server, logger, shutdownTimeoutMs }) {
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

    server.close((serverError) => {
      clearTimeout(forceTimer);

      if (serverError) {
        logger.error('http_server_close_failed', {
          error: serializeError(serverError)
        });
        process.exit(1);
      }

      logger.info('shutdown_finished', { signal });
      process.exit(0);
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

function bootstrap() {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    service: 'ai-gateway'
  });

  const analyzeCall = createOpenAIAnalyzer(
    config.openai,
    logger.child({ component: 'openai_client' })
  );
  const transcribeAudio = createOpenAITranscriber(
    config.openai,
    logger.child({ component: 'openai_transcriber' })
  );

  const app = createApp({
    config,
    logger,
    analyzeCall,
    transcribeAudio
  });

  const server = app.listen(config.port, () => {
    logger.info('server_started', {
      port: config.port,
      nodeEnv: config.nodeEnv,
      model: config.openai.model,
      transcribeModel: config.openai.transcribeModel
    });
  });

  registerGracefulShutdown({
    server,
    logger,
    shutdownTimeoutMs: config.shutdownTimeoutMs
  });
}

bootstrap();
