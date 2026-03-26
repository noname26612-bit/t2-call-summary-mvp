const crypto = require('crypto');
const fs = require('fs');
const OpenAI = require('openai');
const os = require('os');
const path = require('path');

const ANALYSIS_CATEGORIES = Object.freeze([
  'продажа',
  'сервис',
  'запчасти',
  'аренда',
  'спам',
  'прочее'
]);

const ANALYSIS_PRIORITIES = Object.freeze(['low', 'medium', 'high']);
const PRIMARY_SCENARIOS = Object.freeze([
  'Запчасти',
  'Аренда',
  'Ремонт',
  'Заказ / производство',
  'Доставка',
  'Другое'
]);
const REPAIR_TYPES = Object.freeze(['капитальный', 'выездной']);

const MAX_TEXT_LENGTH = Object.freeze({
  topic: 80,
  callEssence: 220,
  whatDiscussed: 280,
  summary: 220,
  result: 280,
  outcome: 180,
  nextStep: 180,
  importantNote: 180,
  transcriptPlain: 20000,
  participantsAssumption: 120,
  detectedClientSpeaker: 80,
  detectedEmployeeSpeaker: 80,
  clientGoal: 220,
  employeeResponse: 220,
  issueReason: 220,
  nextStepStructured: 220,
  analysisWarningItem: 180,
  reconstructedTurnSpeaker: 80,
  reconstructedTurnText: 220,
  wantedSummary: 420,
  partsItem: 80,
  rentalStart: 80,
  rentalDuration: 80,
  rentalAddress: 180,
  repairEquipment: 120,
  repairDateOrTerm: 80,
  repairAddress: 180,
  deliveryDetails: 180,
  companyName: 120,
  orderNumber: 64
});

const MAX_TRANSCRIBE_AUDIO_BYTES = 20 * 1024 * 1024;
const POLZA_PROVIDER = 'polza';
const POLZA_TRANSCRIPTIONS_ENDPOINT = '/audio/transcriptions';

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'category',
    'scenario',
    'callEssence',
    'whatDiscussed',
    'outcome',
    'confidence'
  ],
  properties: {
    category: {
      type: 'string',
      enum: ANALYSIS_CATEGORIES
    },
    scenario: {
      type: 'string',
      enum: PRIMARY_SCENARIOS
    },
    callEssence: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.callEssence
    },
    whatDiscussed: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.whatDiscussed
    },
    topic: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.topic
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.summary
    },
    outcome: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.outcome
    },
    importantNote: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.importantNote
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1
    },
    result: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.result
    },
    nextStep: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.nextStep
    },
    priority: {
      type: 'string',
      enum: ANALYSIS_PRIORITIES
    },
    tags: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 32
      }
    },
    primaryScenario: {
      type: 'string',
      enum: PRIMARY_SCENARIOS
    },
    wantedSummary: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.wantedSummary
    },
    analysisWarnings: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TEXT_LENGTH.analysisWarningItem
      }
    }
  }
};

const SYSTEM_PROMPT = `
Ты готовишь краткий рабочий отчет по звонку для памяти менеджера.
Формат: report-oriented, не action-oriented.
Не навязывай "следующий шаг", не пиши канцелярит, не выдумывай детали.
Верни строго JSON-объект без markdown и без пояснений.

Обязательные поля:
- category: одно значение из [продажа, сервис, запчасти, аренда, спам, прочее].
- scenario: одно значение из [Запчасти, Аренда, Ремонт, Заказ / производство, Доставка, Другое].
- callEssence: 1 короткая фраза "о чем звонок" (для строки "Суть звонка").
- whatDiscussed: 1-2 короткие фразы "что конкретно обсуждали".
- outcome: 1 короткая фраза "чем закончилось".
- confidence: число 0..1.

Опционально:
- importantNote: только если реально нужна важная пометка:
  - часть разговора неразборчива;
  - термин/название распознано неуверенно;
  - разговор очень короткий и контекста мало;
  - иная критичная оговорка для памяти.
- topic / tags / priority / primaryScenario / wantedSummary / summary / result / nextStep можно заполнять кратко для совместимости.

Жесткие правила:
- не додумывай факты, которых нет в transcript.
- если данных мало, пиши сдержанно и коротко.
- избегай формулировок вида "Итог по фактам", "По разговору запрос", "Неопределенность", "Основная тема".
- если разговор технический/короткий, фиксируй это прямо и без лишней аналитики.
`;

const PRIMARY_SCENARIO_BY_CATEGORY = Object.freeze({
  запчасти: 'Запчасти',
  аренда: 'Аренда',
  сервис: 'Ремонт',
  продажа: 'Заказ / производство',
  спам: 'Другое',
  прочее: 'Другое'
});

const PRIMARY_SCENARIO_ALIASES = Object.freeze({
  запчасти: 'Запчасти',
  запчасть: 'Запчасти',
  parts: 'Запчасти',
  аренда: 'Аренда',
  прокат: 'Аренда',
  rental: 'Аренда',
  ремонт: 'Ремонт',
  сервис: 'Ремонт',
  service: 'Ремонт',
  заказ: 'Заказ / производство',
  производство: 'Заказ / производство',
  партия: 'Заказ / производство',
  запуск: 'Заказ / производство',
  заказ_производство: 'Заказ / производство',
  order_production: 'Заказ / производство',
  доставка: 'Доставка',
  логистика: 'Доставка',
  delivery: 'Доставка',
  другое: 'Другое',
  прочее: 'Другое',
  unknown: 'Другое'
});

const EMPTY_OPTIONAL_TEXT_TOKENS = new Set([
  '-',
  '—',
  'нет',
  'не указано',
  'n/a',
  'na',
  'none',
  'unknown',
  'null',
  'undefined'
]);

const BYPASS_REASON = Object.freeze({
  PRE_ANALYZE_HINT: 'bypass:pre_analyze_hint',
  SHORT_OR_WEAK_TRANSCRIPT: 'bypass:short_or_weak_transcript',
  SHORT_CALL_TECHNICAL: 'bypass:short_call_technical'
});

const CALLBACK_OR_TRANSFER_PATTERNS = [
  /перезвон/,
  /позвоните позже/,
  /созвон(?:имся|итесь|иться) позже/,
  /перенес(?:ем|ли|ите)/,
  /потом/,
  /позже/,
  /неудобно говорить/,
  /занят/,
  /на совещани[еи]/,
  /сейчас не могу/
];

const CALLBACK_TIME_HINT_PATTERNS = [
  /через\s+[а-яё0-9]+\s*(?:минут[ауы]?|час[ао]?[в]?)/i,
  /(?:сегодня\s+вечером|вечером|завтра(?:\s+утром|\s+днем|\s+вечером)?|после\s+обеда)/i,
  /(?:после|к)\s+\d{1,2}(?::|\.)\d{2}/i,
  /в\s+\d{1,2}(?::|\.)\d{2}/i
];

const WRONG_NUMBER_PATTERNS = [
  /ошиб(?:лись|ся)\s+номер(?:ом)?/,
  /не\s+туда\s+попал(?:и)?/,
  /ошибочн(?:ый|ое)\s+номер/,
  /не\s+тому\s+позвонил(?:и)?/
];

const BUSY_OR_INCONVENIENT_PATTERNS = [
  /неудобно\s+говорить/,
  /сейчас\s+не\s+могу/,
  /занят[аы]?/,
  /на\s+совещани[еи]/,
  /за\s+рулем/,
  /без\s+возможности\s+говорить/
];

const SEND_INFO_PATTERNS = [
  /пришл(?:ите|и)/,
  /отправ(?:ьте|ь)/,
  /вышл(?:ите|и)/,
  /напиш(?:ите|и)/,
  /скин(?:ьте|ь)/,
  /в\s+whatsapp/,
  /в\s+ватсап/,
  /в\s+telegram/,
  /в\s+телеграм/,
  /на\s+почту/
];

const DISCUSS_LATER_PATTERNS = [
  /обсудим\s+позже/,
  /позже\s+обсудим/,
  /верн[её]мся\s+к\s+вопросу\s+позже/,
  /созвон(?:имся|итесь)\s+позже/,
  /потом\s+обсудим/
];

const PRICE_SIGNAL_TOKENS = [
  'цена',
  'стоим',
  'руб',
  'тыс',
  'тысяч'
];

const TERM_SIGNAL_TOKENS = [
  'срок',
  'день',
  'дня',
  'дней',
  'недел',
  'отгруз',
  'выезд',
  'достав',
  'запуск'
];

const ORDER_PRODUCTION_SIGNAL_TOKENS = [
  'заказ',
  'парт',
  'производств',
  'запуск',
  'комплектност',
  'изготов',
  'тираж',
  'количеств'
];

const DELIVERY_SIGNAL_TOKENS = [
  'доставк',
  'логист',
  'самовывоз',
  'погруз',
  'разгруз',
  'курьер',
  'маршрут',
  'водител',
  'отгруз'
];

const WEAK_AUDIO_PATTERNS = [
  /не слышно/,
  /плохо слышно/,
  /связь плохая/,
  /шум/,
  /прерыва(ется|ется)/,
  /тихо/,
  /эхо/
];

