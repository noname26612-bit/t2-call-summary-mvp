const path = require('node:path');
const dotenv = require('dotenv');
const { loadConfig } = require('../../ai-gateway/src/config');
const { createOpenAIAnalyzer } = require('../../ai-gateway/src/openaiClient');
const { normalizeAndValidateAnalysis } = require('../services/analysisNormalizer');
const { formatTelegramCallSummary } = require('../services/telegramMessageFormatter');

dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });
dotenv.config({ path: path.join(__dirname, '../../ai-gateway/.env'), override: true });

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    }
  };
}

const CASES = [
  {
    id: 'callback_5m',
    title: 'перезвоните через 5 минут',
    mode: 'analyzer',
    expectedPath: 'bypass',
    expectedScenario: 'Другое',
    transcript: 'Здравствуйте, сейчас неудобно, перезвоните через 5 минут.',
    payload: {
      callType: 'OUTGOING',
      callerNumber: '+74951230001',
      calleeNumber: '+79990000001',
      destinationNumber: '+79990000001',
      durationSec: 18,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79990000001
Когда звонил: 10:00, 25.03

Суть звонка: Попросили перезвонить через 5 минут.
Что обсуждали: Предметно вопрос не обсуждали.
Чем закончилось: Разговор перенесли.
Сценарий: Другое

Сотрудник: —
Тип звонка: Исходящий`
  },
  {
    id: 'busy_later',
    title: 'сейчас неудобно, давайте позже',
    mode: 'analyzer',
    expectedPath: 'bypass',
    expectedScenario: 'Другое',
    transcript: 'Сейчас неудобно говорить, давайте позже созвонимся.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000002',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 20,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79990000002
Когда звонил: 11:00, 25.03

Суть звонка: Собеседнику было неудобно говорить, попросили связаться позже.
Что обсуждали: Основной вопрос отложили без деталей.
Чем закончилось: Разговор перенесли на позже.
Сценарий: Другое

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'bad_connection',
    title: 'плохо слышно / связь',
    mode: 'analyzer',
    expectedPath: 'bypass',
    expectedScenario: 'Другое',
    transcript: 'Плохо слышно, связь плохая, давайте позже.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000003',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 16,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'low_transcript_quality'
      }
    },
    expectedOutput: `Кто звонил: +79990000003
Когда звонил: 12:00, 25.03

Суть звонка: Разговор прерывался из-за плохой связи.
Что обсуждали: Содержательную часть разобрать не удалось.
Чем закончилось: Договорились вернуться к разговору позже.
Важно: Плохо слышно, часть разговора неразборчива.
Сценарий: Другое

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'wrong_number',
    title: 'ошиблись номером',
    mode: 'analyzer',
    expectedPath: 'bypass',
    expectedScenario: 'Другое',
    transcript: 'Извините, ошиблись номером, не туда попали.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000004',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 12,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79990000004
Когда звонил: 13:00, 25.03

Суть звонка: Сообщили, что ошиблись номером.
Что обсуждали: Рабочий вопрос не обсуждали.
Чем закончилось: Звонок завершили как ошибочный.
Сценарий: Другое

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'short_price_term',
    title: 'короткий звонок по цене/сроку',
    mode: 'analyzer',
    expectedPath: 'bypass',
    expectedScenario: 'Заказ / производство',
    transcript: 'Подтвердите цену и срок отгрузки, пожалуйста. Цена 120 тысяч, срок 3 дня, пришлите в WhatsApp.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000005',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 29,
      answered: true,
      shortCall: true
    },
    expectedOutput: `Кто звонил: +79990000005
Когда звонил: 14:00, 25.03

Суть звонка: Коротко сверили цену и сроки.
Что обсуждали: Подтвердили цену 120 тысяч и срок 3 дня.
Чем закончилось: Попросили отправить подтверждение в WhatsApp.
Сценарий: Заказ / производство

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'order_production_scenario_normalization',
    title: 'партия / комплектность / цена / сроки',
    mode: 'fixture',
    expectedPath: 'full_ai',
    expectedScenario: 'Заказ / производство',
    transcript: 'Нужен запуск партии 300 штук. Уточнили комплектность заказа: подшипники, ролики, ремкомплект. Обсудили цену и срок производства до конца недели. Итоговый запуск подтвердят после сверки склада сегодня вечером.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000006',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001'
    },
    rawAnalysis: {
      category: 'продажа',
      scenario: 'Другое',
      topic: 'Запуск партии',
      callEssence: 'Обсудили запуск партии 300 штук.',
      whatDiscussed: 'Комплектность заказа, цену и срок производства.',
      outcome: 'Финальный запуск подтвердят после сверки склада.',
      summary: 'Обсудили запуск партии 300 штук.',
      result: 'Комплектность заказа, цену и срок производства.',
      nextStep: 'Уточнить окончательное подтверждение позже.',
      confidence: 0.92
    },
    expectedOutput: `Кто звонил: +79990000006
Когда звонил: 15:00, 25.03

Суть звонка: Обсудили запуск партии 300 штук.
Что обсуждали: Комплектность заказа, цену и срок производства.
Чем закончилось: Финальный запуск подтвердят после сверки склада.
Сценарий: Заказ / производство

Сотрудник: —
Тип звонка: Входящий`
  }
];

async function run() {
  const cfg = loadConfig();
  const analyzer = createOpenAIAnalyzer(cfg.openai, createSilentLogger());
  const errors = [];

  for (const [index, testCase] of CASES.entries()) {
    const basePayload = {
      requestId: `golden-report-${Date.now()}-${index + 1}`,
      callEventId: 7100 + index,
      callId: testCase.id,
      phone: testCase.payload.callType === 'OUTGOING'
        ? testCase.payload.destinationNumber
        : testCase.payload.callerNumber,
      callDateTime: `2026-03-25T1${index}:00:00+03:00`,
      transcript: testCase.transcript,
      transcriptLength: testCase.transcript.length,
      employeePhone: testCase.payload.destinationNumber,
      clientPhone: testCase.payload.callType === 'OUTGOING'
        ? testCase.payload.destinationNumber
        : testCase.payload.callerNumber,
      callDirectionContext: testCase.payload.callType === 'OUTGOING'
        ? 'outgoing_employee_to_client'
        : 'incoming_client_to_employee',
      whoCalledWhom: `${testCase.payload.callerNumber} -> ${testCase.payload.destinationNumber}`,
      ...testCase.payload
    };

    let analyzed;
    let pathUsed = 'full_ai';

    if (testCase.mode === 'analyzer') {
      analyzed = await analyzer(basePayload);
      pathUsed = analyzed?.aiUsage?.responseStatus === 'skipped' ? 'bypass' : 'full_ai';
    } else {
      analyzed = { ...(testCase.rawAnalysis || {}) };
      pathUsed = 'full_ai';
    }

    const normalized = normalizeAndValidateAnalysis(analyzed, { transcript: testCase.transcript });
    const output = formatTelegramCallSummary({
      phone: basePayload.phone,
      callDateTime: basePayload.callDateTime,
      analysis: normalized,
      callType: testCase.payload.callType,
      callerNumber: testCase.payload.callerNumber,
      calleeNumber: testCase.payload.calleeNumber,
      destinationNumber: testCase.payload.destinationNumber,
      timeZone: 'Europe/Moscow'
    });

    const actualScenario = normalized.scenario || normalized.primaryScenario || 'Другое';

    if (pathUsed !== testCase.expectedPath) {
      errors.push(`${testCase.title}: expected path "${testCase.expectedPath}", got "${pathUsed}"`);
    }

    if (actualScenario !== testCase.expectedScenario) {
      errors.push(`${testCase.title}: expected scenario "${testCase.expectedScenario}", got "${actualScenario}"`);
    }

    if (output !== testCase.expectedOutput) {
      errors.push(`${testCase.title}: formatted output mismatch`);
      process.stdout.write(`\n[${testCase.title}] expected:\n${testCase.expectedOutput}\n`);
      process.stdout.write(`\n[${testCase.title}] actual:\n${output}\n`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }
    process.exit(1);
  }

  process.stdout.write('Smoke report summary golden: OK\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
