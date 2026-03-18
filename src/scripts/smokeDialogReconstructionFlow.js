const assert = require('node:assert/strict');
const { createCallProcessor } = require('../services/callProcessor');
const { formatTelegramCallSummary } = require('../services/telegramMessageFormatter');

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
  let callEventId = 7000;

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
    async findActiveEmployeeByPhone(phone) {
      const row = directoryRowsByPhone[phone] || null;
      if (!row || row.isActive !== true) {
        return null;
      }

      return {
        id: row.id,
        phoneNormalized: phone,
        employeeName: row.employeeName,
        employeeTitle: row.employeeTitle,
        isActive: true,
        notes: row.notes || ''
      };
    }
  };
}

function buildScenarioAnalysis({ scenario, payload, employee }) {
  const lowConfidence = scenario.id === 'low_confidence';
  const noisyTranscript = scenario.id === 'short_noisy';

  const employeePrefix = employee
    ? `${employee.employeeName} (${employee.employeeTitle})`
    : 'сотрудник';

  const reconstructedTurns = noisyTranscript
    ? [
        {
          speaker: 'S1',
          role: 'unknown',
          text: 'Алло, подскажите?',
          confidence: 0.35
        }
      ]
    : [
        {
          speaker: 'S1',
          role: lowConfidence ? 'unknown' : 'client',
          text: 'Мне нужно уточнить условия и сроки.',
          confidence: lowConfidence ? 0.4 : 0.85
        },
        {
          speaker: 'S2',
          role: lowConfidence ? 'unknown' : 'employee',
          text: 'Подтверждаю, сейчас соберу информацию.',
          confidence: lowConfidence ? 0.38 : 0.84
        }
      ];

  return {
    category: 'прочее',
    topic: 'Уточнение условий обслуживания',
    summary: 'Клиент обратился за уточнением условий и сроков.',
    result: 'Обращение принято в работу.',
    nextStep: 'Подготовить ответ и подтвердить срок обратной связи.',
    urgency: noisyTranscript ? 'низкая' : 'средняя',
    tags: ['звонок', 'уточнение'],
    confidence: lowConfidence ? 0.44 : 0.79,
    transcriptPlain: payload.transcript,
    reconstructedTurns,
    participantsAssumption: 'Предположение: два участника разговора (клиент и сотрудник).',
    detectedClientSpeaker: lowConfidence ? '' : 'S1',
    detectedEmployeeSpeaker: lowConfidence ? '' : 'S2',
    speakerRoleConfidence: lowConfidence ? 0.33 : (noisyTranscript ? 0.46 : 0.86),
    clientGoal: noisyTranscript
      ? 'Клиент пытался уточнить детали, но транскрипт короткий и шумный.'
      : 'Клиент хотел понять условия и срок выполнения запроса.',
    employeeResponse: `${employeePrefix} дал первичный ответ и обозначил рамки решения.`,
    issueReason: noisyTranscript
      ? 'Часть реплик распознана нечетко, факты ограничены.'
      : 'Нужна конкретика по срокам и порядку работ.',
    outcome: 'Стороны договорились о повторном контакте после уточнения деталей.',
    nextStepStructured: 'Ответственный сотрудник перезвонит клиенту с уточненными данными.',
    analysisWarnings: lowConfidence
      ? ['Низкая уверенность в распределении ролей по репликам.']
      : (noisyTranscript ? ['Транскрипт короткий и содержит шум.'] : [])
  };
}