const NO_SUBJECT_PATTERNS = [
  /алло/,
  /ага/,
  /угу/,
  /до связи/,
  /спасибо/,
  /пока/
];

const BUSINESS_WORD_PREFIXES = [
  'аренд',
  'прокат',
  'ремонт',
  'сервис',
  'запчаст',
  'достав',
  'заказ',
  'цен',
  'стоим',
  'коммерч',
  'договор',
  'счет',
  'оплат',
  'клиент',
  'техник',
  'погруз',
  'экскават',
  'трактор',
  'детал',
  'масл',
  'фильтр',
  'подшип'
];

class OpenAIClientError extends Error {
  constructor(message, statusCode = 502, code = 'POLZA_CLIENT_ERROR') {
    super(message);
    this.name = 'OpenAIClientError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function stringFromUnknown(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return '';
}

function normalizeRequestId(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value.trim().slice(0, 128);
}

function normalizeCallEventId(value) {
  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (isNonEmptyString(value) && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeTokenCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (isNonEmptyString(value) && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function toRoundedNumber(value, digits = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function normalizeEstimatedCostRub(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return toRoundedNumber(value, 6);
  }

  if (isNonEmptyString(value) && /^[0-9]+([.,][0-9]+)?$/.test(value.trim())) {
    const parsed = Number.parseFloat(value.trim().replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return toRoundedNumber(parsed, 6);
    }
  }

  return null;
}

function resolveTotalTokens(promptTokens, completionTokens, totalTokensRaw) {
  const totalTokens = normalizeTokenCount(totalTokensRaw);
  if (Number.isInteger(totalTokens)) {
    return totalTokens;
  }

  if (Number.isInteger(promptTokens) && Number.isInteger(completionTokens)) {
    return promptTokens + completionTokens;
  }

  return null;
}

function extractCompletionUsage(completion) {
  const usage = completion?.usage || {};
  const promptTokens = normalizeTokenCount(usage.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage.completion_tokens);
  const totalTokens = resolveTotalTokens(promptTokens, completionTokens, usage.total_tokens);
  const costRub = normalizeEstimatedCostRub(usage.cost_rub ?? usage.cost);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costRub
  };
}

function buildAnalyzeEstimatedCostRub({ promptTokens, completionTokens, pricing }) {
  const inputRate = Number.isFinite(pricing?.analyzeInputRubPer1kTokens)
    ? Number(pricing.analyzeInputRubPer1kTokens)
    : null;
  const outputRate = Number.isFinite(pricing?.analyzeOutputRubPer1kTokens)
    ? Number(pricing.analyzeOutputRubPer1kTokens)
    : null;

  if (inputRate === null || outputRate === null) {
    return null;
  }

  if (!Number.isInteger(promptTokens) || !Number.isInteger(completionTokens)) {
    return null;
  }

  const costRub = (promptTokens / 1000) * inputRate + (completionTokens / 1000) * outputRate;
  return toRoundedNumber(costRub, 6);
}

function getTranscriptChars(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  return value.trim().length;
}

function normalizeDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.max(0, Math.round(value));
}

function normalizeOptionalInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }

  if (isNonEmptyString(value)) {
    const normalized = value.trim().replace(',', '.');
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
      const parsed = Number.parseFloat(normalized);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.round(parsed);
      }
    }
  }

  return null;
}

function normalizeOptionalBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  if (isNonEmptyString(value)) {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'да'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'n', 'нет'].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function normalizeCallTypeToken(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  const normalized = value.trim().toUpperCase();
  if (['INCOMING', 'INBOUND', 'SINGLE_CHANNEL'].includes(normalized)) {
    return 'INCOMING';
  }

  if (['OUTGOING', 'OUTBOUND'].includes(normalized)) {
    return 'OUTGOING';
  }

  return '';
}

