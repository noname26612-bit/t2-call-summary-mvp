const path = require('node:path');
const dotenv = require('dotenv');
const { loadConfig: loadGatewayConfig } = require('../../ai-gateway/src/config');
const { createOpenAIAnalyzer } = require('../../ai-gateway/src/openaiClient');
const { normalizeAndValidateAnalysis } = require('../services/analysisNormalizer');
const { formatTelegramCallSummary } = require('../services/telegramMessageFormatter');

const rootEnvPath = path.join(__dirname, '../../.env');
const gatewayEnvPath = path.join(__dirname, '../../ai-gateway/.env');
dotenv.config({ path: rootEnvPath, override: true });
dotenv.config({ path: gatewayEnvPath, override: true });

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    }
  };
}

const SCENARIOS = [
  {
    id: 'case_1_short_callback',
    title: 'перезвонить через 5 минут',
    transcript: 'Здравствуйте, сейчас неудобно, перезвоните через 5 минут.',
    payload: {
      callType: 'OUTGOING',
      callerNumber: '+74951230001',
      destinationNumber: '+79990000001',
      calleeNumber: '+79990000001',
      durationSec: 18,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedPath: 'bypass'
  },
  {
    id: 'case_2_busy_later',
    title: 'сейчас неудобно, давайте позже',
    transcript: 'Сейчас неудобно говорить, давайте позже созвонимся.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000002',
      destinationNumber: '+74951230001',
      calleeNumber: '+74951230001',
      durationSec: 20,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedPath: 'bypass'
  },
  {
    id: 'case_3_bad_connection',
    title: 'плохо слышно / связь',
    transcript: 'Плохо слышно, связь плохая, давайте позже.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000003',
      destinationNumber: '+74951230001',
      calleeNumber: '+74951230001',
      durationSec: 16,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'low_transcript_quality'
      }
    },
    expectedPath: 'bypass',
    employee: {
      employeeName: 'Михаил',
      employeeTitle: 'руководитель / менеджер',
      phoneNormalized: '+74951230001'
    }
  },
  {
    id: 'case_4_wrong_number',
    title: 'ошиблись номером',
    transcript: 'Извините, ошиблись номером, не туда попали.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000004',
      destinationNumber: '+74951230001',
      calleeNumber: '+74951230001',
      durationSec: 12,
      answered: true,
      shortCall: true,
      analyzeBypassHint: {
        reason: 'skipped_before_analyze:low_signal_transcript_skip',
        signalType: 'service_phrase_only'
      }
    },
    expectedPath: 'bypass',
    employee: {
      employeeName: 'Михаил',
      employeeTitle: 'руководитель / менеджер',
      phoneNormalized: '+74951230001'
    }
  },
  {
    id: 'case_5_short_price_term',
    title: 'короткий содержательный звонок по цене/сроку',
    transcript: 'Подтвердите цену и срок отгрузки, пожалуйста. Цена 120 тысяч, срок 3 дня, пришлите в WhatsApp.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000005',
      destinationNumber: '+74951230001',
      calleeNumber: '+74951230001',
      durationSec: 29,
      answered: true,
      shortCall: true
    },
    expectedPath: 'bypass',
    employee: {
      employeeName: 'Михаил',
      employeeTitle: 'руководитель / менеджер',
      phoneNormalized: '+74951230001'
    }
  },
  {
    id: 'case_6_batch_package_price_timing',
    title: 'партия / комплектность / цена / сроки',
    transcript: 'Нужен запуск партии 300 штук. Уточнили комплектность заказа: подшипники, ролики, ремкомплект. Обсудили цену и срок производства до конца недели. Итоговый запуск подтвердят после сверки склада сегодня вечером.',
    payload: {
      callType: 'INCOMING',
      callerNumber: '+79990000006',
      destinationNumber: '+74951230001',
      calleeNumber: '+74951230001',
      durationSec: 214,
      answered: true,
      shortCall: false
    },
    expectedPath: 'full_ai',
    employee: {
      employeeName: 'Михаил',
      employeeTitle: 'руководитель / менеджер',
      phoneNormalized: '+74951230001'
    }
  }
];

