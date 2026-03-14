const { parseDateOrNull } = require('../utils/dateTime');

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

function normalizeScenarioToken(value) {
  return normalizeSingleLine(value).toLowerCase().replace(/[\s-]+/g, '_');
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

  const categoryToken = normalizeScenarioToken(analysis?.category);
  if (categoryToken && PRIMARY_SCENARIO_BY_CATEGORY[categoryToken]) {
    return PRIMARY_SCENARIO_BY_CATEGORY[categoryToken];
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

  if (contextText.includes('доставк') || contextText.includes('логист') || contextText.includes('самовывоз')) {
    return 'Доставка';
  }

  if (contextText.includes('ремонт') || contextText.includes('сервис') || contextText.includes('неисправ')) {
    return 'Ремонт';
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

function buildWantedLines(analysis) {
  const fromWantedSummary = normalizeWantedLines(analysis?.wantedSummary);
  const fallbackCandidates = [
    ...sentenceChunks(analysis?.summary),
    ...sentenceChunks(analysis?.result)
  ];

  const merged = [...fromWantedSummary];
  if (fromWantedSummary.length < 2) {
    merged.push(...fallbackCandidates);
  }
  const lines = [];
  const seen = new Set();

  for (const line of merged) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    lines.push(line);
    seen.add(key);
    if (lines.length >= 4) {
      break;
    }
  }

  if (lines.length === 0) {
    return ['Запрос клиента зафиксирован.', 'Ключевые детали уточняются.'];
  }

  if (lines.length === 1) {
    lines.push('Ключевые детали уточняются.');
  }

  return lines.slice(0, 4);
}

function formatTelegramCallSummary({ phone, callDateTime, analysis, timeZone = 'Europe/Moscow' } = {}) {
  const normalizedAnalysis = isPlainObject(analysis) ? analysis : {};
  const primaryScenario = resolvePrimaryScenario(normalizedAnalysis);
  const wantedLines = buildWantedLines(normalizedAnalysis);
  const phoneText = normalizeSingleLine(phone) || EMPTY_VALUE;
  const dateTimeText = formatCallDateTime(callDateTime, timeZone);
  const companyName = normalizeOptionalText(normalizedAnalysis.companyName);
  const orderNumber = normalizeOptionalText(normalizedAnalysis.orderNumber);

  const lines = [
    `Кто звонил: ${phoneText}`,
    `Когда звонил: ${dateTimeText}`,
    `Что хотели: ${wantedLines[0]}`
  ];

  for (const line of wantedLines.slice(1)) {
    lines.push(line);
  }

  lines.push('');
  lines.push(`Сценарий: ${primaryScenario}`);

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