function normalizeTranscriptForBypass(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTranscriptWords(value) {
  if (!value) {
    return [];
  }

  return value.match(/[a-zа-яё0-9]+/gi) || [];
}

function hasBusinessSignal(words = []) {
  return words.some((word) => BUSINESS_WORD_PREFIXES.some((prefix) => word.startsWith(prefix)));
}

function extractCallbackTimeHint(rawTranscript) {
  const source = stringFromUnknown(rawTranscript);
  if (!source) {
    return '';
  }

  for (const pattern of CALLBACK_TIME_HINT_PATTERNS) {
    const match = source.match(pattern);
    if (match && isNonEmptyString(match[0])) {
      return normalizeWhitespace(match[0]).toLowerCase();
    }
  }

  return '';
}

function detectSendChannel({ rawTranscript, normalizedTranscript }) {
  const source = `${stringFromUnknown(rawTranscript)} ${stringFromUnknown(normalizedTranscript)}`.toLowerCase();
  if (!source) {
    return '';
  }

  if (source.includes('whatsapp') || source.includes('ватсап') || source.includes('вацап')) {
    return 'whatsapp';
  }

  if (source.includes('telegram') || source.includes('телеграм')) {
    return 'telegram';
  }

  if (source.includes('почт') || source.includes('email') || source.includes('e-mail')) {
    return 'email';
  }

  return '';
}

function normalizeDetailPhrase(value) {
  return normalizeWhitespace(value)
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

function extractPriceDetail(rawTranscript) {
  const source = stringFromUnknown(rawTranscript);
  if (!source) {
    return '';
  }

  const valueMatch = source.match(/(?:цена|стоимость)\s*(?:[:\-]?\s*)?([0-9][0-9\s]*(?:[.,][0-9]+)?\s*(?:тыс(?:яч)?|млн|руб(?:\.|лей|ля)?|₽)?)/i);
  if (valueMatch && isNonEmptyString(valueMatch[1])) {
    return normalizeDetailPhrase(valueMatch[1]).toLowerCase();
  }

  return '';
}

function extractTermDetail(rawTranscript) {
  const source = stringFromUnknown(rawTranscript);
  if (!source) {
    return '';
  }

  const durationValuePattern = '([0-9][0-9\\s]*(?:[.,][0-9]+)?\\s*(?:минут(?:а|ы|у)?|час(?:а|ов)?|дн(?:я|ей)?|день|недел(?:я|и|ю|ь)|месяц(?:а|ев)?))';
  const termWithShipment = source.match(new RegExp(`срок\\s+отгрузки\\s*(?:[:\\-]?\\s*)?${durationValuePattern}`, 'i'));
  if (termWithShipment && isNonEmptyString(termWithShipment[1])) {
    return `срок отгрузки ${normalizeDetailPhrase(termWithShipment[1]).toLowerCase()}`;
  }

  const plainTerm = source.match(new RegExp(`срок\\s*(?:[:\\-]?\\s*)?${durationValuePattern}`, 'i'));
  if (plainTerm && isNonEmptyString(plainTerm[1])) {
    return `срок ${normalizeDetailPhrase(plainTerm[1]).toLowerCase()}`;
  }

  const shipmentTerm = source.match(new RegExp(`отгрузк[аи]?\\s*(?:[:\\-]?\\s*)?${durationValuePattern}`, 'i'));
  if (shipmentTerm && isNonEmptyString(shipmentTerm[1])) {
    return `срок отгрузки ${normalizeDetailPhrase(shipmentTerm[1]).toLowerCase()}`;
  }

  if (/срок\s+отгрузки/i.test(source) || /отгрузк/i.test(source)) {
    return 'срок отгрузки';
  }

  if (/срок/i.test(source)) {
    return 'срок';
  }

  return '';
}

function buildPriceTermWhatDiscussed({ priceDetail, termDetail }) {
  if (isNonEmptyString(priceDetail) && isNonEmptyString(termDetail)) {
    return `Подтвердили цену ${priceDetail} и ${termDetail}.`;
  }

  if (isNonEmptyString(priceDetail)) {
    return `Подтвердили цену ${priceDetail}.`;
  }

  if (isNonEmptyString(termDetail)) {
    return `Подтвердили ${termDetail}.`;
  }

  return 'Коротко сверили цену и срок без подробного обсуждения.';
}

function formatSendChannelDestination(sendChannel) {
  if (sendChannel === 'whatsapp') {
    return 'в WhatsApp';
  }

  if (sendChannel === 'telegram') {
    return 'в Telegram';
  }

  if (sendChannel === 'email') {
    return 'на почту';
  }

  return '';
}

function detectShortIntent({ rawTranscript, normalizedTranscript }) {
  const hasWrongNumberSignal = WRONG_NUMBER_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  if (hasWrongNumberSignal) {
    return { type: 'wrong_number' };
  }

  const hasWeakAudioSignal = WEAK_AUDIO_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  if (hasWeakAudioSignal) {
    return { type: 'bad_connection' };
  }

  const busyOrInconvenient = BUSY_OR_INCONVENIENT_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  if (busyOrInconvenient) {
    return { type: 'busy_later' };
  }

  const callbackRequested = CALLBACK_OR_TRANSFER_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  if (callbackRequested) {
    return {
      type: 'callback_request',
      callbackTimeHint: extractCallbackTimeHint(rawTranscript)
    };
  }

  const hasPriceSignal = hasAnyToken(normalizedTranscript, PRICE_SIGNAL_TOKENS);
  const hasTermSignal = hasAnyToken(normalizedTranscript, TERM_SIGNAL_TOKENS);
  const hasSendInfoSignal = SEND_INFO_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  const sendChannel = detectSendChannel({ rawTranscript, normalizedTranscript });

  if (hasPriceSignal && hasTermSignal) {
    return {
      type: 'price_term_confirmation',
      priceDetail: extractPriceDetail(rawTranscript),
      termDetail: extractTermDetail(rawTranscript),
      sendInfoRequested: hasSendInfoSignal,
      sendChannel
    };
  }

  if (hasTermSignal) {
    return {
      type: 'term_confirmation',
      termDetail: extractTermDetail(rawTranscript),
      sendInfoRequested: hasSendInfoSignal,
      sendChannel
    };
  }

  if (hasSendInfoSignal) {
    return {
      type: 'send_info',
      sendChannel
    };
  }

  const discussLater = DISCUSS_LATER_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  if (discussLater) {
    return { type: 'discuss_later' };
  }

  if (NO_SUBJECT_PATTERNS.some((pattern) => pattern.test(normalizedTranscript))) {
    return { type: 'no_subject' };
  }

  return { type: 'generic_short' };
}

function buildAnalyzeBypassDecision(payload) {
  const transcript = normalizeOptionalText(payload?.transcript, MAX_TEXT_LENGTH.transcriptPlain);
  const normalizedTranscript = normalizeTranscriptForBypass(transcript);
  const transcriptLengthMeta = normalizeOptionalInteger(payload?.transcriptLength);
  const transcriptLength = Number.isInteger(transcriptLengthMeta)
    ? transcriptLengthMeta
    : normalizedTranscript.length;
  const durationSec = normalizeOptionalInteger(payload?.durationSec);
  const shortCallFlag = normalizeOptionalBoolean(payload?.shortCall);
  const bypassHint = payload?.analyzeBypassHint && typeof payload.analyzeBypassHint === 'object'
    ? payload.analyzeBypassHint
    : null;
  const shortIntent = detectShortIntent({
    rawTranscript: transcript,
    normalizedTranscript
  });

  if (bypassHint && isNonEmptyString(bypassHint.reason)) {
    return {
      shouldBypass: true,
      reason: BYPASS_REASON.PRE_ANALYZE_HINT,
      kind: shortIntent.type,
      shortIntent,
      hintReason: normalizeOptionalText(bypassHint.reason, 120),
      transcriptLength,
      durationSec
    };
  }

  const words = tokenizeTranscriptWords(normalizedTranscript);
  const meaningfulWords = words.filter((word) => word.length > 2);
  const businessSignalDetected = hasBusinessSignal(words);
  const callbackPhraseDetected = CALLBACK_OR_TRANSFER_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  const weakAudioSignalDetected = WEAK_AUDIO_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
  const callbackLikelyTechnical = callbackPhraseDetected
    && !businessSignalDetected
    && (
      transcriptLength <= 180
      || (shortCallFlag === true && transcriptLength <= 220)
      || (Number.isInteger(durationSec) && durationSec <= 35 && transcriptLength <= 260)
      || meaningfulWords.length <= 5
    );
  const isTechnicalShortPhrase = weakAudioSignalDetected || callbackLikelyTechnical;

  if (
    isTechnicalShortPhrase
    || (shortCallFlag === true && transcriptLength <= 220)
    || (Number.isInteger(durationSec) && durationSec <= 35 && transcriptLength <= 260)
    || transcriptLength <= 70
    || (!businessSignalDetected && meaningfulWords.length <= 3 && transcriptLength <= 120)
  ) {
    return {
      shouldBypass: true,
      reason: isTechnicalShortPhrase ? BYPASS_REASON.SHORT_CALL_TECHNICAL : BYPASS_REASON.SHORT_OR_WEAK_TRANSCRIPT,
      kind: shortIntent.type,
      shortIntent,
      hintReason: '',
      transcriptLength,
      durationSec
    };
  }

  return {
    shouldBypass: false,
    reason: '',
    kind: '',
    shortIntent: null,
    hintReason: '',
    transcriptLength,
    durationSec
  };
}

function inferCategoryFromScenario(scenario) {
  if (scenario === 'Запчасти') {
    return 'запчасти';
  }

  if (scenario === 'Аренда') {
    return 'аренда';
  }

  if (scenario === 'Заказ / производство') {
    return 'продажа';
  }

  if (scenario === 'Ремонт' || scenario === 'Доставка') {
    return 'сервис';
  }

  return 'прочее';
}

function buildBypassCoreReport({ shortIntent, transcriptLength, hintReason, normalizedTranscript }) {
  const intentType = shortIntent?.type || 'generic_short';
  let callEssence = 'Короткий контакт по рабочему вопросу.';
  let whatDiscussed = 'Предметные детали в разговоре не успели обсудить.';
  let outcome = 'Договоренности перенесли на следующий контакт.';
  let nextStep = 'Ожидать следующий контакт.';
  let importantNote = '';

  if (intentType === 'callback_request') {
    const callbackTimeHint = normalizeOptionalText(shortIntent?.callbackTimeHint, 64);
    callEssence = callbackTimeHint
      ? `Попросили перезвонить ${callbackTimeHint}.`
      : 'Попросили перезвонить позже.';
    whatDiscussed = 'Предметно вопрос не обсуждали.';
    outcome = 'Разговор перенесли.';
    nextStep = 'Созвониться в согласованное время.';
  } else if (intentType === 'busy_later') {
    callEssence = 'Собеседнику было неудобно говорить, попросили связаться позже.';
    whatDiscussed = 'Основной вопрос отложили без деталей.';
    outcome = 'Разговор перенесли на позже.';
    nextStep = 'Повторить контакт позже.';
  } else if (intentType === 'bad_connection') {
    callEssence = 'Разговор прерывался из-за плохой связи.';
    whatDiscussed = 'Содержательную часть разобрать не удалось.';
    outcome = 'Договорились вернуться к разговору позже.';
    nextStep = 'Повторить звонок при стабильной связи.';
    importantNote = 'Плохо слышно, часть разговора неразборчива.';
  } else if (intentType === 'wrong_number') {
    callEssence = 'Сообщили, что ошиблись номером.';
    whatDiscussed = 'Рабочий вопрос не обсуждали.';
    outcome = 'Звонок завершили как ошибочный.';
    nextStep = 'Дальнейшие действия не требуются.';
  } else if (intentType === 'price_term_confirmation') {
    const priceDetail = normalizeOptionalText(shortIntent?.priceDetail, 80).toLowerCase();
    const termDetail = normalizeOptionalText(shortIntent?.termDetail, 90).toLowerCase();
    const sendDestination = formatSendChannelDestination(shortIntent?.sendChannel);
    callEssence = 'Коротко сверили цену и сроки.';
    whatDiscussed = buildPriceTermWhatDiscussed({ priceDetail, termDetail });

    if (shortIntent?.sendInfoRequested) {
      outcome = sendDestination
        ? `Попросили отправить подтверждение ${sendDestination}.`
        : 'Попросили отправить подтверждение сообщением.';
      nextStep = sendDestination
        ? `Отправить подтверждение ${sendDestination}.`
        : 'Отправить подтверждение цены и сроков сообщением.';
    } else {
      outcome = 'Ключевые условия подтвердили.';
      nextStep = 'Уточнить детали на следующем созвоне.';
    }
  } else if (intentType === 'term_confirmation') {
    const termDetail = normalizeOptionalText(shortIntent?.termDetail, 90).toLowerCase();
    const sendDestination = formatSendChannelDestination(shortIntent?.sendChannel);
    const isShipmentTerm = termDetail.includes('отгруз');
    callEssence = isShipmentTerm ? 'Коротко уточнили срок отгрузки.' : 'Коротко уточнили сроки.';
    whatDiscussed = isNonEmptyString(termDetail)
      ? `Подтвердили ${termDetail}.`
      : 'Коротко подтвердили срок без подробного обсуждения.';

    if (shortIntent?.sendInfoRequested) {
      outcome = sendDestination
        ? `Попросили отправить подтверждение ${sendDestination}.`
        : 'Попросили отправить подтверждение сообщением.';
      nextStep = sendDestination
        ? `Отправить подтверждение ${sendDestination}.`
        : 'Отправить подтверждение сообщением.';
    } else {
      outcome = isShipmentTerm
        ? 'Срок и условия отгрузки подтвердили.'
        : 'Срок подтвердили в коротком контакте.';
      nextStep = 'Вернуться к деталям в следующем контакте.';
    }
  } else if (intentType === 'send_info') {
    const sendDestination = formatSendChannelDestination(shortIntent?.sendChannel);
    callEssence = sendDestination
      ? `Попросили отправить информацию ${sendDestination}.`
      : 'Попросили отправить информацию сообщением.';
    whatDiscussed = 'Предметный вопрос подробно не обсуждали.';
    outcome = shortIntent?.sendChannel === 'email'
      ? 'Ожидают письмо с деталями.'
      : sendDestination
        ? `Ожидают сообщение ${sendDestination}.`
        : 'Ожидают сообщение с деталями.';
    nextStep = sendDestination
      ? `Отправить согласованную информацию ${sendDestination}.`
      : 'Отправить согласованную информацию сообщением.';
  } else if (intentType === 'discuss_later') {
    callEssence = 'Подтвердили, что вопрос обсудят позже.';
    whatDiscussed = 'Детали оставили на следующий разговор.';
    outcome = 'Обсуждение перенесли.';
    nextStep = 'Вернуться к вопросу в следующем контакте.';
  } else if (intentType === 'no_subject') {
    callEssence = 'Короткий технический контакт без предметного обсуждения.';
    whatDiscussed = 'Предметно вопрос не обсуждали.';
    outcome = 'Разговор завершили без фиксации деталей.';
    nextStep = 'Дождаться следующего содержательного контакта.';
  } else {
    callEssence = 'Короткий технический перенос разговора.';
    whatDiscussed = 'Предметно вопрос не обсуждали.';
    outcome = 'Обсуждение перенесли на следующий контакт.';
    nextStep = 'Вернуться к вопросу в следующем звонке.';
  }

  if (!importantNote && transcriptLength <= 40) {
    importantNote = 'Разговор очень короткий, контекста мало.';
  }

  if (!importantNote && isNonEmptyString(hintReason)) {
    importantNote = `Ограничение качества исходных данных: ${hintReason}.`;
  }

  if (!importantNote && normalizedTranscript && normalizedTranscript.length <= 24) {
    importantNote = 'По записи мало текста для уверенного вывода.';
  }

  return {
    callEssence: normalizeText(callEssence, MAX_TEXT_LENGTH.callEssence),
    whatDiscussed: normalizeText(whatDiscussed, MAX_TEXT_LENGTH.whatDiscussed),
    outcome: normalizeText(outcome, MAX_TEXT_LENGTH.outcome),
    nextStep: normalizeText(nextStep, MAX_TEXT_LENGTH.nextStep),
    importantNote: normalizeOptionalText(importantNote, MAX_TEXT_LENGTH.importantNote)
  };
}

function buildBypassAnalysis(payload, bypassDecision) {
  const normalizedTranscript = normalizeTranscriptForBypass(payload?.transcript || '');
  const scenario = normalizePrimaryScenario(
    payload?.scenario,
    'прочее',
    normalizedTranscript
  );
  const category = inferCategoryFromScenario(scenario);
  const report = buildBypassCoreReport({
    shortIntent: bypassDecision.shortIntent,
    transcriptLength: bypassDecision.transcriptLength,
    hintReason: bypassDecision.hintReason,
    normalizedTranscript
  });

  const wantedLines = [
    report.callEssence,
    report.whatDiscussed,
    report.outcome
  ].filter(Boolean);

  const normalized = {
    category,
    scenario,
    primaryScenario: scenario,
    topic: normalizeText(report.callEssence, MAX_TEXT_LENGTH.topic) || 'Короткий технический контакт',
    callEssence: report.callEssence,
    whatDiscussed: report.whatDiscussed,
    outcome: report.outcome,
    summary: report.callEssence,
    result: report.whatDiscussed,
    nextStep: report.nextStep,
    priority: 'low',
    tags: ['звонок', 'короткий-контакт'],
    confidence: 0.34,
    wantedSummary: clampMultilineText(wantedLines.join('\n'), MAX_TEXT_LENGTH.wantedSummary),
    participantsAssumption: 'Предположение: два участника разговора (клиент и сотрудник).',
    analysisPath: 'bypass',
    bypassReason: bypassDecision.reason
  };

  if (report.importantNote) {
    normalized.importantNote = report.importantNote;
    normalized.analysisWarnings = [report.importantNote];
  }

  return normalized;
}

function buildAiUsageEvent({
  payload,
  operation,
  model,
  promptTokens = null,
  completionTokens = null,
  totalTokens = null,
  transcriptCharsRaw = null,
  transcriptCharsSent = null,
  durationMs = null,
  responseStatus,
  skipReason = '',
  estimatedCostRub = null
}) {
  return {
    xRequestId: normalizeRequestId(payload?.requestId),
    callEventId: normalizeCallEventId(payload?.callEventId),
    callId: isNonEmptyString(payload?.callId) ? payload.callId.trim().slice(0, 256) : '',
    operation,
    model: isNonEmptyString(model) ? model.trim() : '',
    provider: POLZA_PROVIDER,
    promptTokens: normalizeTokenCount(promptTokens),
    completionTokens: normalizeTokenCount(completionTokens),
    totalTokens: resolveTotalTokens(
      normalizeTokenCount(promptTokens),
      normalizeTokenCount(completionTokens),
      totalTokens
    ),
    transcriptCharsRaw: normalizeTokenCount(transcriptCharsRaw),
    transcriptCharsSent: normalizeTokenCount(transcriptCharsSent),
    durationMs: normalizeDurationMs(durationMs),
    responseStatus: isNonEmptyString(responseStatus) ? responseStatus.trim() : 'failed',
    skipReason: isNonEmptyString(skipReason) ? skipReason.trim().slice(0, 200) : '',
    estimatedCostRub: Number.isFinite(estimatedCostRub) ? toRoundedNumber(estimatedCostRub, 6) : null,
    createdAt: new Date().toISOString()
  };
}

function attachAiUsage(error, aiUsage) {
  if (error instanceof Error && aiUsage && typeof aiUsage === 'object') {
    error.aiUsage = aiUsage;
  }

  return error;
}

function sanitizePolzaErrorMessage(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;

  if (status === 401) {
    return 'Polza authentication failed';
  }

  if (status === 429) {
    return 'Polza rate limit reached';
  }

  if (status && status >= 500) {
    return 'Polza upstream server error';
  }

  if (status) {
    return `Polza request failed with status ${status}`;
  }

  return 'Polza request failed';
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeText(value, maxLength) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

function clampMultilineText(value, maxLength) {
  const normalized = stringFromUnknown(value).replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

function normalizeEnum(value, allowedValues, fallbackValue) {
  if (!isNonEmptyString(value)) {
    return fallbackValue;
  }

  const normalized = normalizeWhitespace(value).toLowerCase();
  if (allowedValues.includes(normalized)) {
    return normalized;
  }

  return fallbackValue;
}

function normalizeOptionalText(value, maxLength) {
  const normalized = normalizeText(value, maxLength);
  if (!normalized) {
    return '';
  }

  if (EMPTY_OPTIONAL_TEXT_TOKENS.has(normalized.toLowerCase())) {
    return '';
  }

  return normalized;
}

function normalizeUniqueItems(rawValues, { maxLength, maxItems }) {
  if (!Array.isArray(rawValues)) {
    return [];
  }

  const normalizedItems = [];
  const seen = new Set();

  for (const rawValue of rawValues) {
    const normalized = normalizeOptionalText(rawValue, maxLength);
    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    normalizedItems.push(normalized);
    seen.add(dedupeKey);

    if (normalizedItems.length >= maxItems) {
      break;
    }
  }

  return normalizedItems;
}

function hasAnyToken(text, tokens = []) {
  return tokens.some((token) => text.includes(token));
}

function inferPrimaryScenarioFromText(text) {
  if (!text) {
    return '';
  }

  const hasPriceSignal = hasAnyToken(text, PRICE_SIGNAL_TOKENS);
  const hasTermSignal = hasAnyToken(text, TERM_SIGNAL_TOKENS);
  const hasOrderProductionSignal = hasAnyToken(text, ORDER_PRODUCTION_SIGNAL_TOKENS);
  const hasStrongOrderSignal = text.includes('парт') || text.includes('производств') || text.includes('запуск');
  const hasDeliverySignal = hasAnyToken(text, DELIVERY_SIGNAL_TOKENS);
  const hasPartsSignal = text.includes('запчаст') || text.includes('подшип') || text.includes('ролик');

  if (text.includes('аренд') || text.includes('прокат')) {
    return 'Аренда';
  }

  if (text.includes('ремонт') || text.includes('сервис') || text.includes('неисправ') || text.includes('диагност')) {
    return 'Ремонт';
  }

  if (hasStrongOrderSignal || (hasOrderProductionSignal && hasPriceSignal && hasTermSignal)) {
    return 'Заказ / производство';
  }

  if (hasPartsSignal && !hasStrongOrderSignal) {
    return 'Запчасти';
  }

  if (hasOrderProductionSignal || (hasPriceSignal && hasTermSignal)) {
    return 'Заказ / производство';
  }

  if (hasDeliverySignal) {
    return 'Доставка';
  }

  return '';
}

function normalizePrimaryScenario(rawPrimaryScenario, category, contextText) {
  if (isNonEmptyString(rawPrimaryScenario)) {
    const token = normalizeWhitespace(rawPrimaryScenario).toLowerCase().replace(/[\s\/-]+/g, '_');
    const aliasValue = PRIMARY_SCENARIO_ALIASES[token];
    if (aliasValue) {
      if (aliasValue !== 'Другое') {
        return aliasValue;
      }
    }
  }

  const inferredFromText = inferPrimaryScenarioFromText(contextText);
  if (inferredFromText) {
    return inferredFromText;
  }

  return PRIMARY_SCENARIO_BY_CATEGORY[category] || 'Другое';
}

function normalizeWantedSummary(rawWantedSummary, fallbackCandidates) {
  const rawLines = stringFromUnknown(rawWantedSummary)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => normalizeOptionalText(line, MAX_TEXT_LENGTH.wantedSummary))
    .filter((line) => line !== '');

  const fallbackLines = fallbackCandidates
    .map((line) => normalizeOptionalText(line, MAX_TEXT_LENGTH.summary))
    .filter((line) => line !== '');

  const merged = [...rawLines];
  if (rawLines.length < 2) {
    merged.push(...fallbackLines);
  }
  const deduped = [];
  const seen = new Set();

  for (const line of merged) {
    const dedupeKey = line.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    deduped.push(line);
    seen.add(dedupeKey);

    if (deduped.length >= 4) {
      break;
    }
  }

  if (deduped.length === 0) {
    return 'Запрос клиента зафиксирован.\nКлючевые детали уточняются.';
  }

  if (deduped.length === 1) {
    return clampMultilineText(`${deduped[0]}\nКлючевые детали уточняются.`, MAX_TEXT_LENGTH.wantedSummary);
  }

  return clampMultilineText(deduped.join('\n'), MAX_TEXT_LENGTH.wantedSummary);
}

function normalizeRepairType(rawRepairType) {
  if (!isNonEmptyString(rawRepairType)) {
    return '';
  }

  const token = normalizeWhitespace(rawRepairType).toLowerCase().replace(/[\s-]+/g, '_');
  if (['выездной', 'выезд', 'on_site', 'onsite'].includes(token)) {
    return 'выездной';
  }

  if (['капитальный', 'цех', 'в_цеху', 'стационарный'].includes(token)) {
    return 'капитальный';
  }

  return '';
}

function normalizeTags(rawTags) {
  if (!Array.isArray(rawTags)) {
    return [];
  }

  const unique = new Set();
  const tags = [];

  for (const tag of rawTags) {
    if (!isNonEmptyString(tag)) {
      continue;
    }

    const normalized = normalizeText(tag, 32).toLowerCase();
    if (!normalized || unique.has(normalized)) {
      continue;
    }

    unique.add(normalized);
    tags.push(normalized);

    if (tags.length === 5) {
      break;
    }
  }

  return tags;
}

function normalizeOptionalConfidence(rawConfidence) {
  if (rawConfidence === null || rawConfidence === undefined || rawConfidence === '') {
    return null;
  }

  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
    if (rawConfidence < 0) {
      return 0;
    }

    if (rawConfidence > 1) {
      return 1;
    }

    return rawConfidence;
  }

  if (typeof rawConfidence === 'string' && rawConfidence.trim() !== '') {
    const parsed = Number(rawConfidence.trim().replace(',', '.'));
    if (Number.isFinite(parsed)) {
      return normalizeOptionalConfidence(parsed);
    }
  }

  return null;
}

function normalizeReconstructedTurns(rawTurns) {
  if (!Array.isArray(rawTurns)) {
    return [];
  }

  const turns = [];
  for (const rawTurn of rawTurns) {
    if (!rawTurn || typeof rawTurn !== 'object' || Array.isArray(rawTurn)) {
      continue;
    }

    const speaker = normalizeOptionalText(rawTurn.speaker, MAX_TEXT_LENGTH.reconstructedTurnSpeaker);
    const text = normalizeOptionalText(rawTurn.text, MAX_TEXT_LENGTH.reconstructedTurnText);
    const roleRaw = normalizeOptionalText(rawTurn.role, 24).toLowerCase();
    const role = ['client', 'employee', 'unknown'].includes(roleRaw) ? roleRaw : 'unknown';
    const confidence = normalizeOptionalConfidence(rawTurn.confidence);

    if (!speaker || !text) {
      continue;
    }

    const turn = {
      speaker,
      role,
      text
    };

    if (confidence !== null) {
      turn.confidence = confidence;
    }

    turns.push(turn);
    if (turns.length >= 20) {
      break;
    }
  }

  return turns;
}

function normalizeAnalysisWarnings(rawWarnings) {
  const warnings = [];
  const seen = new Set();
  const source = Array.isArray(rawWarnings)
    ? rawWarnings
    : (typeof rawWarnings === 'string' ? rawWarnings.split(/[;\n|]+/) : []);

  for (const rawWarning of source) {
    const warning = normalizeOptionalText(rawWarning, MAX_TEXT_LENGTH.analysisWarningItem);
    if (!warning) {
      continue;
    }

    const dedupeKey = warning.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    warnings.push(warning);
    if (warnings.length >= 8) {
      break;
    }
  }

  return warnings;
}

function normalizeAndValidateAnalysis(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenAIClientError('Polza returned invalid analysis payload shape', 502, 'POLZA_INVALID_PAYLOAD');
  }

  const normalizedCategory = normalizeEnum(raw.category, ANALYSIS_CATEGORIES, 'прочее');
  const normalizedCallEssence = normalizeText(
    raw.callEssence || raw.shortSummary || raw.summary,
    MAX_TEXT_LENGTH.callEssence
  ) || 'Короткий контакт по рабочему вопросу.';
  const normalizedWhatDiscussed = normalizeText(
    raw.whatDiscussed || raw.result || raw.issueReason || raw.summary,
    MAX_TEXT_LENGTH.whatDiscussed
  ) || 'Предметные детали в разговоре не зафиксированы.';
  const normalizedOutcome = normalizeText(
    raw.outcome || raw.result || raw.summary,
    MAX_TEXT_LENGTH.outcome
  ) || 'Итоговые договоренности в разговоре не зафиксированы.';
  const normalizedImportantNote = normalizeOptionalText(raw.importantNote, MAX_TEXT_LENGTH.importantNote);
  const normalizedTopic = normalizeText(raw.topic, MAX_TEXT_LENGTH.topic)
    || normalizeText(normalizedCallEssence, MAX_TEXT_LENGTH.topic)
    || 'Короткий отчет по звонку';
  const normalizedSummary = normalizeText(raw.summary, MAX_TEXT_LENGTH.summary) || normalizedCallEssence;
  const normalizedResult = normalizeText(raw.result, MAX_TEXT_LENGTH.result) || normalizedWhatDiscussed;
  const normalizedNextStep = normalizeText(raw.nextStep, MAX_TEXT_LENGTH.nextStep) || 'Уточнить дальнейшие действия после следующего контакта.';
  const normalizedPriority = normalizeEnum(raw.priority, ANALYSIS_PRIORITIES, 'low');
  const normalizedTags = normalizeTags(raw.tags);
  const contextText = [
    normalizedTopic,
    normalizedCallEssence,
    normalizedWhatDiscussed,
    normalizedSummary,
    normalizedOutcome,
    normalizedNextStep,
    normalizeText(raw.scenario, 32),
    normalizeText(raw.wantedSummary, MAX_TEXT_LENGTH.wantedSummary),
    normalizeText(raw.primaryScenario, 32),
    normalizeText(raw.deliveryDetails, MAX_TEXT_LENGTH.deliveryDetails)
  ]
    .join(' ')
    .toLowerCase();

  const partsRequested = normalizeUniqueItems(raw.partsRequested, {
    maxLength: MAX_TEXT_LENGTH.partsItem,
    maxItems: 10
  });
  const repairType = normalizeRepairType(raw.repairType);

  const normalized = {
    category: normalizedCategory,
    scenario: normalizePrimaryScenario(raw.scenario || raw.primaryScenario, normalizedCategory, contextText),
    primaryScenario: normalizePrimaryScenario(raw.scenario || raw.primaryScenario, normalizedCategory, contextText),
    topic: normalizedTopic,
    callEssence: normalizedCallEssence,
    whatDiscussed: normalizedWhatDiscussed,
    summary: normalizedSummary,
    outcome: normalizedOutcome,
    result: normalizedResult,
    nextStep: normalizedNextStep,
    priority: normalizedPriority,
    tags: normalizedTags,
    wantedSummary: normalizeWantedSummary(raw.wantedSummary, [
      normalizedCallEssence,
      normalizedWhatDiscussed,
      normalizedSummary,
      normalizedOutcome,
      normalizedResult
    ]),
    confidence: normalizeOptionalConfidence(raw.confidence) ?? 0.6
  };

  if (normalizedImportantNote) {
    normalized.importantNote = normalizedImportantNote;
  }

  if (partsRequested.length > 0) {
    normalized.partsRequested = partsRequested;
  }

  const rentalStart = normalizeOptionalText(raw.rentalStart, MAX_TEXT_LENGTH.rentalStart);
  if (rentalStart) {
    normalized.rentalStart = rentalStart;
  }

  const rentalDuration = normalizeOptionalText(raw.rentalDuration, MAX_TEXT_LENGTH.rentalDuration);
  if (rentalDuration) {
    normalized.rentalDuration = rentalDuration;
  }

  const rentalAddress = normalizeOptionalText(raw.rentalAddress, MAX_TEXT_LENGTH.rentalAddress);
  if (rentalAddress) {
    normalized.rentalAddress = rentalAddress;
  }

  const repairEquipment = normalizeOptionalText(raw.repairEquipment, MAX_TEXT_LENGTH.repairEquipment);
  if (repairEquipment) {
    normalized.repairEquipment = repairEquipment;
  }

  const repairDateOrTerm = normalizeOptionalText(raw.repairDateOrTerm, MAX_TEXT_LENGTH.repairDateOrTerm);
  if (repairDateOrTerm) {
    normalized.repairDateOrTerm = repairDateOrTerm;
  }

  if (repairType) {
    normalized.repairType = repairType;
  }

  const repairAddress = normalizeOptionalText(raw.repairAddress, MAX_TEXT_LENGTH.repairAddress);
  if (repairAddress) {
    normalized.repairAddress = repairAddress;
  }

  const deliveryDetails = normalizeOptionalText(raw.deliveryDetails, MAX_TEXT_LENGTH.deliveryDetails);
  if (deliveryDetails) {
    normalized.deliveryDetails = deliveryDetails;
  }

  const companyName = normalizeOptionalText(raw.companyName, MAX_TEXT_LENGTH.companyName);
  if (companyName) {
    normalized.companyName = companyName;
  }

  const orderNumber = normalizeOptionalText(raw.orderNumber, MAX_TEXT_LENGTH.orderNumber);
  if (orderNumber) {
    normalized.orderNumber = orderNumber;
  }

  const transcriptPlain = clampMultilineText(stringFromUnknown(options.transcript), MAX_TEXT_LENGTH.transcriptPlain);
  if (transcriptPlain) {
    normalized.transcriptPlain = transcriptPlain;
  }

  const participantsAssumption = normalizeOptionalText(
    raw.participantsAssumption,
    MAX_TEXT_LENGTH.participantsAssumption
  ) || 'Предположение: два участника разговора (клиент и сотрудник).';
  if (participantsAssumption) {
    normalized.participantsAssumption = participantsAssumption;
  }

  const detectedClientSpeaker = normalizeOptionalText(
    raw.detectedClientSpeaker,
    MAX_TEXT_LENGTH.detectedClientSpeaker
  );
  if (detectedClientSpeaker) {
    normalized.detectedClientSpeaker = detectedClientSpeaker;
  }

  const detectedEmployeeSpeaker = normalizeOptionalText(
    raw.detectedEmployeeSpeaker,
    MAX_TEXT_LENGTH.detectedEmployeeSpeaker
  );
  if (detectedEmployeeSpeaker) {
    normalized.detectedEmployeeSpeaker = detectedEmployeeSpeaker;
  }

  const speakerRoleConfidence = normalizeOptionalConfidence(raw.speakerRoleConfidence);
  if (speakerRoleConfidence !== null) {
    normalized.speakerRoleConfidence = speakerRoleConfidence;
  }

  const clientGoal = normalizeOptionalText(raw.clientGoal, MAX_TEXT_LENGTH.clientGoal);
  if (clientGoal) {
    normalized.clientGoal = clientGoal;
  }

  const employeeResponse = normalizeOptionalText(raw.employeeResponse, MAX_TEXT_LENGTH.employeeResponse);
  if (employeeResponse) {
    normalized.employeeResponse = employeeResponse;
  }

  const issueReason = normalizeOptionalText(raw.issueReason, MAX_TEXT_LENGTH.issueReason);
  if (issueReason) {
    normalized.issueReason = issueReason;
  }

  const nextStepStructured = normalizeOptionalText(raw.nextStepStructured, MAX_TEXT_LENGTH.nextStepStructured);
  if (nextStepStructured) {
    normalized.nextStepStructured = nextStepStructured;
  }

  const reconstructedTurns = normalizeReconstructedTurns(raw.reconstructedTurns);
  if (reconstructedTurns.length > 0) {
    normalized.reconstructedTurns = reconstructedTurns;
  }

  const analysisWarnings = normalizeAnalysisWarnings(raw.analysisWarnings);
  if (speakerRoleConfidence !== null && speakerRoleConfidence < 0.5 && analysisWarnings.length === 0) {
    analysisWarnings.push('Низкая уверенность в назначении ролей участников.');
  }
  if (analysisWarnings.length > 0) {
    normalized.analysisWarnings = analysisWarnings;
  }

  if (normalizedImportantNote) {
    const existingWarnings = Array.isArray(normalized.analysisWarnings) ? normalized.analysisWarnings : [];
    const hasImportantWarning = existingWarnings.some(
      (warning) => normalizeOptionalText(warning, MAX_TEXT_LENGTH.analysisWarningItem).toLowerCase()
        === normalizedImportantNote.toLowerCase()
    );
    if (!hasImportantWarning) {
      normalized.analysisWarnings = [...existingWarnings, normalizedImportantNote].slice(0, 8);
    }
  }

  if (normalized.tags.length === 0) {
    normalized.tags = ['звонок'];
  }

  const analysisPath = normalizeOptionalText(raw.analysisPath, 24).toLowerCase();
  if (analysisPath) {
    normalized.analysisPath = analysisPath;
  }

  const bypassReason = normalizeOptionalText(raw.bypassReason, 120);
  if (bypassReason) {
    normalized.bypassReason = bypassReason;
  }

  return normalized;
}

function createPolzaClient(config) {
  if (!config || !isNonEmptyString(config.apiKey)) {
    throw new OpenAIClientError(
      'POLZA_API_KEY is required',
      500,
      'POLZA_MISSING_API_KEY'
    );
  }

  const client = new OpenAI({
    apiKey: config.apiKey.trim(),
    baseURL: isNonEmptyString(config.baseUrl) ? config.baseUrl.trim() : undefined,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries
  });
  const resolvedTranscribeModel = isNonEmptyString(config.transcribeModel)
    ? config.transcribeModel.trim()
    : (isNonEmptyString(config.defaultTranscribeModel) ? config.defaultTranscribeModel.trim() : 'gpt-4o-transcribe');

  return {
    client,
    analyzeModel: isNonEmptyString(config.model) ? config.model.trim() : 'gpt-5-mini',
    transcribeModel: resolvedTranscribeModel,
    transcribeCandidateModel: isNonEmptyString(config.transcribeCandidateModel)
      ? config.transcribeCandidateModel.trim()
      : '',
    allowRequestModelOverrides: config?.allowRequestModelOverrides === true,
    pricing: {
      analyzeInputRubPer1kTokens: Number.isFinite(config?.pricing?.analyzeInputRubPer1kTokens)
        ? Number(config.pricing.analyzeInputRubPer1kTokens)
        : null,
      analyzeOutputRubPer1kTokens: Number.isFinite(config?.pricing?.analyzeOutputRubPer1kTokens)
        ? Number(config.pricing.analyzeOutputRubPer1kTokens)
        : null
    }
  };
}

function normalizeTranscriptionText(raw) {
  if (!isNonEmptyString(raw)) {
    return '';
  }

  return raw.replace(/\s+/g, ' ').trim();
}

function buildEmptyTranscriptionDetails(response) {
  const responseKind = Array.isArray(response)
    ? 'array'
    : (response === null ? 'null' : typeof response);
  const rawText = typeof response === 'string'
    ? response
    : (isNonEmptyString(response?.text) ? response.text : '');
  const language = isNonEmptyString(response?.language) ? response.language.trim() : '';
  const durationSeconds = Number.isFinite(response?.duration)
    ? Number(response.duration.toFixed(3))
    : null;
  const segmentCount = Array.isArray(response?.segments) ? response.segments.length : null;

  return {
    responseKind,
    textLength: typeof rawText === 'string' ? rawText.length : 0,
    language,
    durationSeconds,
    segmentCount
  };
}

function decodeAudioBase64(rawAudioBase64) {
  if (!isNonEmptyString(rawAudioBase64)) {
    throw new OpenAIClientError(
      'audioBase64 is required and must be a non-empty string',
      400,
      'TRANSCRIBE_VALIDATION_FAILED'
    );
  }

  const withNoPrefix = rawAudioBase64.includes('base64,')
    ? rawAudioBase64.slice(rawAudioBase64.indexOf('base64,') + 'base64,'.length)
    : rawAudioBase64;

  const normalized = withNoPrefix.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    throw new OpenAIClientError(
      'audioBase64 contains invalid characters',
      400,
      'TRANSCRIBE_VALIDATION_FAILED'
    );
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer || buffer.length === 0) {
    throw new OpenAIClientError(
      'audioBase64 cannot be decoded to non-empty audio bytes',
      400,
      'TRANSCRIBE_VALIDATION_FAILED'
    );
  }

  if (buffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
    throw new OpenAIClientError(
      `Audio payload is too large (max ${MAX_TRANSCRIBE_AUDIO_BYTES} bytes)`,
      413,
      'TRANSCRIBE_AUDIO_TOO_LARGE'
    );
  }

  return buffer;
}

