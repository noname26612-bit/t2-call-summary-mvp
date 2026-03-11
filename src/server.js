const express = require('express');
const dotenv = require('dotenv');
const { validateCallPayload, processCall } = require('./services/callProcessor');
const { ingestT2Call } = require('./services/t2IngestService');
const { validateRuntimeEnv } = require('./services/envValidator');

dotenv.config();

try {
  validateRuntimeEnv();
} catch (error) {
  console.error('Runtime environment validation failed:', error.message);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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
    const response = await ingestT2Call(req.body || {}, process.env.IGNORED_PHONES || '');

    if (response && response.status === 'invalid_t2_payload') {
      return res.status(400).json(response);
    }

    return res.status(200).json(response);
  } catch (error) {
    if (error && Number.isInteger(error.statusCode)) {
      return res.status(error.statusCode).json({
        error: error.message,
        code: error.code
      });
    }

    console.error('Unhandled /dev/t2-ingest error:', error);
    return res.status(500).json({ error: 'Internal server error' });
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
    const response = await processCall(payload, process.env.IGNORED_PHONES || '', {
      source: 'api_process_call'
    });
    return res.json(response);
  } catch (error) {
    if (error && Number.isInteger(error.statusCode)) {
      return res.status(error.statusCode).json({
        error: error.message,
        code: error.code
      });
    }

    console.error('Unhandled /api/process-call error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
