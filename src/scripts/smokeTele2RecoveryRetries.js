#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  downloadTele2AudioWithRetry,
  runTranscriptionWithRetry,
  buildEmptyTranscriptionDiagnostics,
  buildEmptyTranscriptionErrorMessage
} = require('./pollTele2RecordsOnce');

function createMockLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    child() {
      return createMockLogger();
    }
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testDownloadRetry() {
  const logger = createMockLogger();
  let fileRequests = 0;

  await withServer((req, res) => {
    if (req.url.startsWith('/call-records/file')) {
      fileRequests += 1;
      if (fileRequests === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporary unavailable' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('FAKE_MP3_AUDIO'));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }, async (baseUrl) => {
    const result = await downloadTele2AudioWithRetry({
      recordFileName: '2026-03-26/test-download-retry',
      t2BaseUrl: baseUrl,
      t2Token: 'test-token',
      t2AuthScheme: 'plain',
      timeoutMs: 5000,
      logger,
      requestId: 'smoke-download-retry',
      attempts: 3,
      baseBackoffMs: 1
    });

    assert.equal(result.attemptsUsed, 2);
    assert.ok(result.audio.sizeBytes > 0);
    assert.equal(fileRequests, 2);

    fs.unlinkSync(result.audio.tempFilePath);
  });
}

async function testTranscribeRetry() {
  const logger = createMockLogger();
  let transcribeRequests = 0;

  const tempFilePath = path.join(os.tmpdir(), `smoke-retry-${Date.now()}.mp3`);
  fs.writeFileSync(tempFilePath, Buffer.from('FAKE_MP3_AUDIO'));

  try {
    await withServer((req, res) => {
      if (req.url !== '/transcribe') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      transcribeRequests += 1;
      if (transcribeRequests === 1) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Polza returned empty transcription',
          code: 'POLZA_EMPTY_TRANSCRIPTION'
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        transcript: 'Клиент уточнил наличие и договорился о перезвоне.',
        model: 'gpt-4o-mini-transcribe',
        aiUsage: {
          operation: 'transcribe',
          model: 'gpt-4o-mini-transcribe',
          provider: 'polza',
          responseStatus: 'success'
        }
      }));
    }, async (baseUrl) => {
      const result = await runTranscriptionWithRetry({
        tempFilePath,
        recordFileName: '2026-03-26/test-transcribe-retry',
        requestId: 'smoke-transcribe-retry',
        callId: '2026-03-26/test-transcribe-retry',
        aiGatewayUrl: baseUrl,
        aiGatewaySecret: 'shared',
        aiGatewayTranscribePath: '/transcribe',
        transcribeModel: '',
        timeoutMs: 5000,
        logger,
        attempts: 2,
        baseBackoffMs: 1
      });

      assert.equal(result.ok, true);
      assert.equal(result.outcomes.length, 2);
      assert.equal(transcribeRequests, 2);
      assert.ok(result.result.transcript.includes('уточнил наличие'));
    });
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}

function testEmptyTranscriptionDiagnostics() {
  const diagnostics = buildEmptyTranscriptionDiagnostics({
    recordFileName: '2026-03-26/test-empty-transcription',
    requestId: 'smoke-empty-diagnostics',
    error: {
      code: 'POLZA_EMPTY_TRANSCRIPTION',
      message: 'Polza returned empty transcription',
      statusCode: 502,
      transcriptionAttempts: 2,
      transcriptionOutcomes: [
        {
          attempt: 1,
          status: 'empty',
          errorCode: 'POLZA_EMPTY_TRANSCRIPTION',
          durationMs: 1310
        },
        {
          attempt: 2,
          status: 'empty',
          errorCode: 'POLZA_EMPTY_TRANSCRIPTION',
          durationMs: 1288
        }
      ]
    },
    audio: {
      tempFilePath: '',
      sizeBytes: 28400,
      contentType: 'audio/mpeg'
    },
    conversationDurationSeconds: 42,
    requestedModel: 'openai/gpt-4o-mini-transcribe',
    aiGatewayTranscribePath: '/transcribe'
  });

  assert.equal(diagnostics.classification, 'upstream_empty_after_retries');
  assert.equal(diagnostics.transcribe.attemptsUsed, 2);
  assert.equal(diagnostics.transcribe.attemptCodes.join(','), 'POLZA_EMPTY_TRANSCRIPTION,POLZA_EMPTY_TRANSCRIPTION');

  const message = buildEmptyTranscriptionErrorMessage(diagnostics);
  assert.ok(message.includes('class=upstream_empty_after_retries'));
  assert.ok(message.includes('attempts=2'));
  assert.ok(message.includes('mime=audio/mpeg'));
}

async function main() {
  await testDownloadRetry();
  await testTranscribeRetry();
  testEmptyTranscriptionDiagnostics();
  process.stdout.write('Smoke tele2 recovery retries: OK\n');
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error?.message || 'Unknown error',
    stack: error?.stack || ''
  }, null, 2)}\n`);
  process.exit(1);
});
