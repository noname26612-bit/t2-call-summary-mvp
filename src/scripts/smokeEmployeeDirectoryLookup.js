const assert = require('node:assert/strict');
const { normalizePhone } = require('../utils/ignoredPhones');
const { createCallProcessor } = require('../services/callProcessor');

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

function createMockStorage(directoryRowsByPhone) {
  let callEventId = 9000;

  return {
    async createCallEvent() {
      callEventId += 1;
      return { id: callEventId };
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
    async updateCallEventStatus() {},
    async findActiveEmployeeByPhone(phoneNormalized) {
      const row = directoryRowsByPhone[phoneNormalized] || null;
      if (!row || row.isActive !== true) {
        return null;
      }

      return {
        id: row.id,
        phoneNormalized,
        employeeName: row.employeeName,
        employeeTitle: row.employeeTitle,
        isActive: true,
        notes: ''
      };
    }
  };
}

function testPhoneNormalization() {
  assert.equal(normalizePhone('+79991234567'), '+79991234567');
  assert.equal(normalizePhone('89991234567'), '+79991234567');
  assert.equal(normalizePhone('+7 999 123 45 67'), '+79991234567');
  assert.equal(normalizePhone('+7 (999) 123-45-67'), '+79991234567');
}

function buildDefaultAnalysis() {
  return {
    category: 'прочее',
    topic: 'Проверка lookup',
    summary: 'Тестовый анализ.',
    result: 'Зафиксировано.',
    nextStep: 'Без дополнительных действий.',
    urgency: 'низкая',
    tags: ['звонок'],
    confidence: 0.7
  };
}

async function run() {
  testPhoneNormalization();

  const logger = createMockLogger();
  const directoryRowsByPhone = {
    '+79991234567': {
      id: 21,
      employeeName: 'Тест Активный',
      employeeTitle: 'менеджер',
      isActive: true
    },
    '+79990000000': {
      id: 22,
      employeeName: 'Тест Неактивный',
      employeeTitle: 'менеджер',
      isActive: false
    }
  };

  const storage = createMockStorage(directoryRowsByPhone);
  const analyzeCalls = [];

  const { processCall } = createCallProcessor({
    storage,
    analyzeCall: async (payload) => {
      analyzeCalls.push(payload);
      return buildDefaultAnalysis();
    },
    sendTelegramMessage: async () => ({ status: 'sent', httpStatus: 200 }),
    logger
  });

  const scenarios = [
    {
      id: 'active_lookup_from_eight_format',
      payload: {
        phone: '+79995550001',
        callDateTime: '2026-03-17T14:00:00+03:00',
        transcript: 'Тест активного lookup',
        callType: 'INCOMING',
        callerNumber: '+79995550001',
        destinationNumber: '8 (999) 123-45-67',
        calleeNumber: '8 (999) 123-45-67'
      },
      expectEmployee: 'Тест Активный'
    },
    {
      id: 'inactive_record_is_ignored',
      payload: {
        phone: '+79995550002',
        callDateTime: '2026-03-17T14:05:00+03:00',
        transcript: 'Тест неактивного номера',
        callType: 'OUTGOING',
        callerNumber: '8 (999) 000-00-00',
        destinationNumber: '+79995550002',
        calleeNumber: '+79995550002'
      },
      expectEmployee: ''
    },
    {
      id: 'unknown_number_no_crash',
      payload: {
        phone: '+79995550003',
        callDateTime: '2026-03-17T14:10:00+03:00',
        transcript: 'Тест неизвестного номера',
        callType: 'OUTGOING',
        callerNumber: '+7 999 555-44-33',
        destinationNumber: '+79995550003',
        calleeNumber: '+79995550003'
      },
      expectEmployee: ''
    }
  ];

  for (const scenario of scenarios) {
    const result = await processCall(scenario.payload, {
      source: 'smoke_employee_directory_lookup',
      requestId: `smoke-${scenario.id}`
    });

    assert.equal(result.status, 'processed', `${scenario.id}: processing should succeed`);
  }

  assert.equal(analyzeCalls.length, scenarios.length, 'All scenarios must reach analyze stage');

  for (const scenario of scenarios) {
    const analyzed = analyzeCalls.find((item) => item.callDateTime === scenario.payload.callDateTime);
    assert.ok(analyzed, `${scenario.id}: analyze payload missing`);

    const employeeName = analyzed.employee?.employeeName || '';
    assert.equal(employeeName, scenario.expectEmployee, `${scenario.id}: employee lookup mismatch`);
  }

  process.stdout.write('Smoke employee directory lookup: OK\n');
  process.stdout.write('Normalization cases: +7, 8, spaces, brackets/dashes\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
