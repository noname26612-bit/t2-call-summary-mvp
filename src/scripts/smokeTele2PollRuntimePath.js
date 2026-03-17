const assert = require('node:assert/strict');
const http = require('node:http');
const { createCallProcessor } = require('../services/callProcessor');
const { createTelegramSender } = require('../services/sendTelegramMessage');
const { normalizeIncomingCallPayload } = require('../services/t2Mapper');
const {
  resolvePhoneFromRecord,
  buildProcessCallPayload,
  sendProcessCall
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

function createMockStorage() {
  let idCounter = 1000;

  return {
    async createCallEvent() {
      idCounter += 1;
      return { id: idCounter };
    },
    async appendAuditEvent() {},
    async isPhoneIgnored() {
      return false;
    },
    async acquireDedupKey() {
      return { acquired: true, previousStatus: null };
    },
    async saveSummary() {},
    async saveTelegramDelivery() {},
    async completeDedupKey() {},
    async updateCallEventStatus() {}
  };
}

function buildAnalysis(transcript) {
  const normalized = typeof transcript === 'string' ? transcript.trim() : '';
  const wantedSummary = normalized || 'Клиент уточнил детали обращения.';

  return {
    category: 'сервис',
    primaryScenario: 'Ремонт',
    topic: 'Тестовое обращение',
    summary: wantedSummary,
    wantedSummary,
    result: 'Детали зафиксированы.',
    nextStep: 'Связаться с клиентом.',
    urgency: 'средняя',
    tags: [],
    confidence: 0.9
  };
}

async function run() {
  const logger = createMockLogger();
  const storage = createMockStorage();
  const requests = [];
  const originalFetch = global.fetch;
  let processServer = null;
  const ingestSecret = 'smoke-ingest-secret';

  global.fetch = async (url, options) => {
    const normalizedUrl = String(url);
    if (!normalizedUrl.includes('api.telegram.org')) {
      return originalFetch(url, options);
    }

    requests.push({
      url: normalizedUrl,
      options
    });

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        result: { message_id: requests.length }
      })
    };
  };

  try {
    const sendTelegramMessage = createTelegramSender({
      botToken: 'test-bot-token',
      chatId: '-1001234567',
      apiTimeoutMs: 5000,
      timeZone: 'Europe/Moscow'
    }, logger);

    const { processCall } = createCallProcessor({
      storage,
      analyzeCall: async ({ transcript }) => buildAnalysis(transcript),
      sendTelegramMessage,
      logger
    });

    let processRequestCount = 0;
    processServer = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/process-call') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      if (req.headers['x-ingest-secret'] !== ingestSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString('utf8');
      });

      req.on('end', async () => {
        try {
          const payload = JSON.parse(raw || '{}');
          processRequestCount += 1;
          const result = await processCall(payload, {
            source: 'smoke_tele2_poll_once',
            requestId: `smoke-${processRequestCount}`
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message || 'Internal error' }));
        }
      });
    });

    await new Promise((resolve) => {
      processServer.listen(0, '127.0.0.1', resolve);
    });

    const processPort = processServer.address().port;
    const processUrl = `http://127.0.0.1:${processPort}/api/process-call`;

    const incomingRecord = {
      recordFileName: 'incoming-001',
      callType: 'SINGLE_CHANNEL',
      callerNumber: '+7 999 100-00-01',
      destinationNumber: '8 (495) 111-22-33',
      calleeNumber: '+7 (495) 111-22-33',
      date: '2026-03-17T11:48:00+03:00'
    };

    const outgoingRecord = {
      recordFileName: 'outgoing-001',
      callType: 'OUTGOING',
      callerNumber: '8 (495) 222-33-44',
      destinationNumber: '+7 999 200-00-02',
      calleeNumber: '+7 999 200-00-02',
      date: '2026-03-17T12:15:00+03:00'
    };

    const mapperProbe = normalizeIncomingCallPayload(incomingRecord, {});
    assert.equal(mapperProbe.isValid, false);
    assert.equal(mapperProbe.adapterMeta.resolvedPaths.callType, 'callType');
    assert.equal(mapperProbe.adapterMeta.resolvedPaths.callerNumber, 'callerNumber');
    assert.equal(mapperProbe.adapterMeta.resolvedPaths.destinationNumber, 'destinationNumber');

    const incomingPayload = buildProcessCallPayload({
      record: incomingRecord,
      phone: resolvePhoneFromRecord(incomingRecord),
      callDateTime: incomingRecord.date,
      transcript: 'Клиент попросил выездной ремонт.'
    });

    const outgoingPayload = buildProcessCallPayload({
      record: outgoingRecord,
      phone: resolvePhoneFromRecord(outgoingRecord),
      callDateTime: outgoingRecord.date,
      transcript: 'Сотрудник перезвонил клиенту по ремонту.'
    });

    assert.equal(incomingPayload.callType, 'SINGLE_CHANNEL');
    assert.equal(incomingPayload.callerNumber, '+7 999 100-00-01');
    assert.equal(incomingPayload.destinationNumber, '8 (495) 111-22-33');
    assert.equal(outgoingPayload.callType, 'OUTGOING');
    assert.equal(outgoingPayload.callerNumber, '8 (495) 222-33-44');
    assert.equal(outgoingPayload.destinationNumber, '+7 999 200-00-02');

    const incomingResult = await sendProcessCall({
      processUrl,
      ingestSecret,
      payload: incomingPayload,
      timeoutMs: 5000
    });

    const outgoingResult = await sendProcessCall({
      processUrl,
      ingestSecret,
      payload: outgoingPayload,
      timeoutMs: 5000
    });

    assert.equal(incomingResult.statusCode, 200);
    assert.equal(outgoingResult.statusCode, 200);
    assert.equal(requests.length, 2);
    assert.equal(processRequestCount, 2);

    const incomingMessage = JSON.parse(requests[0].options.body).text;
    const outgoingMessage = JSON.parse(requests[1].options.body).text;

    assert.ok(incomingMessage.includes('Тип звонка: Входящий'));
    assert.ok(incomingMessage.includes('Абонент: +74951112233'));
    assert.ok(incomingMessage.includes('Кто звонил: +79991000001'));

    assert.ok(outgoingMessage.includes('Тип звонка: Исходящий'));
    assert.ok(outgoingMessage.includes('Абонент: +74952223344'));
    assert.ok(outgoingMessage.includes('Кто звонил: +79992000002'));

    assert.ok(!incomingMessage.includes('Следующий шаг:'));
    assert.ok(!outgoingMessage.includes('Следующий шаг:'));

    process.stdout.write('Smoke tele2 poll runtime path: OK\n');
    process.stdout.write(`Incoming message:\n${incomingMessage}\n\n`);
    process.stdout.write(`Outgoing message:\n${outgoingMessage}\n`);
  } finally {
    if (processServer) {
      await new Promise((resolve) => processServer.close(resolve));
    }
    global.fetch = originalFetch;
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
