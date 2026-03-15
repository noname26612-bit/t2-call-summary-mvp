const assert = require('node:assert/strict');
const { createTelegramTranscriptService } = require('../services/telegramTranscriptService');
const { createTelegramUpdatePollingService } = require('../services/telegramUpdatePollingService');

function createMockLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const calls = {
    getUpdatesOffsets: [],
    documentsSent: 0,
    answersSent: 0,
    savedOffsets: []
  };

  let storedOffset = 0;

  const storage = {
    async getCallTranscriptByEventId({ callEventId }) {
      if (String(callEventId) !== '555') {
        return null;
      }

      return {
        callEventId: '555',
        phoneRaw: '+79990001124',
        callDateTimeRaw: '2026-03-15T01:43:00+03:00',
        transcriptText: 'Клиент: нужны ролики направляющие и подшипник.',
        category: 'Запчасти'
      };
    },
    async getTelegramUpdateOffset() {
      return {
        botKey: 'transcript_callback',
        lastUpdateId: storedOffset
      };
    },
    async saveTelegramUpdateOffset({ lastUpdateId }) {
      storedOffset = Number(lastUpdateId);
      calls.savedOffsets.push(storedOffset);
      return {
        botKey: 'transcript_callback',
        lastUpdateId: storedOffset
      };
    }
  };

  const update = {
    update_id: 101,
    callback_query: {
      id: 'cb-1',
      data: 'transcript:555',
      message: {
        chat: {
          id: '-1001234567'
        }
      }
    }
  };

  const telegramSender = {
    async getWebhookInfo() {
      return {
        status: 'sent',
        responsePayload: {
          ok: true,
          result: {
            url: ''
          }
        }
      };
    },
    async deleteWebhook() {
      return {
        status: 'sent',
        responsePayload: { ok: true, result: true }
      };
    },
    async getUpdates({ offset = null }) {
      calls.getUpdatesOffsets.push(offset === null ? null : Number(offset));

      const shouldReturnUpdate = offset === null || Number(offset) <= 101;
      return {
        status: 'sent',
        responsePayload: {
          ok: true,
          result: shouldReturnUpdate ? [update] : []
        }
      };
    },
    async sendTextMessage() {
      return {
        status: 'sent',
        responsePayload: { ok: true }
      };
    },
    async sendTextDocument() {
      calls.documentsSent += 1;
      return {
        status: 'sent',
        httpStatus: 200,
        responsePayload: { ok: true }
      };
    },
    async answerCallbackQuery() {
      calls.answersSent += 1;
      return {
        status: 'sent',
        responsePayload: { ok: true }
      };
    }
  };

  const transcriptService = createTelegramTranscriptService({
    storage,
    telegramSender,
    logger: createMockLogger(),
    timeZone: 'Europe/Moscow'
  });

  const pollingService = createTelegramUpdatePollingService({
    storage,
    telegramSender,
    handleTelegramUpdate: transcriptService.handleTelegramUpdate,
    logger: createMockLogger(),
    config: {
      enabled: true,
      timeoutSec: 1,
      idleDelayMs: 10,
      errorDelayMs: 10,
      maxBatchSize: 10,
      offsetKey: 'transcript_callback',
      clearWebhookOnStart: true,
      skipBacklogOnFirstStart: false
    }
  });

  const startResult = pollingService.start();
  assert.equal(startResult.status, 'started');

  await sleep(120);
  const stopResult = await pollingService.stop();
  assert.equal(stopResult.status, 'stopped');

  assert.equal(calls.documentsSent, 1, 'callback should be processed once');
  assert.ok(calls.savedOffsets.includes(101), 'offset must be saved after processing');
  assert.ok(calls.getUpdatesOffsets.includes(102), 'next poll must request offset+1');
  assert.equal(calls.answersSent, 1, 'callback answer should be sent once');

  process.stdout.write('Smoke telegram callback polling: OK\n');

  const failedCalls = {
    savedOffsets: [],
    getUpdatesOffsets: [],
    sendAttempts: 0
  };

  let failedStoredOffset = 0;

  const storageWithFailedSend = {
    async getCallTranscriptByEventId() {
      return {
        callEventId: '777',
        phoneRaw: '+79990001124',
        callDateTimeRaw: '2026-03-15T01:43:00+03:00',
        transcriptText: 'Клиент: проверка retry callback.',
        category: 'Запчасти'
      };
    },
    async getTelegramUpdateOffset() {
      return {
        botKey: 'transcript_callback',
        lastUpdateId: failedStoredOffset
      };
    },
    async saveTelegramUpdateOffset({ lastUpdateId }) {
      failedStoredOffset = Number(lastUpdateId);
      failedCalls.savedOffsets.push(failedStoredOffset);
      return {
        botKey: 'transcript_callback',
        lastUpdateId: failedStoredOffset
      };
    }
  };

  const failedUpdate = {
    update_id: 201,
    callback_query: {
      id: 'cb-fail',
      data: 'transcript:777',
      message: {
        chat: {
          id: '-1001234567'
        }
      }
    }
  };

  const senderWithFailedDocument = {
    async getWebhookInfo() {
      return {
        status: 'sent',
        responsePayload: {
          ok: true,
          result: {
            url: ''
          }
        }
      };
    },
    async deleteWebhook() {
      return {
        status: 'sent',
        responsePayload: { ok: true, result: true }
      };
    },
    async getUpdates({ offset = null }) {
      failedCalls.getUpdatesOffsets.push(offset === null ? null : Number(offset));
      return {
        status: 'sent',
        responsePayload: {
          ok: true,
          result: [failedUpdate]
        }
      };
    },
    async sendTextMessage() {
      return {
        status: 'sent',
        responsePayload: { ok: true }
      };
    },
    async sendTextDocument() {
      failedCalls.sendAttempts += 1;
      return {
        status: 'failed',
        httpStatus: 500,
        errorCode: 'TELEGRAM_API_ERROR',
        errorMessage: 'simulated_send_failure',
        responsePayload: null
      };
    },
    async answerCallbackQuery() {
      return {
        status: 'sent',
        responsePayload: { ok: true }
      };
    }
  };

  const transcriptServiceWithFailedSend = createTelegramTranscriptService({
    storage: storageWithFailedSend,
    telegramSender: senderWithFailedDocument,
    logger: createMockLogger(),
    timeZone: 'Europe/Moscow'
  });

  const pollingWithFailedSend = createTelegramUpdatePollingService({
    storage: storageWithFailedSend,
    telegramSender: senderWithFailedDocument,
    handleTelegramUpdate: transcriptServiceWithFailedSend.handleTelegramUpdate,
    logger: createMockLogger(),
    config: {
      enabled: true,
      timeoutSec: 1,
      idleDelayMs: 10,
      errorDelayMs: 20,
      maxBatchSize: 10,
      offsetKey: 'transcript_callback',
      clearWebhookOnStart: false,
      skipBacklogOnFirstStart: false
    }
  });

  pollingWithFailedSend.start();
  await sleep(120);
  await pollingWithFailedSend.stop();

  assert.equal(failedStoredOffset, 0, 'offset must not advance when callback delivery fails');
  assert.equal(failedCalls.savedOffsets.length, 0, 'failed callback should not commit offset');
  assert.ok(failedCalls.sendAttempts >= 1, 'failed callback should be retried');
  assert.ok(
    failedCalls.getUpdatesOffsets.every((item) => item === null || item === 1),
    'polling should keep requesting from same offset after failure'
  );

  process.stdout.write('Smoke telegram callback polling (failed callback offset guard): OK\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
