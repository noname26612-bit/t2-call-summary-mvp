const ANALYSIS_CATEGORIES = Object.freeze([
  'запчасти',
  'ремонт',
  'покупка_станка',
  'аренда',
  'сервис',
  'доставка',
  'прочее'
]);

const ANALYSIS_URGENCY = Object.freeze(['низкая', 'средняя', 'высокая']);

const TEXT_LIMITS = Object.freeze({
  topic: 80,
  summary: 220,
  result: 160,
  nextStep: 160
});

const REQUIRED_FIELDS = Object.freeze([
  'category',
  'topic',
  'summary',
  'result',
  'nextStep',
  'urgency',
  'tags',
  'confidence'
]);

const DEFAULT_TOPIC_BY_CATEGORY = Object.freeze({
  запчасти: 'Запрос по запчастям',
  ремонт: 'Запрос на ремонт',
  покупка_станка: 'Запрос на покупку станка',
  аренда: 'Запрос по аренде оборудования',
  сервис: 'Запрос по сервису и обслуживанию',
  доставка: 'Запрос по доставке',
  прочее: 'Общий запрос клиента'
});

const DEFAULT_RESULT_BY_CATEGORY = Object.freeze({
  запчасти: 'Запрос принят, требуется уточнить наличие и сроки.',
  ремонт: 'Запрос на ремонт зафиксирован.',
  покупка_станка: 'Клиент интересуется покупкой станка.',
  аренда: 'Запрос на аренду зафиксирован.',
  сервис: 'Запрос на сервисное сопровождение зафиксирован.',
  доставка: 'Запрос по доставке зафиксирован.',
  прочее: 'Звонок зафиксирован, требуется уточнение деталей.'
});

const DEFAULT_NEXT_STEP_BY_CATEGORY = Object.freeze({
  запчасти: 'Связаться с клиентом и подтвердить наличие и сроки поставки.',
  ремонт: 'Согласовать диагностику и сроки ремонта.',
  покупка_станка: 'Подготовить коммерческое предложение и уточнить требования.',
  аренда: 'Уточнить период аренды и доступность оборудования.',
  сервис: 'Согласовать состав сервисных работ и окно обслуживания.',
  доставка: 'Уточнить адрес, способ и срок доставки.',
  прочее: 'Связаться с клиентом и уточнить детали запроса.'
});

const CATEGORY_ALIASES = Object.freeze({
  продажа: 'покупка_станка',
  покупка: 'покупка_станка',
  покупка_оборудования: 'покупка_станка',
  станок: 'покупка_станка',
  оборудование: 'покупка_станка',
  обслуживание: 'сервис',
  сервисное_обслуживание: 'сервис',
  техобслуживание: 'сервис',
  техническое_обслуживание: 'сервис',
  ремонтные_работы: 'ремонт',
  починка: 'ремонт',
  логистика: 'доставка',
  поставка: 'доставка',
  спам: 'прочее',
  другое: 'прочее'
});

const URGENCY_ALIASES = Object.freeze({
  низкий: 'низкая',
  обычная: 'средняя',
  средний: 'средняя',
  нормальная: 'средняя',
  срочно: 'высокая',
  срочная: 'высокая',
  критичная: 'высокая',
  критический: 'высокая'
});

const CATEGORY_KEYWORDS = Object.freeze([
  {
    category: 'ремонт',
    keywords: ['ремонт', 'неисправ', 'сломал', 'почин', 'диагност', 'чинить']
  },
  {
    category: 'запчасти',
    keywords: ['запчаст', 'детал', 'комплектующ', 'расходник', 'ролик', 'нож', 'подшипник']
  },
  {
    category: 'аренда',
    keywords: ['аренд', 'прокат']
  },
  {
    category: 'доставка',
    keywords: ['доставк', 'отгрузк', 'самовывоз', 'перевоз', 'логист']
  },
  {
    category: 'сервис',
    keywords: ['сервис', 'обслуживан', 'настройк', 'гаранти', 'техподдерж']
  },
  {
    category: 'покупка_станка',
    keywords: ['покуп', 'купить', 'станок', 'оборудован', 'стоимость', 'цена', 'коммерческ']
  }
]);

const HIGH_URGENCY_KEYWORDS = Object.freeze([
  'срочно',
  'немедленно',
  'как можно скорее',
  'сегодня',
  'до конца дня',
  'критично'
]);

const MEDIUM_URGENCY_KEYWORDS = Object.freeze([
  'в ближайшее время',
  'на этой неделе',
  'желательно',
  'оперативно'
]);