function resolveAudioBuffer(payload) {
  if (Buffer.isBuffer(payload?.audioBuffer)) {
    const buffer = payload.audioBuffer;

    if (buffer.length === 0) {
      throw new OpenAIClientError(
        'Uploaded audio file is empty',
        400,
        'TRANSCRIBE_VALIDATION_FAILED'
      );
    }

    if (buffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
      throw new OpenAIClientError(
        `Audio payload is too large (max ${MAX_TRANSCRIBE_AUDIO_BYTES} bytes)`,
        413,
        'TRANSCRIBE_AUDIO_TOO_LARGE'
      );
    }

    return buffer;
  }

  return decodeAudioBase64(payload?.audioBase64);
}

function resolveTranscriptionFileExtension({ fileName, mimeType }) {
  const fromName = isNonEmptyString(fileName) ? path.extname(fileName.trim()) : '';
  const allowed = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.mp4', '.mpeg']);

  if (allowed.has(fromName.toLowerCase())) {
    return fromName.toLowerCase();
  }

  const normalizedMime = isNonEmptyString(mimeType) ? mimeType.trim().toLowerCase() : '';
  if (normalizedMime.includes('wav')) {
    return '.wav';
  }

  if (normalizedMime.includes('ogg')) {
    return '.ogg';
  }

  if (normalizedMime.includes('webm')) {
    return '.webm';
  }

  if (normalizedMime.includes('mp4')) {
    return '.mp4';
  }

  if (normalizedMime.includes('mpeg') || normalizedMime.includes('mp3')) {
    return '.mp3';
  }

  return '.mp3';
}

