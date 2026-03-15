const assert = require('node:assert/strict');
const {
  createTelegramSender,
  buildTranscriptCallbackData,
  TRANSCRIPT_BUTTON_LABEL,
  TRANSCRIPT_CALLBACK_PREFIX
} = require('../services/sendTelegramMessage');
const {
  parseTranscriptCallbackData,
  buildTranscriptTextFile,
  MISSING_TRANSCRIPT_TEXT
} = require('../services/telegramTranscriptService');

const TEST_ANALYSIS = {
  category: 'запчасти',
  primaryScenario: 'Запчасти',
  wantedSummary: 'Клиент запросил ролики направляющие и подшипник.',
  summary: 'Клиент запросил ролики направляющие и подшипник.',
  topic: 'Запрос запчастей'
};

function createMockLogger() {
  return {
    info() {},
    warn() {}
  };
}

async function run() {
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options) => {
    requests.push({
      url,
      options
    });

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        result: {
          message_id: 101
        }
      })
    };
  };

  try {
    const sender = createTelegramSender({
      botToken: 'test-bot-token',
      chatId: '-1001234567',
      apiTimeoutMs: 3000,
      timeZone: 'Europe/Moscow'
    }, createMockLogger());

    const summaryResult = await sender({
      callEventId: '12345',
      phone: '+79990001122',
      callDateTime: '2026-03-15T01:43:00+03:00',
      analysis: TEST_ANALYSIS
    });

    assert.equal(summaryResult.status, 'sent');
    assert.equal(requests.length, 1);
    assert.ok(String(requests[0].url).endsWith('/sendMessage'));

    const summaryBody = JSON.parse(requests[0].options.body);
    assert.equal(summaryBody.reply_markup.inline_keyboard[0][0].text, TRANSCRIPT_BUTTON_LABEL);
    assert.equal(summaryBody.reply_markup.inline_keyboard[0][0].callback_data, `${TRANSCRIPT_CALLBACK_PREFIX}12345`);

    const documentResult = await sender.sendTextDocument({
      chatId: '-1001234567',
      fileName: 'call-12345-transcript.txt',
      text: 'test transcript'
    });

    assert.equal(documentResult.status, 'sent');
    assert.equal(requests.length, 2);
    assert.ok(String(requests[1].url).endsWith('/sendDocument'));

    const callback = buildTranscriptCallbackData('12345');
    assert.equal(callback, 'transcript:12345');
    assert.equal(buildTranscriptCallbackData('invalid-id'), '');

    assert.deepEqual(parseTranscriptCallbackData('transcript:12345'), { callEventId: '12345' });
    assert.equal(parseTranscriptCallbackData('noop:12345'), null);

    const transcriptText = buildTranscriptTextFile({
      phone: '+79990001124',
      callDateTime: '2026-03-15T01:43:00+03:00',
      category: 'запчасти',
      transcript: 'Клиент: Нужны ролики направляющие и подшипник.',
      timeZone: 'Europe/Moscow'
    });

    assert.ok(transcriptText.includes('Кто звонил: +79990001124'));
    assert.ok(transcriptText.includes('Категория: Запчасти'));
    assert.ok(transcriptText.includes('Транскрипт:'));

    process.stdout.write('Smoke transcript button flow: OK\n');
    process.stdout.write(`Missing transcript fallback message: ${MISSING_TRANSCRIPT_TEXT}\n`);
  } finally {
    global.fetch = originalFetch;
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
