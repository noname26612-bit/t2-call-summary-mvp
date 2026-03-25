const assert = require('node:assert/strict');
const { createTelegramSender } = require('../services/sendTelegramMessage');

const TEST_ANALYSIS = {
  category: 'запчасти',
  primaryScenario: 'Запчасти',
  wantedSummary: 'Клиент уточнил наличие подшипника.',
  summary: 'Клиент уточнил наличие подшипника.',
  topic: 'Запрос по наличию'
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
  let scenario = 'global_only';

  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    requests.push({
      scenario,
      url,
      body
    });

    const chatId = String(body.chat_id || '');
    const shouldFail = scenario === 'conditional_partial_failure' && chatId === '1002';

    if (shouldFail) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({
          ok: false,
          description: 'Forbidden: bot was blocked by the user'
        })
      };
    }

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        result: {
          message_id: requests.length
        }
      })
    };
  };

  try {
    const sender = createTelegramSender({
      botToken: 'test-bot-token',
      chatId: '1001',
      globalChatIds: ['1001', '1002', '', '1002'],
      numberRouteRules: [
        {
          phone: '+79779564221',
          chatIds: ['1003', '1002', 'bad_chat_id']
        }
      ],
      apiTimeoutMs: 3000,
      timeZone: 'Europe/Moscow'
    }, createMockLogger());

    const globalOnlyResult = await sender({
      callEventId: '100',
      phone: '+79990000001',
      callDateTime: '2026-03-25T12:00:00+03:00',
      analysis: TEST_ANALYSIS,
      callType: 'INCOMING',
      callerNumber: '+79990000001',
      calleeNumber: '+74950000001',
      destinationNumber: '+74950000001',
      employeePhone: '+74950000001'
    });

    const globalOnlyRequests = requests.filter((item) => item.scenario === 'global_only');
    assert.equal(globalOnlyRequests.length, 2);
    assert.deepEqual(
      globalOnlyRequests.map((item) => String(item.body.chat_id)),
      ['1001', '1002']
    );
    assert.equal(globalOnlyResult.status, 'sent');
    assert.equal(globalOnlyResult.errorCode, null);
    assert.equal(globalOnlyResult.responsePayload.sentCount, 2);
    assert.equal(globalOnlyResult.responsePayload.failedCount, 0);

    scenario = 'conditional_partial_failure';

    const conditionalResult = await sender({
      callEventId: '101',
      phone: '+79990000002',
      callDateTime: '2026-03-25T12:05:00+03:00',
      analysis: TEST_ANALYSIS,
      callType: 'INCOMING',
      callerNumber: '+79990000002',
      calleeNumber: '8 (977) 956-42-21',
      destinationNumber: '8 (977) 956-42-21',
      employeePhone: '8 (977) 956-42-21'
    });

    const conditionalRequests = requests.filter((item) => item.scenario === 'conditional_partial_failure');
    assert.equal(conditionalRequests.length, 3);
    assert.deepEqual(
      conditionalRequests.map((item) => String(item.body.chat_id)),
      ['1001', '1002', '1003']
    );
    assert.equal(conditionalResult.status, 'sent');
    assert.equal(conditionalResult.errorCode, 'TELEGRAM_PARTIAL_FAILURE');
    assert.equal(conditionalResult.responsePayload.routePhone, '+79779564221');
    assert.equal(conditionalResult.responsePayload.sentCount, 2);
    assert.equal(conditionalResult.responsePayload.failedCount, 1);

    const failedRecipient = conditionalResult.recipientResults.find((item) => item.chatId === '1002');
    const sentRecipient = conditionalResult.recipientResults.find((item) => item.chatId === '1003');
    assert.equal(failedRecipient?.status, 'failed');
    assert.equal(sentRecipient?.status, 'sent');

    process.stdout.write('Smoke telegram multi-recipient routing: OK\n');
  } finally {
    global.fetch = originalFetch;
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
