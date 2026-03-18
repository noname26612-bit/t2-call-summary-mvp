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
  'Сценарий:',
  'Тема:',
  'Сводка:',
  'Результат:',
  'Статус:',
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
        'Клиент запросил запчасти для текущего заказа.\nЗапрос на запчасти принят и зарегистрирован.',
      partsRequested: ['ролики направляющие', 'подшипник', 'подшипник'],
      companyName: 'ООО "Станок 77"',
      orderNumber: '№100'
    },
    expected: {
      category: 'Запчасти',
      hasCompanyLine: true,
      hasOrderLine: true,
      wantedMustContain: ['ООО "Станок 77"'],
      wantedMustMatch: [/номер заказа\s*(№\s*)?100/i],
      wantedMustNotMatch: [/\bпринят\b/i, /\bзарегистрирован/i, /\bвзят[аоы]?\s+в\s+работу/i]
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
      category: 'Аренда',
      hasCompanyLine: false,
      hasOrderLine: false,
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
      category: 'Аренда',
      hasCompanyLine: false,
      hasOrderLine: false,
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
      category: 'Ремонт',
      hasCompanyLine: false,
      hasOrderLine: false,
      companyDropped: true,
      orderDropped: true
    }
  },
  {
    title: 'Category mapping: logistics signals must win over generic service category',
    transcript:
      'Подскажите готовность станка, время работы и организацию загрузки. Нужен автопогрузчик и отгрузка сегодня.',
    payload: {
      category: 'сервис',
      topic: 'Доставка и загрузка станка',
      summary:
        'Клиент уточняет время приезда, загрузки и организацию доставки с автопогрузчиком.',
      wantedSummary:
        'Нужна доставка, отгрузка и загрузка станка.\nКлиент запросил время приезда и работу автопогрузчика.'
    },
    expected: {
      category: 'Доставка',
      hasCompanyLine: false,
      hasOrderLine: false
    }
  },
  {
    title: 'Category mapping: real repair signals must stay in repair',
    transcript:
      'Станок сломался, нужна диагностика неисправности и выездной мастер для ремонта.',
    payload: {
      category: 'сервис',
      topic: 'Поломка станка',
      summary:
        'Клиент сообщил о поломке, просит диагностику и выездной ремонт.',
      wantedSummary:
        'Нужна диагностика неисправности.\nЗапрашивают выезд мастера для ремонта.'
    },
    expected: {
      category: 'Ремонт',
      hasCompanyLine: false,
      hasOrderLine: false
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
      category: 'Доставка',
      hasCompanyLine: false,
      hasOrderLine: false
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
      category: 'Другое',
      hasCompanyLine: false,
      hasOrderLine: false
    }
  },
  {
    title: 'Outgoing call type is preserved',
    transcript: 'Перезвонили клиенту по уточнению доставки.',
    payload: {
      category: 'сервис',
      primaryScenario: 'Доставка',
      wantedSummary: 'Сотрудник позвонил клиенту для уточнения времени доставки.'
    },
    callContext: {
      callType: 'OUTGOING',
      callerNumber: '8 (495) 765-43-21',
      destinationNumber: '+7 999 111-22-33',
      calleeNumber: '+7 999 111-22-33'
    },
    expected: {
      category: 'Доставка',
      hasCompanyLine: false,
      hasOrderLine: false,
      callType: 'Исходящий'
    }
  },
  {
    title: 'Tele2 SINGLE_CHANNEL maps to incoming',
    transcript: 'Клиент позвонил на линию для уточнения ремонта.',
    payload: {
      category: 'сервис',
      primaryScenario: 'Ремонт',
      wantedSummary: 'Клиент уточнил детали ремонта.'
    },
    callContext: {
      callType: 'SINGLE_CHANNEL',
      callerNumber: '+7 999 111-22-33',
      destinationNumber: '8 (495) 123-45-67',
      calleeNumber: '+7 (495) 123-45-67'
    },
    expected: {
      category: 'Ремонт',
      hasCompanyLine: false,
      hasOrderLine: false,
      callType: 'Входящий'
    }
  },
  {
    title: 'Unknown call type keeps placeholders',
    transcript: 'Клиент задал вопрос по общим условиям.',
    payload: {
      category: 'прочее',
      wantedSummary: 'Уточнение общих условий сотрудничества.'
    },
    callContext: {
      callType: 'SIDEWAY',
      callerNumber: '+7 495 000-00-01',
      destinationNumber: '+7 495 000-00-02',
      calleeNumber: '+7 495 000-00-03'
    },
    expected: {
      category: 'Другое',
      hasCompanyLine: false,
      hasOrderLine: false,
      callType: '—'
    }
  },
  {
    title: 'Wanted summary with prefixed outcome keeps single final label',
    transcript: 'Клиент не ответил, нужно повторить попытку.',
    payload: {
      category: 'прочее',
      wantedSummary: 'Итог по фактам: Клиент не ответил, требуется повторный звонок.'
    },
    expected: {
      category: 'Другое',
      hasCompanyLine: false,
      hasOrderLine: false,
      wantedMustNotMatch: [/Итог по фактам:\s*Итог по фактам:/i]
    }
  }
];

