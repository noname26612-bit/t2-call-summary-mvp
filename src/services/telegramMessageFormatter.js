const { formatDateTimeForTimezone } = require('../utils/dateTime');

const EMPTY_VALUE = '—';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeSingleLineText(value) {
  if (!isNonEmptyString(value)) {
    return EMPTY_VALUE;
  }

  return value.replace(/\s+/g, ' ').trim();
}

function formatTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return EMPTY_VALUE;
  }

  const normalizedTags = tags
    .map((tag) => normalizeSingleLineText(tag))
    .filter((tag) => tag !== EMPTY_VALUE);

  return normalizedTags.length > 0 ? normalizedTags.join(', ') : EMPTY_VALUE;
}

function formatTelegramCallSummary({ phone, callDateTime, analysis, timeZone = 'Europe/Moscow' } = {}) {
  const normalizedAnalysis = analysis && typeof analysis === 'object' && !Array.isArray(analysis)
    ? analysis
    : {};

  return [
    'Обработанный звонок',
    `Категория: ${normalizeSingleLineText(normalizedAnalysis.category)}`,
    `Тема: ${normalizeSingleLineText(normalizedAnalysis.topic)}`,
    `Телефон: ${normalizeSingleLineText(phone)}`,
    `Дата и время: ${normalizeSingleLineText(formatDateTimeForTimezone(callDateTime, timeZone))}`,
    `Сводка: ${normalizeSingleLineText(normalizedAnalysis.summary)}`,
    `Результат: ${normalizeSingleLineText(normalizedAnalysis.result)}`,
    `Следующий шаг: ${normalizeSingleLineText(normalizedAnalysis.nextStep)}`,
    `Срочность: ${normalizeSingleLineText(normalizedAnalysis.urgency)}`,
    `Теги: ${formatTags(normalizedAnalysis.tags)}`
  ].join('\n');
}

module.exports = {
  formatTelegramCallSummary
};