function writeAudioBufferToTempFile(audioBuffer, extension) {
  const tempFilePath = path.join(
    os.tmpdir(),
    `ai-gateway-transcribe-${crypto.randomUUID()}${extension}`
  );

  fs.writeFileSync(tempFilePath, audioBuffer);
  return tempFilePath;
}

function safeRemoveFile(filePath) {
  if (!isNonEmptyString(filePath)) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    // non-critical cleanup failure
  }
}

function buildEmployeeHint(payload) {
  const employee = payload?.employee;
  if (!employee || typeof employee !== 'object' || Array.isArray(employee)) {
    return 'none';
  }

  const employeeName = normalizeOptionalText(employee.employeeName, 120);
  const employeeTitle = normalizeOptionalText(employee.employeeTitle, 120);
  const phoneNormalized = normalizeOptionalText(employee.phoneNormalized, 40);

  if (!employeeName && !employeeTitle && !phoneNormalized) {
    return 'none';
  }

  return [
    employeeName,
    employeeTitle,
    phoneNormalized
  ].filter(Boolean).join(', ');
}

function buildCallDirectionContext(payload) {
  const explicit = normalizeOptionalText(payload?.callDirectionContext, 64);
  if (explicit) {
    return explicit;
  }

  const callType = normalizeCallTypeToken(payload?.callType);
  if (callType === 'OUTGOING') {
    return 'outgoing_employee_to_client';
  }

  if (callType === 'INCOMING') {
    return 'incoming_client_to_employee';
  }

  return 'unknown_direction';
}

