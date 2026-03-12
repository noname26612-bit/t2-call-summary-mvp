function parseDateOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed);
}

function formatDateTimeForTimezone(value, timeZone = 'Europe/Moscow') {
  const date = parseDateOrNull(value);
  if (!date) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '—';
  }

  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  return `${formatter.format(date)} (${timeZone})`;
}

module.exports = {
  parseDateOrNull,
  formatDateTimeForTimezone
};