class AnalysisNormalizationError extends Error {
  constructor(message, code = 'ANALYSIS_NORMALIZATION_FAILED') {
    super(message);
    this.name = 'AnalysisNormalizationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
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

function normalizeEnumToken(value) {
  return normalizeWhitespace(stringFromUnknown(value)).toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeText(value, maxLength) {
  const normalized = normalizeWhitespace(stringFromUnknown(value));

  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

function inferCategoryFromText(contextText) {
  if (!contextText) {
    return null;
  }

  for (const candidate of CATEGORY_KEYWORDS) {
    const hasMatch = candidate.keywords.some((keyword) => contextText.includes(keyword));
    if (hasMatch) {
      return candidate.category;
    }
  }

  return null;
}

function normalizeCategory(rawCategory, contextText) {
  const normalizedToken = normalizeEnumToken(rawCategory);

  if (ANALYSIS_CATEGORIES.includes(normalizedToken)) {
    return normalizedToken;
  }

  const aliasValue = CATEGORY_ALIASES[normalizedToken];
  if (aliasValue && ANALYSIS_CATEGORIES.includes(aliasValue)) {
    return aliasValue;
  }

  const inferredFromText = inferCategoryFromText(contextText);
  if (inferredFromText) {
    return inferredFromText;
  }

  return 'прочее';
}

function inferUrgencyFromText(contextText) {
  if (!contextText) {
    return null;
  }

  if (HIGH_URGENCY_KEYWORDS.some((keyword) => contextText.includes(keyword))) {
    return 'высокая';
  }

  if (MEDIUM_URGENCY_KEYWORDS.some((keyword) => contextText.includes(keyword))) {
    return 'средняя';
  }

  return null;
}

function normalizeUrgency(rawUrgency, contextText) {
  const normalizedToken = normalizeEnumToken(rawUrgency);

  if (ANALYSIS_URGENCY.includes(normalizedToken)) {
    return normalizedToken;
  }

  const aliasValue = URGENCY_ALIASES[normalizedToken];
  if (aliasValue && ANALYSIS_URGENCY.includes(aliasValue)) {
    return aliasValue;
  }

  const inferredFromText = inferUrgencyFromText(contextText);
  if (inferredFromText) {
    return inferredFromText;
  }

  return 'низкая';
}

function normalizeConfidence(rawConfidence) {
  let numericValue = null;

  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
    numericValue = rawConfidence;
  } else if (typeof rawConfidence === 'string') {
    const candidate = rawConfidence.trim().replace(',', '.');
    if (candidate !== '') {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        numericValue = parsed;
      }
    }
  }

  if (numericValue === null) {
    return 0.5;
  }

  if (numericValue < 0) {
    return 0;
  }

  if (numericValue > 1) {
    return 1;
  }

  return numericValue;
}

function normalizeTags(rawTags, category) {
  const candidates = [];

  if (Array.isArray(rawTags)) {
    candidates.push(...rawTags);
  } else if (typeof rawTags === 'string') {
    candidates.push(...rawTags.split(/[;,\n|]+/));
  }

  const normalizedTags = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalizedTag = normalizeWhitespace(stringFromUnknown(candidate));
    if (!normalizedTag) {
      continue;
    }

    const dedupeKey = normalizedTag.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    normalizedTags.push(normalizedTag);
    seen.add(dedupeKey);

    if (normalizedTags.length === 5) {
      break;
    }
  }

  if (normalizedTags.length === 0) {
    if (category === 'прочее') {
      normalizedTags.push('звонок');
    } else {
      normalizedTags.push('звонок', category);
    }
  }

  return normalizedTags.slice(0, 5);
}

function buildContextText(payload, transcript) {
  const values = [transcript, payload.topic, payload.summary, payload.result, payload.nextStep]
    .map((value) => normalizeWhitespace(stringFromUnknown(value)))
    .filter((value) => value !== '');

  if (values.length === 0) {
    return '';
  }

  return values.join(' ').toLowerCase();
}

function normalizeRequiredTextField(fieldName, rawValue, maxLength, fallbackValues) {
  const directValue = normalizeText(rawValue, maxLength);
  if (directValue) {
    return directValue;
  }

  for (const fallbackCandidate of fallbackValues) {
    const fallbackValue = normalizeText(fallbackCandidate, maxLength);
    if (fallbackValue) {
      return fallbackValue;
    }
  }

  throw new AnalysisNormalizationError(
    `Cannot normalize required field "${fieldName}"`,
    `ANALYSIS_INVALID_${fieldName.toUpperCase()}`
  );
}

function validateNormalizedAnalysis(analysis) {
  if (!isPlainObject(analysis)) {
    throw new AnalysisNormalizationError('Normalized analysis must be an object', 'ANALYSIS_INVALID_OBJECT');
  }

  const keys = Object.keys(analysis);
  const missingFields = REQUIRED_FIELDS.filter((field) => !(field in analysis));
  const extraFields = keys.filter((field) => !REQUIRED_FIELDS.includes(field));

  if (missingFields.length > 0 || extraFields.length > 0) {
    throw new AnalysisNormalizationError(
      `Normalized analysis has invalid fields. Missing: [${missingFields.join(', ')}], extra: [${extraFields.join(', ')}]`,
      'ANALYSIS_INVALID_FIELDS'
    );
  }

  if (!ANALYSIS_CATEGORIES.includes(analysis.category)) {
    throw new AnalysisNormalizationError('Invalid analysis.category value', 'ANALYSIS_INVALID_CATEGORY');
  }

  for (const fieldName of ['topic', 'summary', 'result', 'nextStep']) {
    const fieldValue = analysis[fieldName];
    const maxLength = TEXT_LIMITS[fieldName];

    if (typeof fieldValue !== 'string') {
      throw new AnalysisNormalizationError(`Invalid analysis.${fieldName}: must be a string`, `ANALYSIS_INVALID_${fieldName.toUpperCase()}`);
    }

    if (fieldValue.trim() === '') {
      throw new AnalysisNormalizationError(
        `Invalid analysis.${fieldName}: value must be non-empty`,
        `ANALYSIS_INVALID_${fieldName.toUpperCase()}`
      );
    }

    if (fieldValue.trim().length > maxLength) {
      throw new AnalysisNormalizationError(
        `Invalid analysis.${fieldName}: value exceeds ${maxLength} chars`,
        `ANALYSIS_INVALID_${fieldName.toUpperCase()}`
      );
    }
  }

  if (!ANALYSIS_URGENCY.includes(analysis.urgency)) {
    throw new AnalysisNormalizationError('Invalid analysis.urgency value', 'ANALYSIS_INVALID_URGENCY');
  }

  if (!Array.isArray(analysis.tags) || analysis.tags.length < 1 || analysis.tags.length > 5) {
    throw new AnalysisNormalizationError('Invalid analysis.tags size', 'ANALYSIS_INVALID_TAGS');
  }

  const tagSet = new Set();
  for (const tag of analysis.tags) {
    if (typeof tag !== 'string' || tag.trim() === '') {
      throw new AnalysisNormalizationError('Invalid analysis.tags value', 'ANALYSIS_INVALID_TAGS');
    }

    const dedupeKey = tag.trim().toLowerCase();
    if (tagSet.has(dedupeKey)) {
      throw new AnalysisNormalizationError('Invalid analysis.tags value: duplicates are not allowed', 'ANALYSIS_INVALID_TAGS');
    }

    tagSet.add(dedupeKey);
  }

  if (typeof analysis.confidence !== 'number' || !Number.isFinite(analysis.confidence) || analysis.confidence < 0 || analysis.confidence > 1) {
    throw new AnalysisNormalizationError('Invalid analysis.confidence value', 'ANALYSIS_INVALID_CONFIDENCE');
  }
}

function normalizeAndValidateAnalysis(payload, options = {}) {
  if (!isPlainObject(payload)) {
    throw new AnalysisNormalizationError('OpenAI analysis payload must be an object', 'ANALYSIS_INVALID_JSON');
  }

  const transcript = stringFromUnknown(options.transcript);
  const contextText = buildContextText(payload, transcript);

  const category = normalizeCategory(payload.category, contextText);

  const topic = normalizeRequiredTextField('topic', payload.topic, TEXT_LIMITS.topic, [
    DEFAULT_TOPIC_BY_CATEGORY[category],
    payload.summary,
    payload.result,
    payload.nextStep,
    transcript
  ]);

  const summary = normalizeRequiredTextField('summary', payload.summary, TEXT_LIMITS.summary, [
    transcript,
    payload.result,
    payload.nextStep,
    `${DEFAULT_TOPIC_BY_CATEGORY[category]}. Требуется уточнение деталей.`
  ]);

  const result = normalizeRequiredTextField('result', payload.result, TEXT_LIMITS.result, [
    payload.summary,
    DEFAULT_RESULT_BY_CATEGORY[category],
    DEFAULT_RESULT_BY_CATEGORY.прочее
  ]);

  const nextStep = normalizeRequiredTextField('nextStep', payload.nextStep, TEXT_LIMITS.nextStep, [
    payload.result,
    DEFAULT_NEXT_STEP_BY_CATEGORY[category],
    DEFAULT_NEXT_STEP_BY_CATEGORY.прочее
  ]);

  const urgency = normalizeUrgency(payload.urgency, contextText);
  const tags = normalizeTags(payload.tags, category);
  const confidence = normalizeConfidence(payload.confidence);

  const normalized = {
    category,
    topic,
    summary,
    result,
    nextStep,
    urgency,
    tags,
    confidence
  };

  validateNormalizedAnalysis(normalized);

  return normalized;
}

module.exports = {
  ANALYSIS_CATEGORIES,
  ANALYSIS_URGENCY,
  TEXT_LIMITS,
  REQUIRED_FIELDS,
  AnalysisNormalizationError,
  normalizeAndValidateAnalysis
};