function buildWhoCalledWhom(payload) {
  const explicit = normalizeOptionalText(payload?.whoCalledWhom, 120);
  if (explicit) {
    return explicit;
  }

  const employeePhone = normalizeOptionalText(payload?.employeePhone, 40);
  const clientPhone = normalizeOptionalText(payload?.clientPhone, 40);
  const callType = normalizeCallTypeToken(payload?.callType);

  if (!employeePhone || !clientPhone) {
    return 'unknown';
  }

  if (callType === 'OUTGOING') {
    return `${employeePhone} -> ${clientPhone}`;
  }

  if (callType === 'INCOMING') {
    return `${clientPhone} -> ${employeePhone}`;
  }

  return 'unknown';
}

function buildUserPrompt(payload) {
  const callType = normalizeOptionalText(payload.callType, 24) || 'unknown';
  const callerNumber = normalizeOptionalText(payload.callerNumber, 40) || 'unknown';
  const calleeNumber = normalizeOptionalText(payload.calleeNumber, 40) || 'unknown';
  const destinationNumber = normalizeOptionalText(payload.destinationNumber, 40) || 'unknown';
  const employeePhone = normalizeOptionalText(payload.employeePhone, 40) || 'unknown';
  const clientPhone = normalizeOptionalText(payload.clientPhone, 40) || 'unknown';
  const durationSec = normalizeOptionalInteger(payload.durationSec);
  const transcriptLength = normalizeOptionalInteger(payload.transcriptLength) ?? getTranscriptChars(payload?.transcript);
  const answeredValue = normalizeOptionalBoolean(payload.answered);
  const noAnswerValue = normalizeOptionalBoolean(payload.noAnswer);
  const resolvedAnswered = answeredValue !== null
    ? answeredValue
    : (noAnswerValue !== null ? !noAnswerValue : null);
  const shortCall = normalizeOptionalBoolean(payload.shortCall);

  const lines = [
    'Сформируй компактный report-style анализ по транскрипту звонка.',
    'Не придумывай детали и не формулируй ответ как список задач/действий.',
    'Если фактов мало, явно отрази ограниченность данных.',
    `phone: ${isNonEmptyString(payload.phone) ? payload.phone.trim() : 'unknown'}`,
    `callDateTime: ${isNonEmptyString(payload.callDateTime) ? payload.callDateTime.trim() : 'unknown'}`,
    `callType: ${callType}`,
    `callerNumber: ${callerNumber}`,
    `calleeNumber: ${calleeNumber}`,
    `destinationNumber: ${destinationNumber}`,
    `durationSec: ${Number.isInteger(durationSec) ? durationSec : 'unknown'}`,
    `answered: ${resolvedAnswered === null ? 'unknown' : (resolvedAnswered ? 'yes' : 'no')}`,
    `employeePhone: ${employeePhone}`,
    `clientPhone: ${clientPhone}`,
    `transcriptLength: ${Number.isInteger(transcriptLength) ? transcriptLength : 'unknown'}`,
    `shortCall: ${shortCall === null ? 'unknown' : (shortCall ? 'true' : 'false')}`,
    `callDirectionContext: ${buildCallDirectionContext(payload)}`,
    `whoCalledWhom: ${buildWhoCalledWhom(payload)}`,
    `employeeHint: ${buildEmployeeHint(payload)}`,
    'transcript:',
    payload.transcript
  ];

  return lines.join('\n');
}

