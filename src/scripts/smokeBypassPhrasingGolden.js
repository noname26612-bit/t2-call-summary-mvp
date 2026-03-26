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
    id: 'phrasing_price_term_whatsapp',
    title: 'цена + срок + WhatsApp',
    expectedPath: 'bypass',
    expectedScenario: 'Заказ / производство',
    transcript: 'Цена 120 тысяч, срок 3 дня, пришлите подтверждение в WhatsApp.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79995550101',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 23,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79995550101
Когда звонил: 10:00, 25.03

Суть звонка: Коротко сверили цену и сроки.
Что обсуждали: Подтвердили цену 120 тысяч и срок 3 дня.
Чем закончилось: Попросили отправить подтверждение в WhatsApp.
Сценарий: Заказ / производство

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'phrasing_send_info_whatsapp',
    title: 'пришлите информацию в WhatsApp',
    expectedPath: 'bypass',
    expectedScenario: 'Другое',
    transcript: 'Пришлите, пожалуйста, краткую информацию в WhatsApp по вопросу.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79995550102',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 14,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79995550102
Когда звонил: 11:00, 25.03

Суть звонка: Попросили отправить информацию в WhatsApp.
Что обсуждали: Предметный вопрос подробно не обсуждали.
Чем закончилось: Ожидают сообщение в WhatsApp.
Сценарий: Другое

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'phrasing_send_info_email',
    title: 'отправьте информацию на почту',
    expectedPath: 'bypass',
    expectedScenario: 'Другое',
    transcript: 'Отправьте информацию на почту, пожалуйста.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79995550103',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 15,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79995550103
Когда звонил: 12:00, 25.03

Суть звонка: Попросили отправить информацию на почту.
Что обсуждали: Предметный вопрос подробно не обсуждали.
Чем закончилось: Ожидают письмо с деталями.
Сценарий: Другое

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'phrasing_term_confirmation',
    title: 'короткое подтверждение срока отгрузки',
    expectedPath: 'bypass',
    expectedScenario: 'Доставка',
    transcript: 'Коротко подтвердили срок отгрузки: 2 дня, без подробностей.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79995550104',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 17,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79995550104
Когда звонил: 13:00, 25.03

Суть звонка: Коротко уточнили срок отгрузки.
Что обсуждали: Подтвердили срок отгрузки 2 дня.
Чем закончилось: Срок и условия отгрузки подтвердили.
Сценарий: Доставка

Сотрудник: —
Тип звонка: Входящий`
  },
  {
    id: 'phrasing_term_confirmation_email',
    title: 'срок отгрузки + отправьте подтверждение на почту',
    expectedPath: 'bypass',
    expectedScenario: 'Доставка',
    transcript: 'Срок отгрузки 4 дня, отправьте подтверждение на почту.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79995550105',
      calleeNumber: '+74951230001',
      destinationNumber: '+74951230001',
      durationSec: 21,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedOutput: `Кто звонил: +79995550105
Когда звонил: 14:00, 25.03

Суть звонка: Коротко уточнили срок отгрузки.
Что обсуждали: Подтвердили срок отгрузки 4 дня.
Чем закончилось: Попросили отправить подтверждение на почту.
Сценарий: Доставка

Сотрудник: —
Тип звонка: Входящий`
  }
];

async function run() {
  const cfg = loadConfig();
  const analyzer = createOpenAIAnalyzer(cfg.openai, createSilentLogger());
  const errors = [];

  for (const [index, testCase] of CASES.entries()) {
    const payload = {
      requestId: `golden-bypass-phrasing-${Date.now()}-${index + 1}`,
      callEventId: 7300 + index,
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

    const analyzed = await analyzer(payload);
    const normalized = normalizeAndValidateAnalysis(analyzed, { transcript: testCase.transcript });
    const output = formatTelegramCallSummary({
      phone: payload.phone,
      callDateTime: payload.callDateTime,
      analysis: normalized,
      callType: testCase.payload.callType,
      callerNumber: testCase.payload.callerNumber,
      calleeNumber: testCase.payload.calleeNumber,
      destinationNumber: testCase.payload.destinationNumber,
      timeZone: 'Europe/Moscow'
    });

    const pathUsed = analyzed?.aiUsage?.responseStatus === 'skipped' ? 'bypass' : 'full_ai';
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

  process.stdout.write('Smoke bypass phrasing golden: OK\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
