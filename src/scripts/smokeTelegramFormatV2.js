const { normalizeAndValidateAnalysis } = require('../services/analysisNormalizer');
const { formatTelegramCallSummary } = require('../services/telegramMessageFormatter');

const BASE_CALL = {
  phone: '+79991234567',
  callDateTime: '2026-03-14T12:13:00+03:00',
  timeZone: 'Europe/Moscow'
};

const BASE_ANALYSIS = {
  category: 'прочее',
  topic: 'Общий запрос',
  summary: 'Клиент обратился с запросом.',
  result: 'Детали зафиксированы.',
  nextStep: 'Связаться с клиентом.',
  urgency: 'средняя',
  tags: ['звонок'],
  confidence: 0.8
};

const FORBIDDEN_SNIPPETS = [
  'Следующий шаг:',
  'Категория:',
  'Тема:',
  'Сводка:',
  'Результат:',
  'Просили запчасти:',
  'Просили аренду:',
  'Просили ремонт:',
  'Просили доставку:',
  'Уточнение по доставке: Вопросы по доставке'
];

const CASES = [
  {
    title: 'Запчасти + optional fields present (explicit mention)',
    transcript:
      'Добрый день, компания Станок 77. Нужны ролики направляющие и подшипник. По заказу номер 100, уточните наличие.',
    payload: {
      category: 'запчасти',
      primaryScenario: 'Запчасти',
      wantedSummary:
        'Клиент запросил запчасти для текущего заказа.\nНужно подтвердить наличие и сроки поставки.',
      partsRequested: ['ролики направляющие', 'подшипник', 'подшипник'],
      companyName: 'ООО "Станок 77"',
      orderNumber: '№100'
    },
    expected: {
      scenario: 'Запчасти',
      hasCompany: true,
      hasOrderNumber: true
    }
  },
  {
    title: 'Аренда + exact relative date allowed',
    transcript:
      'Нужна аренда станка через 3 дня на 14 дней, адрес Москва, ул. Большая Морская, 3.',
    payload: {
      category: 'аренда',
      primaryScenario: 'Аренда',
      wantedSummary:
        'Клиент просит аренду с точным стартом.\nЗапросил срок 14 дней и адрес в Москве.',
      rentalStart: '17.03.2026',
      rentalDuration: '14 дней',
      rentalAddress: 'Москва, ул. Большая Морская, 3'
    },
    expected: {
      scenario: 'Аренда',
      hasCompany: false,
      hasOrderNumber: false,
      rentalStartEquals: '17.03.2026'
    }
  },
  {
    title: 'Аренда + fuzzy relative date must stay fuzzy',
    transcript:
      'Нужна аренда, примерно через 2-3 недели. Точную дату пока назвать не могу.',
    payload: {
      category: 'аренда',
      primaryScenario: 'Аренда',
      wantedSummary:
        'Клиент назвал только примерный срок аренды.\nТочная календарная дата пока не определена.',
      rentalStart: '29.03.2026'
    },
    expected: {
      scenario: 'Аренда',
      hasCompany: false,
      hasOrderNumber: false,
      rentalStartContains: 'примерно через 2-3 недели'
    }
  },
  {
    title: 'Ремонт + optional fields must be dropped if not explicit',
    transcript:
      'Станок Sorex 3м сломался, нужен выездной ремонт на этой неделе.',
    payload: {
      category: 'сервис',
      primaryScenario: 'Ремонт',
      wantedSummary:
        'Клиент сообщил о поломке Sorex 3м.\nНужен выездной ремонт на этой неделе.',
      repairEquipment: 'Sorex 3м',
      repairDateOrTerm: 'на этой неделе',
      repairType: 'выездной',
      companyName: 'ООО "Станок 77"',
      orderNumber: '№100'
    },
    expected: {
      scenario: 'Ремонт',
      hasCompany: false,
      hasOrderNumber: false,
      companyDropped: true,
      orderDropped: true
    }
  },
  {
    title: 'Доставка as standalone primary scenario',
    transcript:
      'Подтвердите доставку до 20:00 сегодня, разгрузка на складе клиента.',
    payload: {
      category: 'сервис',
      primaryScenario: 'Доставка',
      wantedSummary:
        'Клиент уточнил сроки доставки по заказу.\nПопросил доставку до 20:00 с разгрузкой.',
      deliveryDetails: 'до 20:00, разгрузка на складе клиента'
    },
    expected: {
      scenario: 'Доставка',
      hasCompany: false,
      hasOrderNumber: false
    }
  },
  {
    title: 'Legacy/fallback safety (no enum leak to visible message)',
    transcript: 'Просто хотел уточнить общий вопрос по работе.',
    payload: {
      category: 'спам',
      primaryScenario: '',
      wantedSummary: '',
      summary: 'Клиент задал общий уточняющий вопрос.',
      result: 'Нужно уточнение деталей.'
    },
    expected: {
      scenario: 'Другое',
      hasCompany: false,
      hasOrderNumber: false
    }
  }
];

function validateMessage({ title, message, normalized, expected }) {
  const errors = [];

  for (const prefix of ['Кто звонил:', 'Когда звонил:', 'Что хотели:', 'Сценарий:']) {
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

  const hasCompanyLine = message.includes('\nКомпания: ');
  const hasOrderLine = message.includes('\nНомер заказа: ');

  if (expected.hasCompany !== hasCompanyLine) {
    errors.push(`${title}: company line mismatch (expected ${expected.hasCompany}, got ${hasCompanyLine})`);
  }

  if (expected.hasOrderNumber !== hasOrderLine) {
    errors.push(`${title}: order line mismatch (expected ${expected.hasOrderNumber}, got ${hasOrderLine})`);
  }

  if (expected.rentalStartEquals && normalized.rentalStart !== expected.rentalStartEquals) {
    errors.push(`${title}: rentalStart expected "${expected.rentalStartEquals}", got "${normalized.rentalStart || ''}"`);
  }

  if (expected.rentalStartContains) {
    if (!normalized.rentalStart || !normalized.rentalStart.toLowerCase().includes(expected.rentalStartContains.toLowerCase())) {
      errors.push(`${title}: fuzzy rentalStart guard was not applied`);
    }
  }

  if (expected.companyDropped && Object.prototype.hasOwnProperty.call(normalized, 'companyName')) {
    errors.push(`${title}: companyName should be dropped when not explicit in transcript`);
  }

  if (expected.orderDropped && Object.prototype.hasOwnProperty.call(normalized, 'orderNumber')) {
    errors.push(`${title}: orderNumber should be dropped when not explicit in transcript`);
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
    analysis: normalized
  });

  process.stdout.write(`===== ${sample.title} =====\n${message}\n\n`);

  const errors = validateMessage({
    title: sample.title,
    message,
    normalized,
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