function createOpenAIAnalyzer(config, logger) {
  const { client, analyzeModel, pricing, allowRequestModelOverrides } = createPolzaClient(config);

  function resolveAnalyzeModel(payload) {
    const requestedModel = isNonEmptyString(payload?.analyzeModel) ? payload.analyzeModel.trim() : '';
    if (!requestedModel) {
      return analyzeModel;
    }

    if (!allowRequestModelOverrides) {
      logger.info('cost_guard_model_override_ignored', {
        requestId: payload?.requestId || '',
        callEventId: normalizeCallEventId(payload?.callEventId),
        callId: isNonEmptyString(payload?.callId) ? payload.callId.trim().slice(0, 256) : '',
        stage: 'analyze',
        reason: 'request_model_override_blocked',
        provider: POLZA_PROVIDER,
        configuredModel: analyzeModel,
        requestedModel
      });
      return analyzeModel;
    }

    logger.info('cost_guard_model_override_allowed', {
      requestId: payload?.requestId || '',
      callEventId: normalizeCallEventId(payload?.callEventId),
      callId: isNonEmptyString(payload?.callId) ? payload.callId.trim().slice(0, 256) : '',
      stage: 'analyze',
      provider: POLZA_PROVIDER,
      configuredModel: analyzeModel,
      requestedModel
    });

    return requestedModel;
  }

  return async function analyzeCall(payload) {
    const startedAt = Date.now();
    const effectiveAnalyzeModel = resolveAnalyzeModel(payload);
    const transcriptCharsRaw = getTranscriptChars(payload?.transcript);
    const transcriptCharsSent = transcriptCharsRaw;
    const bypassDecision = buildAnalyzeBypassDecision(payload);

    if (bypassDecision.shouldBypass) {
      const bypassAnalysis = normalizeAndValidateAnalysis(
        buildBypassAnalysis(payload, bypassDecision),
        { transcript: payload.transcript }
      );
      const durationMs = Date.now() - startedAt;
      const aiUsage = buildAiUsageEvent({
        payload,
        operation: 'analyze',
        model: 'deterministic-bypass',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        transcriptCharsRaw,
        transcriptCharsSent: 0,
        durationMs,
        responseStatus: 'skipped',
        skipReason: bypassDecision.reason,
        estimatedCostRub: 0
      });

      logger.info('ai_usage_analyze', aiUsage);
      logger.info('polza_analysis_bypass', {
        requestId: payload?.requestId || '',
        callEventId: normalizeCallEventId(payload?.callEventId),
        callId: isNonEmptyString(payload?.callId) ? payload.callId.trim().slice(0, 256) : '',
        reason: bypassDecision.reason,
        kind: bypassDecision.kind,
        transcriptLength: bypassDecision.transcriptLength,
        durationSec: bypassDecision.durationSec
      });

      return {
        ...bypassAnalysis,
        aiUsage
      };
    }

    let completion;

    try {
      completion = await client.chat.completions.create({
        model: effectiveAnalyzeModel,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'call_analysis_gateway',
            strict: false,
            schema: ANALYSIS_SCHEMA
          }
        },
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT.trim()
          },
          {
            role: 'user',
            content: buildUserPrompt(payload)
          }
        ]
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const aiUsage = buildAiUsageEvent({
        payload,
        operation: 'analyze',
        model: effectiveAnalyzeModel,
        transcriptCharsRaw,
        transcriptCharsSent,
        durationMs,
        responseStatus: 'failed'
      });

      logger.warn('ai_usage_analyze', aiUsage);

      throw attachAiUsage(new OpenAIClientError(
        sanitizePolzaErrorMessage(error),
        502,
        'POLZA_REQUEST_FAILED'
      ), aiUsage);
    }

    const usage = extractCompletionUsage(completion);
    const durationMs = Date.now() - startedAt;
    const estimatedCostRub = usage.costRub ?? buildAnalyzeEstimatedCostRub({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      pricing
    });

    const modelContent = completion?.choices?.[0]?.message?.content;
    if (!isNonEmptyString(modelContent)) {
      const aiUsage = buildAiUsageEvent({
        payload,
        operation: 'analyze',
        model: effectiveAnalyzeModel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        transcriptCharsRaw,
        transcriptCharsSent,
        durationMs,
        responseStatus: 'failed',
        estimatedCostRub
      });

      logger.warn('ai_usage_analyze', aiUsage);

      throw attachAiUsage(new OpenAIClientError(
        'Polza returned empty response content',
        502,
        'POLZA_EMPTY_RESPONSE'
      ), aiUsage);
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(modelContent);
    } catch (error) {
      const aiUsage = buildAiUsageEvent({
        payload,
        operation: 'analyze',
        model: effectiveAnalyzeModel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        transcriptCharsRaw,
        transcriptCharsSent,
        durationMs,
        responseStatus: 'failed',
        estimatedCostRub
      });

      logger.warn('ai_usage_analyze', aiUsage);

      throw attachAiUsage(new OpenAIClientError(
        'Polza returned invalid JSON that cannot be parsed',
        502,
        'POLZA_INVALID_JSON_PARSE'
      ), aiUsage);
    }

    const normalized = normalizeAndValidateAnalysis(parsedJson, {
      transcript: payload.transcript
    });

    const aiUsage = buildAiUsageEvent({
      payload,
      operation: 'analyze',
      model: effectiveAnalyzeModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      transcriptCharsRaw,
      transcriptCharsSent,
      durationMs,
      responseStatus: 'success',
      estimatedCostRub
    });

    logger.info('ai_usage_analyze', aiUsage);

    logger.info('polza_analysis_success', {
      requestId: payload.requestId || '',
      callEventId: normalizeCallEventId(payload?.callEventId),
      model: effectiveAnalyzeModel,
      category: normalized.category,
      priority: normalized.priority,
      tagsCount: normalized.tags.length,
      promptTokens: aiUsage.promptTokens,
      completionTokens: aiUsage.completionTokens,
      totalTokens: aiUsage.totalTokens,
      estimatedCostRub: aiUsage.estimatedCostRub,
      durationMs: aiUsage.durationMs
    });

    return {
      ...normalized,
      aiUsage
    };
  };
}

