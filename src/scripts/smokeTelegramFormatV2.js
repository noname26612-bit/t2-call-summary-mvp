const { normalizeAndValidateAnalysis } = require('../services/analysisNormalizer');
const { formatTelegramCallSummary } = require('../services/telegramMessageFormatter');

const BASE_CALL = {
  phone: '+79991234567',
  callDateTime: '2026-03-14T12:13:00+03:00',
  timeZone: 'Europe/Moscow',
  callType: 'INCOMING',
  callerNumber: '+79991234567',
  destinationNumber: '+74951234567',
  calleeNumber: '+74951234567'
};

const BASE_ANALYSIS = {
  category: 'прочее',
  scenario: 'Другое',
  topic: 'Общий рабочий вопрос',
  callEssence: 'Клиент коротко обозначил рабочий вопрос.',
  whatDiscussed: 'Обсудили детали запроса на базовом уровне.',
  outcome: 'Итоговое решение в разговоре не зафиксировано.',
  summary: 'Клиент коротко обозначил рабочий вопрос.',
  result: 'Обсудили детали запроса на базовом уровне.',
  nextStep: 'Итоговое решение в разговоре не зафиксировано.',
  urgency: 'средняя',
  tags: ['звонок'],
  confidence: 0.82
};

const FORBIDDEN_SNIPPETS = [
  'Итог по фактам:',
  'По разговору запрос:',
  'Неопределенность:',
  'Основная тема:',
  'Категория:'
];

const CASES = [
  {
    title: 'Basic report format',
    transcript: 'Клиент уточнил наличие подшипника и срок поставки.',
    payload: {
      category: 'запчасти',
      scenario: 'Запчасти',
      callEssence: 'Уточняли наличие подшипника.',
      whatDiscussed: 'Проверили сроки поставки и остатки.',
      outcome: 'Финальное решение о заказе в разговоре не зафиксировано.'
    },
    expected: {
      scenario: 'Запчасти',
      callType: 'Входящий',
      hasImportant: false
    }
  },
  {
    title: 'Important note appears when required',
    transcript: 'Связь прерывалась, часть слов не разобрать.',
    payload: {
      scenario: 'Другое',
      callEssence: 'Разговор был короткий и со сбоями связи.',
      whatDiscussed: 'Предмет вопроса полностью разобрать не удалось.',
      outcome: 'Договоренности по задаче не зафиксированы.',
      importantNote: 'Часть разговора неразборчива.'
    },
    expected: {
      scenario: 'Другое',
      callType: 'Входящий',
      hasImportant: true
    }
  },
  {
    title: 'Non-critical note must stay hidden',
    transcript: 'Клиент уточнил общую информацию.',
    payload: {
      scenario: 'Другое',
      callEssence: 'Коротко уточнили общий вопрос.',
      whatDiscussed: 'Подробно тему не раскрывали.',
      outcome: 'Разговор завершили без отдельных договоренностей.',
      importantNote: 'Общая рабочая пометка.'
    },
    expected: {
      scenario: 'Другое',
      callType: 'Входящий',
      hasImportant: false
    }
  },
  {
    title: 'Outgoing call label',
    transcript: 'Сотрудник перезвонил клиенту по срокам поставки.',
    payload: {
      category: 'сервис',
      scenario: 'Доставка',
      callEssence: 'Сотрудник перезвонил по срокам поставки.',
      whatDiscussed: 'Уточнили окно отгрузки и время выгрузки.',
      outcome: 'Подтверждение запуска поставки перенесли на следующий контакт.'
    },
    callContext: {
      callType: 'OUTGOING',
      callerNumber: '8 (495) 765-43-21',
      destinationNumber: '+7 999 111-22-33',
      calleeNumber: '+7 999 111-22-33'
    },
    expected: {
      scenario: 'Доставка',
      callType: 'Исходящий',
      hasImportant: false
    }
  },
  {
    title: 'Unknown call type fallback',
    transcript: 'Клиент задал вопрос по общим условиям.',
    payload: {
      category: 'прочее',
      scenario: 'Другое',
      callEssence: 'Клиент уточнил общие условия.',
      whatDiscussed: 'Обсудили базовые вводные без деталей.',
      outcome: 'Дальнейшие договоренности в разговоре не зафиксированы.'
    },
    callContext: {
      callType: 'SIDEWAY'
    },
    expected: {
      scenario: 'Другое',
      callType: '—',
      hasImportant: false
    }
  }
];

function validateMessage({ title, message, expected }) {
  const errors = [];

  for (const prefix of [
    'Кто звонил:',
    'Когда звонил:',
    'Суть звонка:',
    'Что обсуждали:',
    'Чем закончилось:',
    'Сценарий:',
    'Сотрудник:',
    'Тип звонка:'
  ]) {
    if (!message.includes(prefix)) {
      errors.push(`${title}: missing required field "${prefix}"`);
    }
  }

  for (const snippet of FORBIDDEN_SNIPPETS) {
    if (message.includes(snippet)) {
      errors.push(`${title}: forbidden snippet found: "${snippet}"`);
    }
  }

  if (!message.includes(`Сценарий: ${expected.scenario}`)) {
    errors.push(`${title}: expected scenario "${expected.scenario}"`);
  }

  if (!message.includes(`Тип звонка: ${expected.callType}`)) {
    errors.push(`${title}: expected call type "${expected.callType}"`);
  }

  const hasImportant = message.includes('\nВажно: ');
  if (hasImportant !== expected.hasImportant) {
    errors.push(`${title}: important line mismatch (expected ${expected.hasImportant}, got ${hasImportant})`);
  }

  if (!/Когда звонил:[^\n]*\n\nСуть звонка:/m.test(message)) {
    errors.push(`${title}: expected empty line between "Когда звонил" and "Суть звонка"`);
  }

  if (!/Сценарий:[^\n]*\n\nСотрудник:/m.test(message)) {
    errors.push(`${title}: expected empty line between "Сценарий" and "Сотрудник"`);
  }

  if (!/Тип звонка:[^\n]*$/.test(message)) {
    errors.push(`${title}: "Тип звонка" must be the last line`);
  }

  return errors;
}

let hasErrors = false;

for (const sample of CASES) {
  const normalized = normalizeAndValidateAnalysis(
    {
      ...BASE_ANALYSIS,
      ...sample.payload
    },
    { transcript: sample.transcript }
  );

  const message = formatTelegramCallSummary({
    ...BASE_CALL,
    ...(sample.callContext || {}),
    analysis: normalized
  });

  process.stdout.write(`===== ${sample.title} =====\n${message}\n\n`);

  const errors = validateMessage({
    title: sample.title,
    message,
    expected: sample.expected
  });

  for (const error of errors) {
    hasErrors = true;
    process.stderr.write(`${error}\n`);
  }
}

if (hasErrors) {
  process.exit(1);
}

process.stdout.write('Smoke telegram format v2 (report-style): OK\n');
