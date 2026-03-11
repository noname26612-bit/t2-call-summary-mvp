const CATEGORY_RULES = [
  {
    category: 'продажа',
    keywords: ['купить', 'цена', 'стоимость', 'заказать']
  },
  {
    category: 'сервис',
    keywords: ['ремонт', 'сломался', 'настроить', 'сервис']
  },
  {
    category: 'запчасти',
    keywords: ['запчасть', 'ролик', 'нож', 'деталь']
  },
  {
    category: 'аренда',
    keywords: ['аренда', 'сдать в аренду', 'взять в аренду']
  },
  {
    category: 'спам',
    keywords: ['реклама', 'спам', 'предлагаем услуги']
  }
];

const TOPIC_BY_CATEGORY = {
  продажа: 'Запрос на покупку',
  сервис: 'Запрос по обслуживанию',
  запчасти: 'Запрос по запчастям',
  аренда: 'Запрос по аренде',
  спам: 'Нежелательное рекламное обращение',
  прочее: 'Общий запрос клиента'
};

function detectCategory(normalizedTranscript) {
  for (const rule of CATEGORY_RULES) {
    const hasMatch = rule.keywords.some((keyword) => normalizedTranscript.includes(keyword));
    if (hasMatch) {
      return rule.category;
    }
  }

  return 'прочее';
}

function detectUrgency(normalizedTranscript, category) {
  const urgentWords = ['срочно', 'немедленно', 'как можно скорее', 'сегодня'];
  const hasUrgentWords = urgentWords.some((word) => normalizedTranscript.includes(word));

  if (hasUrgentWords) {
    return 'высокая';
  }

  if (['продажа', 'сервис', 'запчасти', 'аренда'].includes(category)) {
    return 'средняя';
  }

  return 'низкая';
}

function buildTags(category) {
  if (category === 'спам') {
    return ['звонок', 'спам'];
  }

  return ['звонок', category];
}

function shortenText(text) {
  const value = text.trim();
  const maxLength = 140;

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function mockAnalyzeCall(transcript) {
  const normalizedTranscript = transcript.toLowerCase();
  const category = detectCategory(normalizedTranscript);
  const topic = TOPIC_BY_CATEGORY[category] || TOPIC_BY_CATEGORY.прочее;

  let result = 'Звонок принят и зафиксирован.';
  let nextStep = 'Связаться с клиентом и уточнить детали.';

  if (category === 'спам') {
    result = 'Звонок определен как спам.';
    nextStep = 'Дополнительных действий не требуется.';
  }

  return {
    category,
    topic,
    summary: `Клиент обратился по теме: ${topic}. ${shortenText(transcript)}`,
    result,
    nextStep,
    urgency: detectUrgency(normalizedTranscript, category),
    tags: buildTags(category),
    confidence: 0.5
  };
}

module.exports = mockAnalyzeCall;