function createOpenAITranscriber(config, logger) {
  const {
    client,
    transcribeModel,
    transcribeCandidateModel,
    allowRequestModelOverrides
  } = createPolzaClient(config);

  function resolveTranscribeModel(payload) {
    const requestedModelRaw = payload?.transcribeModel;
    const requested = isNonEmptyString(requestedModelRaw) ? requestedModelRaw.trim() : '';
    if (!requested) {
      return transcribeModel;
    }

    if (!allowRequestModelOverrides) {
      logger.info('cost_guard_model_override_ignored', {
        requestId: payload?.requestId || '',
        callEventId: normalizeCallEventId(payload?.callEventId),
        callId: isNonEmptyString(payload?.callId) ? payload.callId.trim().slice(0, 256) : '',
        stage: 'transcribe',
        reason: 'request_model_override_blocked',
        provider: POLZA_PROVIDER,
        configuredModel: transcribeModel,
        requestedModel: requested
      });
      return transcribeModel;
    }

    logger.info('cost_guard_model_override_allowed', {
      requestId: payload?.requestId || '',
      callEventId: normalizeCallEventId(payload?.callEventId),
      callId: isNonEmptyString(payload?.callId) ? payload.callId.trim().slice(0, 256) : '',
      stage: 'transcribe',
      provider: POLZA_PROVIDER,
      configuredModel: transcribeModel,
      requestedModel: requested
    });

    if (requested.toLowerCase() === 'candidate') {
      if (!isNonEmptyString(transcribeCandidateModel)) {
        throw new OpenAIClientError(
          'POLZA_TRANSCRIBE_MODEL_CANDIDATE is not configured',
          400,
          'TRANSCRIBE_CANDIDATE_MODEL_NOT_CONFIGURED'
        );
      }

      return transcribeCandidateModel;
    }

    return requested;
  }

  return async function transcribeAudio(payload) {
    const startedAt = Date.now();
    const audioBuffer = resolveAudioBuffer(payload);
    const effectiveModel = resolveTranscribeModel(payload);
    const extension = resolveTranscriptionFileExtension({
      fileName: payload?.fileName || '',
      mimeType: payload?.mimeType || ''
    });
    const tempFilePath = writeAudioBufferToTempFile(audioBuffer, extension);

    logger.info('polza_transcription_request', {
      requestId: payload?.requestId || '',
      callEventId: normalizeCallEventId(payload?.callEventId),
      provider: POLZA_PROVIDER,
      endpoint: POLZA_TRANSCRIPTIONS_ENDPOINT,
      model: effectiveModel,
      requestedModel: isNonEmptyString(payload?.transcribeModel) ? payload.transcribeModel.trim() : '',
      audioBytes: audioBuffer.length
    });

    let response;
    try {
      response = await client.audio.transcriptions.create({
        model: effectiveModel,
        file: fs.createReadStream(tempFilePath),
        response_format: 'text'
      });
    } catch (error) {
      const aiUsage = buildAiUsageEvent({
        payload,
        operation: 'transcribe',
        model: effectiveModel,
        durationMs: Date.now() - startedAt,
        responseStatus: 'failed'
      });

      logger.warn('ai_usage_transcribe', {
        ...aiUsage,
        audioBytes: audioBuffer.length
      });

      throw attachAiUsage(new OpenAIClientError(
        sanitizePolzaErrorMessage(error),
        502,
        'POLZA_TRANSCRIBE_FAILED'
      ), aiUsage);
    } finally {
      safeRemoveFile(tempFilePath);
    }

    const transcript = normalizeTranscriptionText(
      typeof response === 'string' ? response : response?.text
    );

    const usage = extractCompletionUsage(response);
    const durationMs = Date.now() - startedAt;

    if (!isNonEmptyString(transcript)) {
      const aiUsage = buildAiUsageEvent({
        payload,
        operation: 'transcribe',
        model: effectiveModel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        durationMs,
        responseStatus: 'failed',
        estimatedCostRub: usage.costRub
      });

      logger.warn('ai_usage_transcribe', {
        ...aiUsage,
        audioBytes: audioBuffer.length
      });

      const emptyError = attachAiUsage(new OpenAIClientError(
        'Polza returned empty transcription',
        502,
        'POLZA_EMPTY_TRANSCRIPTION'
      ), aiUsage);
      emptyError.details = buildEmptyTranscriptionDetails(response);
      throw emptyError;
    }

    const aiUsage = buildAiUsageEvent({
      payload,
      operation: 'transcribe',
      model: effectiveModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      responseStatus: 'success',
      estimatedCostRub: usage.costRub
    });

    logger.info('ai_usage_transcribe', {
      ...aiUsage,
      audioBytes: audioBuffer.length
    });

    logger.info('polza_transcription_success', {
      requestId: payload?.requestId || '',
      provider: POLZA_PROVIDER,
      endpoint: POLZA_TRANSCRIPTIONS_ENDPOINT,
      transcriptLength: transcript.length,
      model: effectiveModel,
      audioBytes: audioBuffer.length,
      promptTokens: aiUsage.promptTokens,
      completionTokens: aiUsage.completionTokens,
      totalTokens: aiUsage.totalTokens,
      estimatedCostRub: aiUsage.estimatedCostRub,
      durationMs: aiUsage.durationMs
    });

    return {
      transcript,
      model: effectiveModel,
      audioBytes: audioBuffer.length,
      aiUsage
    };
  };
}

module.exports = {
  createOpenAIAnalyzer,
  createOpenAITranscriber,
  OpenAIClientError
};