async function run() {
  const gatewayConfig = loadGatewayConfig();
  const analyzer = createOpenAIAnalyzer(gatewayConfig.openai, createLogger());

  for (const [index, scenario] of SCENARIOS.entries()) {
    const analyzePayload = {
      requestId: `local-report-${Date.now()}-${index + 1}`,
      callEventId: 1000 + index,
      callId: scenario.id,
      phone: scenario.payload.callType === 'OUTGOING'
        ? scenario.payload.destinationNumber
        : scenario.payload.callerNumber,
      callDateTime: `2026-03-25T1${index}:00:00+03:00`,
      transcript: scenario.transcript,
      transcriptLength: scenario.transcript.length,
      employeePhone: scenario.payload.destinationNumber,
      clientPhone: scenario.payload.callType === 'OUTGOING'
        ? scenario.payload.destinationNumber
        : scenario.payload.callerNumber,
      callDirectionContext: scenario.payload.callType === 'OUTGOING'
        ? 'outgoing_employee_to_client'
        : 'incoming_client_to_employee',
      whoCalledWhom: scenario.payload.callType === 'OUTGOING'
        ? `${scenario.payload.callerNumber} -> ${scenario.payload.destinationNumber}`
        : `${scenario.payload.callerNumber} -> ${scenario.payload.destinationNumber}`,
      employee: scenario.employee || null,
      ...scenario.payload
    };

    const analyzed = await analyzer(analyzePayload);
    const normalized = normalizeAndValidateAnalysis(analyzed, { transcript: scenario.transcript });
    const summaryText = formatTelegramCallSummary({
      phone: analyzePayload.phone,
      callDateTime: analyzePayload.callDateTime,
      analysis: normalized,
      employee: scenario.employee || null,
      callType: scenario.payload.callType,
      callerNumber: scenario.payload.callerNumber,
      calleeNumber: scenario.payload.calleeNumber,
      destinationNumber: scenario.payload.destinationNumber,
      timeZone: 'Europe/Moscow'
    });

    const pathUsed = analyzed?.aiUsage?.responseStatus === 'skipped' ? 'bypass' : 'full_ai';
    if (scenario.expectedPath && pathUsed !== scenario.expectedPath) {
      throw new Error(`${scenario.title}: expected path "${scenario.expectedPath}", got "${pathUsed}"`);
    }

    process.stdout.write(`===== ${index + 1}. ${scenario.title} =====\n`);
    process.stdout.write('Input:\n');
    process.stdout.write(`${JSON.stringify({
      transcript: scenario.transcript,
      callType: scenario.payload.callType,
      callerNumber: scenario.payload.callerNumber,
      calleeNumber: scenario.payload.calleeNumber,
      destinationNumber: scenario.payload.destinationNumber,
      durationSec: scenario.payload.durationSec,
      answered: scenario.payload.answered,
      shortCall: scenario.payload.shortCall,
      transcriptLength: scenario.transcript.length
    }, null, 2)}\n`);
    process.stdout.write(`Path: ${pathUsed}\n`);
    process.stdout.write(`Scenario: ${normalized.scenario || normalized.primaryScenario || 'Другое'}\n`);
    process.stdout.write(`AI usage: ${JSON.stringify({
      model: analyzed?.aiUsage?.model || '',
      responseStatus: analyzed?.aiUsage?.responseStatus || '',
      skipReason: analyzed?.aiUsage?.skipReason || '',
      promptTokens: analyzed?.aiUsage?.promptTokens ?? null,
      completionTokens: analyzed?.aiUsage?.completionTokens ?? null,
      totalTokens: analyzed?.aiUsage?.totalTokens ?? null,
      estimatedCostRub: analyzed?.aiUsage?.estimatedCostRub ?? null
    })}\n`);
    process.stdout.write('Summary:\n');
    process.stdout.write(`${summaryText}\n\n`);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