function validateMessage({ title, message, normalized, expected }) {
  const errors = [];
  const expectedCallType = expected.callType || 'Входящий';

  for (const prefix of ['Кто звонил:', 'Когда звонил:', 'Итог по фактам:', 'Категория:', 'Тип звонка:']) {
    if (!message.includes(prefix)) {
      errors.push(`${title}: missing required field "${prefix}"`);
    }
  }

  if (message.includes('Абонент:')) {
    errors.push(`${title}: obsolete "Абонент" field should not be present`);
  }

  if (message.includes('Что хотели:')) {
    errors.push(`${title}: obsolete "Что хотели" label should not be present`);
  }

  for (const snippet of FORBIDDEN_SNIPPETS) {
    if (message.includes(snippet)) {
      errors.push(`${title}: forbidden snippet found: "${snippet}"`);
    }
  }

  if (!message.includes(`Категория: ${expected.category}`)) {
    errors.push(`${title}: expected category "${expected.category}"`);
  }

  if (!message.includes(`Тип звонка: ${expectedCallType}`)) {
    errors.push(`${title}: expected call type "${expectedCallType}"`);
  }

  if (!/Когда звонил:[^\n]*\n\nИтог по фактам:/m.test(message)) {
    errors.push(`${title}: expected empty line between "Когда звонил" and "Итог по фактам"`);
  }

  if (!/Итог по фактам:[\s\S]*\n\nКатегория:/m.test(message)) {
    errors.push(`${title}: expected empty line between "Итог по фактам" and "Категория"`);
  }

  if (!/Тип звонка:[^\n]*$/.test(message)) {
    errors.push(`${title}: "Тип звонка" must be the last line`);
  }

  const hasCompanyLine = message.includes('\nКомпания: ');
  const hasOrderLine = message.includes('\nНомер заказа: ');

  if (typeof expected.hasCompanyLine === 'boolean' && expected.hasCompanyLine !== hasCompanyLine) {
    errors.push(`${title}: company line mismatch (expected ${expected.hasCompanyLine}, got ${hasCompanyLine})`);
  }

  if (typeof expected.hasOrderLine === 'boolean' && expected.hasOrderLine !== hasOrderLine) {
    errors.push(`${title}: order line mismatch (expected ${expected.hasOrderLine}, got ${hasOrderLine})`);
  }

  if (hasCompanyLine || hasOrderLine) {
    if (!/Категория:[^\n]*\n\n(Компания:|Номер заказа:)/m.test(message)) {
      errors.push(`${title}: expected empty line before company/order block`);
    }
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

  if (Array.isArray(expected.wantedMustContain)) {
    for (const token of expected.wantedMustContain) {
      if (!message.includes(token)) {
        errors.push(`${title}: "Итог по фактам" should contain "${token}"`);
      }
    }
  }

  if (Array.isArray(expected.wantedMustMatch)) {
    for (const pattern of expected.wantedMustMatch) {
      if (!pattern.test(message)) {
        errors.push(`${title}: "Итог по фактам" should match ${pattern}`);
      }
    }
  }

  if (Array.isArray(expected.wantedMustNotMatch)) {
    for (const pattern of expected.wantedMustNotMatch) {
      if (pattern.test(message)) {
        errors.push(`${title}: "Итог по фактам" should not include status-like phrase ${pattern}`);
      }
    }
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
