const { parseDateOrNull } = require('../utils/dateTime');
const { normalizePhone } = require('../utils/ignoredPhones');

const EMPTY_VALUE = '—';

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
  доставка: 'Доставка',
  логистика: 'Доставка',
  delivery: 'Доставка',
  другое: 'Другое',
  прочее: 'Другое'
});

const PRIMARY_SCENARIO_BY_CATEGORY = Object.freeze({
  запчасти: 'Запчасти',
  аренда: 'Аренда',
  сервис: 'Ремонт',
  продажа: 'Другое',
  спам: 'Другое',
  прочее: 'Другое'
});

const DELIVERY_SIGNAL_TOKENS = Object.freeze([
  'доставк',
  'логист',
  'самовывоз',
  'загруз',
  'погруз',
  'разгруз',
  'автопогруз',
  'отгруз',
  'вывоз',
  'привоз',
  'приезд',
  'приех',
  'время загрузк',
  'время приезд',
  'организац доставки'
]);

const REPAIR_SIGNAL_TOKENS = Object.freeze([
  'ремонт',
  'полом',
  'неисправ',
  'почин',
  'диагност',
  'мастер',
  'сервисный выезд',
  'выездной ремонт'
]);

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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeSingleLine(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalText(value) {
  const normalized = normalizeSingleLine(value);
  if (!normalized) {
    return '';
  }

  if (EMPTY_OPTIONAL_TEXT_TOKENS.has(normalized.toLowerCase())) {
    return '';
  }

  return normalized;
}

function pickFirstNonEmptyString(values) {
  for (const value of values) {
    const normalized = normalizeSingleLine(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function normalizeCallType(value) {
  const normalized = normalizeSingleLine(value).toUpperCase();
  if (normalized === 'INCOMING' || normalized === 'INBOUND') {
    return 'INCOMING';
  }

  if (normalized === 'OUTGOING' || normalized === 'OUTBOUND') {
    return 'OUTGOING';
  }

  return '';
}

function resolveCallTypeLabel(callType) {
  const normalizedCallType = normalizeCallType(callType);
  if (normalizedCallType === 'INCOMING') {
    return 'Входящий';
  }

  if (normalizedCallType === 'OUTGOING') {
    return 'Исходящий';
  }

  return EMPTY_VALUE;
}

function normalizePhoneText(value) {
  const normalized = pickFirstNonEmptyString([value]);
  if (!normalized) {
    return '';
  }

  return normalizeSingleLine(normalizePhone(normalized));
}

function resolveSubscriberPhone({ callType, callerNumber, calleeNumber, destinationNumber }) {
  const normalizedCallType = normalizeCallType(callType);

  let sourcePhone = '';
  if (normalizedCallType === 'OUTGOING') {
    sourcePhone = pickFirstNonEmptyString([callerNumber]);
  } else if (normalizedCallType === 'INCOMING') {
    sourcePhone = pickFirstNonEmptyString([destinationNumber, calleeNumber]);
  }

  if (!sourcePhone) {
    return '';
  }

  return normalizePhone(sourcePhone);
}

function normalizeScenarioToken(value) {
  return normalizeSingleLine(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeForContains(value) {
  return normalizeSingleLine(value)
    .toLowerCase()
    .replace(/["'«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCallDateTime(callDateTime, timeZone) {
  const date = parseDateOrNull(callDateTime);
  if (!date) {
    return normalizeSingleLine(callDateTime) || EMPTY_VALUE;
  }

  const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit'
  });

  return `${timeFormatter.format(date)}, ${dateFormatter.format(date)}`;
}

function resolvePrimaryScenario(analysis) {
  const normalizedToken = normalizeScenarioToken(analysis?.primaryScenario);
  if (normalizedToken && PRIMARY_SCENARIO_ALIASES[normalizedToken]) {
    return PRIMARY_SCENARIO_ALIASES[normalizedToken];
  }

  const contextText = [
    normalizeSingleLine(analysis?.wantedSummary),
    normalizeSingleLine(analysis?.summary),
    normalizeSingleLine(analysis?.topic)
  ]
    .join(' ')
    .toLowerCase();

  if (contextText.includes('запчаст')) {
    return 'Запчасти';
  }

  if (contextText.includes('аренд')) {
    return 'Аренда';
  }

  const hasDeliverySignal = DELIVERY_SIGNAL_TOKENS.some((token) => contextText.includes(token));
  const hasRepairSignal = REPAIR_SIGNAL_TOKENS.some((token) => contextText.includes(token));

  const categoryToken = normalizeScenarioToken(analysis?.category);
  if (categoryToken === 'сервис' || categoryToken === 'service') {
    if (hasDeliverySignal && !hasRepairSignal) {
      return 'Доставка';
    }

    if (hasRepairSignal) {
      return 'Ремонт';
    }
  }

  if (hasDeliverySignal && !hasRepairSignal) {
    return 'Доставка';
  }

  if (hasRepairSignal || contextText.includes('сервис')) {
    return 'Ремонт';
  }

  if (categoryToken && PRIMARY_SCENARIO_BY_CATEGORY[categoryToken]) {
    return PRIMARY_SCENARIO_BY_CATEGORY[categoryToken];
  }

  return 'Другое';
}

function normalizeWantedLines(rawText) {
  if (!isNonEmptyString(rawText)) {
    return [];
  }

  const lines = rawText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => normalizeSingleLine(line))
    .filter((line) => line !== '');

  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    unique.push(line);
    seen.add(key);
    if (unique.length >= 4) {
      break;
    }
  }

  return unique;
}

function sentenceChunks(value) {
  const normalized = normalizeSingleLine(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[.!?]+\s+/)
    .map((chunk) => normalizeSingleLine(chunk))
    .filter((chunk) => chunk !== '');
}

function lineLooksLikeStatus(rawLine) {
  const line = normalizeSingleLine(rawLine).toLowerCase();
  if (!line) {
    return false;
  }

  if (
    /статус\s+(заказа|готовности|доставки|ремонта|отгрузки|станка)/.test(line) ||
    /уточн(яет|ить).+статус/.test(line) ||
    /спрос(ил|ила|ить).+статус/.test(line)
  ) {
    return false;
  }

  return (
    /^результат[:\s]/.test(line) ||
    /^статус[:\s]/.test(line) ||
    /^следующий шаг[:\s]/.test(line) ||
    /^(заявка|запрос)\s+(принят|принята|зафиксирован|зафиксирована)\b/.test(line) ||
    /\b(заявк[аеиу]|запрос[аеиу]?|обращени[ея])\b.{0,80}\b(принят[аоы]?|зарегистрирован[аоы]?|взят[аоы]?\s+в\s+работу|обработан[аоы]?|оформлен[аоы]?)\b/.test(line) ||
    /\b(принят[аоы]?|зарегистрирован[аоы]?|взят[аоы]?\s+в\s+работу|обработан[аоы]?|оформлен[аоы]?)\b.{0,80}\b(заявк[аеиу]|запрос[аеиу]?|обращени[ея])\b/.test(line) ||
    /требуется\s+дальнейшая\s+обработк/.test(line) ||
    /взято?\s+в\s+работу/.test(line) ||
    /зарегистрирован(о|а|ы)?/.test(line) ||
    /\bобработан(о|а|ы)?\b/.test(line) ||
    /ключевые\s+детали\s+уточняются/.test(line)
  );
}

function isCompanyMentionedInText(wantedText, companyName) {
  const textToken = normalizeForContains(wantedText);
  const companyToken = normalizeForContains(companyName);
  if (!textToken || !companyToken) {
    return false;
  }

  return textToken.includes(companyToken);
}

function isOrderMentionedInText(wantedText, orderNumber) {
  const textToken = normalizeForContains(wantedText);
  const orderToken = normalizeForContains(orderNumber);
  if (!textToken || !orderToken) {
    return false;
  }

  if (textToken.includes(orderToken)) {
    return true;
  }

  const orderDigits = orderNumber.replace(/\D/g, '');
  if (orderDigits.length < 2) {
    return false;
  }

  return textToken.replace(/\D/g, '').includes(orderDigits);
}

function appendOptionalDetailsToWantedText(wantedText, { companyName, orderNumber }) {
  const appendCompany = companyName && !isCompanyMentionedInText(wantedText, companyName);
  const appendOrder = orderNumber && !isOrderMentionedInText(wantedText, orderNumber);

  if (!appendCompany && !appendOrder) {
    return wantedText;
  }

  let suffix = '';

  if (appendCompany && appendOrder) {
    suffix = `Компания ${companyName}, номер заказа ${orderNumber}.`;
  } else if (appendCompany) {
    suffix = `Компания ${companyName}.`;
  } else if (appendOrder) {
    suffix = `Номер заказа ${orderNumber}.`;
  }

  const separator = /[.!?]\s*$/.test(wantedText) ? ' ' : '. ';
  return normalizeSingleLine(`${wantedText}${separator}${suffix}`);
}

function stripStatusSentences(rawText) {
  const chunks = sentenceChunks(rawText);
  if (chunks.length === 0) {
    return normalizeSingleLine(rawText);
  }

  const kept = chunks.filter((chunk) => !lineLooksLikeStatus(chunk));
  if (kept.length === 0) {
    return '';
  }

  return kept
    .slice(0, 2)
    .map((chunk) => (/[.!?]$/.test(chunk) ? chunk : `${chunk}.`))
    .join(' ')
    .trim();
}

function buildWantedText(analysis, { companyName, orderNumber }) {
  const fromWantedSummary = normalizeWantedLines(analysis?.wantedSummary);
  const fallbackCandidates = [
    ...sentenceChunks(analysis?.summary),
    ...sentenceChunks(analysis?.topic)
  ];

  const merged = fromWantedSummary.length > 0 ? fromWantedSummary : fallbackCandidates;
  const unique = [];
  const seen = new Set();

  for (const line of merged) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    unique.push(line);
    seen.add(key);
  }

  const withoutStatusLines = unique.filter((line) => !lineLooksLikeStatus(line));
  const selected = (withoutStatusLines.length > 0 ? withoutStatusLines : unique).slice(0, 2);

  let wantedText = stripStatusSentences(selected.join(' '));
  if (!wantedText) {
    wantedText = stripStatusSentences(normalizeSingleLine(analysis?.summary));
  }
  if (!wantedText) {
    wantedText = 'Запрос клиента зафиксирован.';
  }

  return appendOptionalDetailsToWantedText(wantedText, { companyName, orderNumber });
}

function formatTelegramCallSummary({
  phone,
  callDateTime,
  analysis,
  timeZone = 'Europe/Moscow',
  callType,
  callerNumber,
  calleeNumber,
  destinationNumber
} = {}) {
  const normalizedAnalysis = isPlainObject(analysis) ? analysis : {};
  const primaryScenario = resolvePrimaryScenario(normalizedAnalysis);
  const callTypeText = resolveCallTypeLabel(callType);
  const subscriberText = normalizePhoneText(resolveSubscriberPhone({
    callType,
    callerNumber,
    calleeNumber,
    destinationNumber
  })) || EMPTY_VALUE;
  const phoneText = normalizePhoneText(phone) || EMPTY_VALUE;
  const dateTimeText = formatCallDateTime(callDateTime, timeZone);
  const companyName = normalizeOptionalText(normalizedAnalysis.companyName);
  const orderNumber = normalizeOptionalText(normalizedAnalysis.orderNumber);
  const wantedText = buildWantedText(normalizedAnalysis, { companyName, orderNumber });

  const lines = [
    `Тип звонка: ${callTypeText}`,
    `Абонент: ${subscriberText}`,
    '',
    `Кто звонил: ${phoneText}`,
    `Когда звонил: ${dateTimeText}`,
    '',
    `Что хотели: ${wantedText}`,
    '',
    `Категория: ${primaryScenario}`
  ];

  if (companyName || orderNumber) {
    lines.push('');
  }

  if (companyName) {
    lines.push(`Компания: ${companyName}`);
  }

  if (orderNumber) {
    lines.push(`Номер заказа: ${orderNumber}`);
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

module.exports = {
  formatTelegramCallSummary
};