async function run() {
  const logger = createMockLogger();
  const directoryRowsByPhone = {
    '+74951112233': {
      id: 11,
      employeeName: 'Милена',
      employeeTitle: 'менеджер',
      isActive: true
    },
    '+74952223344': {
      id: 12,
      employeeName: 'Михаил',
      employeeTitle: 'руководитель / менеджер',
      isActive: true
    },
    '+74950000099': {
      id: 13,
      employeeName: 'Архивный сотрудник',
      employeeTitle: 'менеджер',
      isActive: false
    }
  };

  const storage = createMockStorage(directoryRowsByPhone);

  const scenarios = [
    {
      id: 'incoming_known',
      title: 'Incoming known employee',
      payload: {
        phone: '+79991110001',
        callDateTime: '2026-03-17T10:01:00+03:00',
        transcript: 'Добрый день, хочу уточнить условия ремонта и сроки. Можете подсказать?',
        callType: 'INCOMING',
        callerNumber: '+79991110001',
        destinationNumber: '+7 (495) 111-22-33',
        calleeNumber: '+7 (495) 111-22-33'
      },
      expectEmployeeName: 'Милена',
      expectExplicitRoles: true
    },
    {
      id: 'incoming_unknown',
      title: 'Incoming unknown employee',
      payload: {
        phone: '+79991110002',
        callDateTime: '2026-03-17T10:06:00+03:00',
        transcript: 'Хотел узнать, когда мне могут перезвонить по заявке.',
        callType: 'INCOMING',
        callerNumber: '+79991110002',
        destinationNumber: '+7 (495) 666-77-88',
        calleeNumber: '+7 (495) 666-77-88'
      },
      expectEmployeeName: ''
    },
    {
      id: 'outgoing_known',
      title: 'Outgoing known employee',
      payload: {
        phone: '+79992220003',
        callDateTime: '2026-03-17T10:15:00+03:00',
        transcript: 'Перезваниваем клиенту, чтобы подтвердить сроки и следующий шаг.',
        callType: 'OUTGOING',
        callerNumber: '8 (495) 222-33-44',
        destinationNumber: '+7 999 222-00-03',
        calleeNumber: '+7 999 222-00-03'
      },
      expectEmployeeName: 'Михаил'
    },
    {
      id: 'short_noisy',
      title: 'Short noisy transcript',
      payload: {
        phone: '+79993330004',
        callDateTime: '2026-03-17T10:20:00+03:00',
        transcript: 'Алло... ага... да.',
        callType: 'INCOMING',
        callerNumber: '+79993330004',
        destinationNumber: '+7 (495) 111-22-33',
        calleeNumber: '+7 (495) 111-22-33'
      },
      expectEmployeeName: 'Милена'
    },
    {
      id: 'long_without_labels',
      title: 'Long transcript without labels',
      payload: {
        phone: '+79994440005',
        callDateTime: '2026-03-17T10:27:00+03:00',
        transcript: [
          'Добрый день, подскажите по сервису.',
          'Хочу понять, когда сможете взять заявку и кто свяжется.',
          'Еще важно, чтобы обозначили сроки и какие документы нужны.',
          'Да, понял, тогда жду обратный звонок после внутреннего уточнения.'
        ].join(' '),
        callType: 'INCOMING',
        callerNumber: '+79994440005',
        destinationNumber: '+7 (495) 111-22-33',
        calleeNumber: '+7 (495) 111-22-33'
      },
      expectEmployeeName: 'Милена'
    },
    {
      id: 'low_confidence',
      title: 'Low confidence role detection',
      payload: {
        phone: '+79995550006',
        callDateTime: '2026-03-17T10:32:00+03:00',
        transcript: 'Слышно плохо, не совсем понятно кто что сказал, но обсуждали сроки и обратный звонок.',
        callType: 'INCOMING',
        callerNumber: '+79995550006',
        destinationNumber: '+7 (495) 111-22-33',
        calleeNumber: '+7 (495) 111-22-33'
      },
      expectEmployeeName: 'Милена',
      expectLowConfidence: true,
      expectNeutralTone: true
    },
    {
      id: 'single_channel_known',
      title: 'Single channel known employee',
      payload: {
        phone: '+79997770008',
        callDateTime: '2026-03-17T10:35:00+03:00',
        transcript: 'Клиент уточняет условия обслуживания и сроки обратной связи.',
        callType: 'SINGLE_CHANNEL',
        callerNumber: '+79997770008',
        destinationNumber: '8 (495) 111-22-33',
        calleeNumber: '+7 (495) 111-22-33'
      },
      expectEmployeeName: 'Милена'
    },
    {
      id: 'inactive_directory',
      title: 'Inactive directory number is ignored',
      payload: {
        phone: '+79996660007',
        callDateTime: '2026-03-17T10:37:00+03:00',
        transcript: 'Перезваниваем клиенту по уточнению запроса.',
        callType: 'OUTGOING',
        callerNumber: '+7 (495) 000-00-99',
        destinationNumber: '+7 999 666-00-07',
        calleeNumber: '+7 999 666-00-07'
      },
      expectEmployeeName: ''
    }
  ];

  const analyzeCalls = [];
  const telegramCalls = [];

  const { processCall } = createCallProcessor({
    storage,
    analyzeCall: async (payload) => {
      const scenario = scenarios.find((item) => item.payload.callDateTime === payload.callDateTime);
      assert.ok(scenario, `Scenario not found for payload ${payload.callDateTime}`);

      analyzeCalls.push({
        scenarioId: scenario.id,
        payload
      });

      return buildScenarioAnalysis({
        scenario,
        payload,
        employee: payload.employee
      });
    },
    sendTelegramMessage: async (payload) => {
      telegramCalls.push(payload);
      return {
        status: 'sent',
        httpStatus: 200,
        responsePayload: {
          ok: true
        }
      };
    },
    logger
  });

  for (const scenario of scenarios) {
    const result = await processCall(scenario.payload, {
      source: 'smoke_dialog_reconstruction',
      requestId: `smoke-${scenario.id}`
    });

    assert.equal(result.status, 'processed', `${scenario.title}: process result`);
  }

  assert.equal(analyzeCalls.length, scenarios.length, 'All scenarios must be analyzed');
  assert.equal(telegramCalls.length, scenarios.length, 'All scenarios must be sent to Telegram');

  for (const scenario of scenarios) {
    const analyzed = analyzeCalls.find((item) => item.scenarioId === scenario.id);
    const sent = telegramCalls.find((item) => item.callDateTime === scenario.payload.callDateTime);

    assert.ok(analyzed, `${scenario.title}: analyze call record missing`);
    assert.ok(sent, `${scenario.title}: telegram call record missing`);

    const analyzedEmployeeName = analyzed.payload.employee?.employeeName || '';
    assert.equal(
      analyzedEmployeeName,
      scenario.expectEmployeeName,
      `${scenario.title}: employee lookup mismatch in analyze payload`
    );

    const sentEmployeeName = sent.employee?.employeeName || '';
    assert.equal(
      sentEmployeeName,
      scenario.expectEmployeeName,
      `${scenario.title}: employee lookup mismatch in telegram payload`
    );

    const analysis = buildScenarioAnalysis({
      scenario,
      payload: scenario.payload,
      employee: sent.employee || null
    });

    const message = formatTelegramCallSummary({
      phone: scenario.payload.phone,
      callDateTime: scenario.payload.callDateTime,
      analysis,
      employee: sent.employee || null,
      callType: scenario.payload.callType,
      callerNumber: scenario.payload.callerNumber,
      calleeNumber: scenario.payload.calleeNumber,
      destinationNumber: scenario.payload.destinationNumber,
      timeZone: 'Europe/Moscow'
    });

    assert.ok(message.includes('Итог по фактам:'), `${scenario.title}: summary must contain outcome block`);
    assert.ok(!message.includes('Абонент:'), `${scenario.title}: obsolete subscriber line must be removed`);

    if (scenario.expectEmployeeName) {
      assert.ok(
        message.includes(`Сотрудник: ${scenario.expectEmployeeName}`),
        `${scenario.title}: summary should include employee line`
      );
      assert.ok(
        /\nСотрудник:[^\n]*\nТип звонка:[^\n]*$/.test(message),
        `${scenario.title}: "Тип звонка" must go after "Сотрудник" at message bottom`
      );
    } else {
      assert.ok(
        !message.includes('Сотрудник: Архивный сотрудник'),
        `${scenario.title}: inactive or unknown employee must not appear`
      );
      assert.ok(
        /\nТип звонка:[^\n]*$/.test(message),
        `${scenario.title}: "Тип звонка" must stay in message bottom`
      );
    }

    if (scenario.id === 'short_noisy') {
      assert.ok(
        message.toLowerCase().includes('шум'),
        'Short noisy transcript must preserve uncertainty context'
      );
    }

    if (scenario.id === 'long_without_labels') {
      assert.ok(
        message.toLowerCase().includes('суть запроса'),
        'Long transcript without labels must include extracted request essence'
      );
    }

    if (scenario.expectExplicitRoles) {
      assert.ok(
        message.includes('Клиент:'),
        'High-confidence scenario should use explicit role interpretation'
      );
    }

    if (scenario.expectLowConfidence) {
      assert.ok(
        analysis.speakerRoleConfidence < 0.5,
        'Low-confidence scenario must expose low speaker role confidence'
      );
      assert.ok(
        Array.isArray(analysis.analysisWarnings) && analysis.analysisWarnings.length > 0,
        'Low-confidence scenario must include warnings'
      );
    }

    if (scenario.expectNeutralTone) {
      assert.ok(
        message.includes('По разговору запрос:'),
        'Low-confidence scenario should use neutral summary style'
      );
      assert.ok(
        message.includes('Неопределенность:'),
        'Low-confidence scenario should include explicit uncertainty'
      );
      assert.ok(
        !message.includes('Итог по фактам: Клиент:'),
        'Low-confidence scenario should avoid explicit role attribution in wanted block'
      );
    }
  }

  process.stdout.write('Smoke dialog reconstruction flow: OK\n');
  process.stdout.write(`Scenarios covered: ${scenarios.length}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
