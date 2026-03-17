const ANALYSIS_CATEGORIES = Object.freeze([
  'продажа',
  'сервис',
  'запчасти',
  'аренда',
  'спам',
  'прочее'
]);

const ANALYSIS_URGENCY = Object.freeze(['низкая', 'средняя', 'высокая']);
const PRIMARY_SCENARIOS = Object.freeze(['Запчасти', 'Аренда', 'Ремонт', 'Доставка', 'Другое']);
const REPAIR_TYPES = Object.freeze(['капитальный', 'выездной']);

const TEXT_LIMITS = Object.freeze({
  topic: 80,
  summary: 220,
  result: 160,
  nextStep: 160,
  transcriptPlain: 20000,
  participantsAssumption: 120,
  detectedClientSpeaker: 80,
  detectedEmployeeSpeaker: 80,
  clientGoal: 220,
  employeeResponse: 220,
  issueReason: 220,
  outcome: 220,
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

const OPTIONAL_FIELDS = Object.freeze([
  'primaryScenario',
  'wantedSummary',
  'transcriptPlain',
  'reconstructedTurns',
  'participantsAssumption',
  'detectedClientSpeaker',
  'detectedEmployeeSpeaker',
  'speakerRoleConfidence',
  'clientGoal',
  'employeeResponse',
  'issueReason',
  'outcome',
  'nextStepStructured',
  'analysisWarnings',
  'partsRequested',
  'rentalStart',
  'rentalDuration',
  'rentalAddress',
  'repairEquipment',
  'repairDateOrTerm',
  'repairType',
  'repairAddress',
  'deliveryDetails',
  'companyName',
  'orderNumber'
]);

const PRIMARY_SCENARIO_BY_CATEGORY = Object.freeze({
  запчасти: 'Запчасти',
  аренда: 'Аренда',
  сервис: 'Ремонт',
  продажа: 'Другое',
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

const COMPANY_NOISE_TOKENS = new Set([
  'ооо',
  'ооо"',
  '"ооо',
  'ип',
  'зао',
  'ао',
  'пао',
  'оао',
  'llc',
  'ltd',
  'inc',
  'company',
  'компания'
]);

const DEFAULT_TOPIC_BY_CATEGORY = Object.freeze({
  продажа: 'Запрос на покупку оборудования',
  сервис: 'Запрос по сервису и обслуживанию',
  запчасти: 'Запрос по запчастям',
  аренда: 'Запрос по аренде оборудования',
  спам: 'Нежелательное обращение (спам)',
  прочее: 'Общий запрос клиента'
});

const DEFAULT_RESULT_BY_CATEGORY = Object.freeze({
  продажа: 'Клиент заинтересован в покупке, требуется уточнение параметров и сроков.',
  сервис: 'Запрос на сервис/ремонт зафиксирован.',
  запчасти: 'Запрос принят, требуется уточнить наличие и сроки.',
  аренда: 'Запрос на аренду зафиксирован.',
  спам: 'Звонок классифицирован как спам.',
  прочее: 'Звонок зафиксирован, требуется уточнение деталей.'
});

const DEFAULT_NEXT_STEP_BY_CATEGORY = Object.freeze({
  продажа: 'Подготовить коммерческое предложение и уточнить требования клиента.',
  сервис: 'Согласовать состав работ, сроки и формат обслуживания.',
  запчасти: 'Связаться с клиентом и подтвердить наличие и сроки поставки.',
  аренда: 'Уточнить период аренды и доступность оборудования.',
  спам: 'Не выполнять дальнейших действий по заявке и пометить обращение как спам.',
  прочее: 'Связаться с клиентом и уточнить детали запроса.'
});

const CATEGORY_ALIASES = Object.freeze({
  продажи: 'продажа',
  покупка: 'продажа',
  покупка_станка: 'продажа',
  покупка_оборудования: 'продажа',
  станок: 'продажа',
  оборудование: 'продажа',
  лид: 'продажа',
  обслуживание: 'сервис',
  сервисное_обслуживание: 'сервис',
  техобслуживание: 'сервис',
  техническое_обслуживание: 'сервис',
  ремонт: 'сервис',
  ремонтные_работы: 'сервис',
  починка: 'сервис',
  доставка: 'сервис',
  логистика: 'сервис',
  поставка: 'сервис',
  spam: 'спам',
  junk: 'спам',
  рекламный_звонок: 'спам',
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
    category: 'спам',
    keywords: ['спам', 'реклама', 'робот', 'холодный обзвон', 'кредит', 'займ', 'страховк']
  },
  {
    category: 'сервис',
    keywords: [
      'сервис',
      'обслуживан',
      'настройк',
      'гаранти',
      'техподдерж',
      'ремонт',
      'неисправ',
      'сломал',
      'почин',
      'диагност',
      'чинить',
      'доставк',
      'отгрузк',
      'самовывоз',
      'перевоз',
      'логист'
    ]
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
    category: 'продажа',
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

function normalizeUniqueStringArray(rawValues, { maxLength, maxItems }) {
  const candidates = [];

  if (Array.isArray(rawValues)) {
    candidates.push(...rawValues);
  } else if (typeof rawValues === 'string') {
    candidates.push(...rawValues.split(/[;,\n|]+/));
  }

  const normalizedItems = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = normalizeOptionalText(candidate, maxLength);
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

function inferPrimaryScenarioFromText(contextText) {
  if (!contextText) {
    return null;
  }

  if (contextText.includes('запчаст') || contextText.includes('подшип') || contextText.includes('ролик')) {
    return 'Запчасти';
  }

  if (contextText.includes('аренд') || contextText.includes('прокат')) {
    return 'Аренда';
  }

  if (
    contextText.includes('доставк') ||
    contextText.includes('логист') ||
    contextText.includes('самовывоз') ||
    contextText.includes('отгруз')
  ) {
    return 'Доставка';
  }

  if (
    contextText.includes('ремонт') ||
    contextText.includes('сервис') ||
    contextText.includes('неисправ') ||
    contextText.includes('диагност')
  ) {
    return 'Ремонт';
  }

  return null;
}

function normalizePrimaryScenario(rawPrimaryScenario, category, contextText) {
  const normalizedToken = normalizeEnumToken(rawPrimaryScenario);
  if (normalizedToken) {
    const aliasValue = PRIMARY_SCENARIO_ALIASES[normalizedToken];
    if (aliasValue) {
      return aliasValue;
    }
  }

  const inferredFromText = inferPrimaryScenarioFromText(contextText);
  if (inferredFromText) {
    return inferredFromText;
  }

  return PRIMARY_SCENARIO_BY_CATEGORY[category] || 'Другое';
}

function normalizeWantedSummary(rawWantedSummary, fallbackCandidates) {
  const linesFromRaw = stringFromUnknown(rawWantedSummary)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => normalizeOptionalText(line, TEXT_LIMITS.wantedSummary))
    .filter((line) => line !== '');

  const fallbackLines = fallbackCandidates
    .map((value) => normalizeOptionalText(value, TEXT_LIMITS.summary))
    .filter((line) => line !== '');

  const merged = [...linesFromRaw];
  if (linesFromRaw.length < 2) {
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
    return clampMultilineText(`${deduped[0]}\nКлючевые детали уточняются.`, TEXT_LIMITS.wantedSummary);
  }

  return clampMultilineText(deduped.join('\n'), TEXT_LIMITS.wantedSummary);
}

function normalizeRepairType(rawRepairType) {
  const normalizedToken = normalizeEnumToken(rawRepairType);
  if (!normalizedToken) {
    return '';
  }

  if (['выездной', 'выезд', 'on_site', 'onsite'].includes(normalizedToken)) {
    return 'выездной';
  }

  if (['капитальный', 'цех', 'в_цеху', 'стационарный'].includes(normalizedToken)) {
    return 'капитальный';
  }

  return '';
}

function normalizeTranscriptForEvidence(transcript) {
  return stringFromUnknown(transcript)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFuzzyRelativeDatePhrase(transcript) {
  const source = stringFromUnknown(transcript);
  if (!source) {
    return '';
  }

  const patterns = [
    /через\s+\d+\s*[-–]\s*\d+\s*(?:дн(?:я|ей)?|недел(?:ю|и|ь)?|месяц(?:а|ев)?|час(?:а|ов)?)/iu,
    /(?:примерно|приблизительно|около)\s+через\s+\d+\s*(?:дн(?:я|ей)?|недел(?:ю|и|ь)?|месяц(?:а|ев)?)/iu,
    /через\s+(?:пару|несколько)\s+(?:дн(?:ей|я)?|недель|месяц(?:ев|а)?)/iu
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match[0]) {
      return normalizeWhitespace(match[0]);
    }
  }

  return '';
}

function looksLikeExactCalendarDate(value) {
  const text = normalizeWhitespace(stringFromUnknown(value));
  if (!text) {
    return false;
  }

  const patterns = [
    /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u,
    /^\d{4}-\d{2}-\d{2}$/u,
    /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+\d{1,2}:\d{2}$/u
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function applyFuzzyRelativeDateGuard(value, transcript, maxLength) {
  const normalized = normalizeOptionalText(value, maxLength);
  if (!normalized) {
    return '';
  }

  const fuzzyPhrase = extractFuzzyRelativeDatePhrase(transcript);
  if (!fuzzyPhrase) {
    return normalized;
  }

  if (!looksLikeExactCalendarDate(normalized)) {
    return normalized;
  }

  const normalizedFuzzyPhrase = fuzzyPhrase.toLowerCase().startsWith('примерно ')
    ? fuzzyPhrase
    : `примерно ${fuzzyPhrase}`;

  return normalizeOptionalText(normalizedFuzzyPhrase, maxLength);
}

function isCompanyExplicitlyMentioned(companyName, transcript) {
  const normalizedCompanyName = normalizeOptionalText(companyName, TEXT_LIMITS.companyName);
  if (!normalizedCompanyName) {
    return false;
  }

  const normalizedTranscript = normalizeTranscriptForEvidence(transcript);
  if (!normalizedTranscript) {
    return false;
  }

  const cleanedCompanyText = normalizedCompanyName
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanedCompanyText) {
    return false;
  }

  const rawTokens = cleanedCompanyText
    .split(/\s+/)
    .filter((token) => token !== '');

  const wordTokens = rawTokens.filter(
    (token) => token.length >= 3 && !COMPANY_NOISE_TOKENS.has(token) && !/^\d+$/.test(token)
  );
  const numberTokens = rawTokens.filter((token) => /^\d{2,}$/.test(token));

  const normalizedCompanyPhrase = [...wordTokens, ...numberTokens].join(' ').trim();
  if (normalizedCompanyPhrase && normalizedTranscript.includes(normalizedCompanyPhrase)) {
    return true;
  }

  const wordMatches = wordTokens.filter((token) => normalizedTranscript.includes(token)).length;
  const numberMatches = numberTokens.filter((token) => normalizedTranscript.includes(token)).length;

  if (wordTokens.length >= 2 && wordMatches >= 2) {
    return numberTokens.length === 0 || numberMatches >= 1;
  }

  if (wordTokens.length >= 1 && numberTokens.length >= 1) {
    return wordMatches >= 1 && numberMatches >= 1;
  }

  if (wordTokens.length === 1) {
    const token = wordTokens[0];
    const explicitCompanyMarkers = [`компания ${token}`, `ооо ${token}`, `ип ${token}`, `фирма ${token}`];
    return explicitCompanyMarkers.some((marker) => normalizedTranscript.includes(marker));
  }

  if (numberTokens.length >= 1) {
    return numberMatches >= 1 && normalizedTranscript.includes('заказ');
  }

  if (rawTokens.length > 0) {
    return normalizedTranscript.includes(cleanedCompanyText);
  }

  return false;
}

function isOrderNumberExplicitlyMentioned(orderNumber, transcript) {
  const normalizedOrderNumber = normalizeOptionalText(orderNumber, TEXT_LIMITS.orderNumber);
  if (!normalizedOrderNumber) {
    return false;
  }

  const normalizedTranscript = normalizeTranscriptForEvidence(transcript);
  if (!normalizedTranscript) {
    return false;
  }

  const orderDigits = normalizedOrderNumber.match(/\d{2,}/g) || [];
  if (orderDigits.length > 0) {
    const hasDigits = orderDigits.some((digits) => normalizedTranscript.includes(digits));
    const hasOrderContext = normalizedTranscript.includes('заказ') || normalizedTranscript.includes('номер');
    return hasDigits && hasOrderContext;
  }

  const compactOrderToken = normalizedOrderNumber
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();

  if (compactOrderToken.length < 3) {
    return false;
  }

  const compactTranscript = normalizedTranscript.replace(/\s+/g, '');
  return compactTranscript.includes(compactOrderToken);
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

function normalizeOptionalConfidence(rawConfidence) {
  if (rawConfidence === null || rawConfidence === undefined || rawConfidence === '') {
    return null;
  }

  return normalizeConfidence(rawConfidence);
}

function normalizeReconstructedTurns(rawTurns) {
  if (!Array.isArray(rawTurns)) {
    return [];
  }

  const normalized = [];

  for (const rawTurn of rawTurns) {
    if (!isPlainObject(rawTurn)) {
      continue;
    }

    const speaker = normalizeOptionalText(rawTurn.speaker, TEXT_LIMITS.reconstructedTurnSpeaker);
    const text = normalizeOptionalText(rawTurn.text, TEXT_LIMITS.reconstructedTurnText);
    const roleToken = normalizeEnumToken(rawTurn.role);
    const role = ['client', 'employee', 'unknown'].includes(roleToken) ? roleToken : 'unknown';
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

    normalized.push(turn);
    if (normalized.length >= 20) {
      break;
    }
  }

  return normalized;
}

function normalizeAnalysisWarnings(rawWarnings) {
  const warnings = [];
  const seen = new Set();

  const rawItems = Array.isArray(rawWarnings)
    ? rawWarnings
    : (typeof rawWarnings === 'string' ? rawWarnings.split(/[;\n|]+/) : []);

  for (const rawItem of rawItems) {
    const normalizedWarning = normalizeOptionalText(rawItem, TEXT_LIMITS.analysisWarningItem);
    if (!normalizedWarning) {
      continue;
    }

    const dedupeKey = normalizedWarning.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    warnings.push(normalizedWarning);

    if (warnings.length >= 8) {
      break;
    }
  }

  return warnings;
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
  const values = [
    transcript,
    payload.topic,
    payload.summary,
    payload.result,
    payload.nextStep,
    payload.wantedSummary,
    payload.primaryScenario,
    payload.deliveryDetails
  ]
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
  const extraFields = keys.filter((field) => !REQUIRED_FIELDS.includes(field) && !OPTIONAL_FIELDS.includes(field));

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

  if ('primaryScenario' in analysis && !PRIMARY_SCENARIOS.includes(analysis.primaryScenario)) {
    throw new AnalysisNormalizationError('Invalid analysis.primaryScenario value', 'ANALYSIS_INVALID_PRIMARY_SCENARIO');
  }

  if ('wantedSummary' in analysis) {
    if (typeof analysis.wantedSummary !== 'string' || analysis.wantedSummary.trim() === '') {
      throw new AnalysisNormalizationError('Invalid analysis.wantedSummary value', 'ANALYSIS_INVALID_WANTED_SUMMARY');
    }

    if (analysis.wantedSummary.trim().length > TEXT_LIMITS.wantedSummary) {
      throw new AnalysisNormalizationError('Invalid analysis.wantedSummary length', 'ANALYSIS_INVALID_WANTED_SUMMARY');
    }
  }

  if ('partsRequested' in analysis) {
    if (!Array.isArray(analysis.partsRequested) || analysis.partsRequested.length > 10) {
      throw new AnalysisNormalizationError('Invalid analysis.partsRequested value', 'ANALYSIS_INVALID_PARTS_REQUESTED');
    }

    const partKeys = new Set();
    for (const part of analysis.partsRequested) {
      if (typeof part !== 'string' || part.trim() === '') {
        throw new AnalysisNormalizationError('Invalid analysis.partsRequested item', 'ANALYSIS_INVALID_PARTS_REQUESTED');
      }

      if (part.trim().length > TEXT_LIMITS.partsItem) {
        throw new AnalysisNormalizationError('Invalid analysis.partsRequested item length', 'ANALYSIS_INVALID_PARTS_REQUESTED');
      }

      const partKey = part.trim().toLowerCase();
      if (partKeys.has(partKey)) {
        throw new AnalysisNormalizationError('Invalid analysis.partsRequested duplicates', 'ANALYSIS_INVALID_PARTS_REQUESTED');
      }

      partKeys.add(partKey);
    }
  }

  for (const fieldName of [
    'rentalStart',
    'rentalDuration',
    'rentalAddress',
    'repairEquipment',
    'repairDateOrTerm',
    'repairAddress',
    'deliveryDetails',
    'companyName',
    'orderNumber'
  ]) {
    if (!(fieldName in analysis)) {
      continue;
    }

    const fieldValue = analysis[fieldName];
    const maxLength = TEXT_LIMITS[fieldName];

    if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
      throw new AnalysisNormalizationError(`Invalid analysis.${fieldName} value`, `ANALYSIS_INVALID_${fieldName.toUpperCase()}`);
    }

    if (maxLength && fieldValue.trim().length > maxLength) {
      throw new AnalysisNormalizationError(
        `Invalid analysis.${fieldName} length`,
        `ANALYSIS_INVALID_${fieldName.toUpperCase()}`
      );
    }
  }

  if ('repairType' in analysis && !REPAIR_TYPES.includes(analysis.repairType)) {
    throw new AnalysisNormalizationError('Invalid analysis.repairType value', 'ANALYSIS_INVALID_REPAIR_TYPE');
  }

  if ('transcriptPlain' in analysis) {
    if (typeof analysis.transcriptPlain !== 'string') {
      throw new AnalysisNormalizationError(
        'Invalid analysis.transcriptPlain value',
        'ANALYSIS_INVALID_TRANSCRIPT_PLAIN'
      );
    }

    if (analysis.transcriptPlain.length > TEXT_LIMITS.transcriptPlain) {
      throw new AnalysisNormalizationError(
        'Invalid analysis.transcriptPlain length',
        'ANALYSIS_INVALID_TRANSCRIPT_PLAIN'
      );
    }
  }

  for (const fieldName of [
    'participantsAssumption',
    'detectedClientSpeaker',
    'detectedEmployeeSpeaker',
    'clientGoal',
    'employeeResponse',
    'issueReason',
    'outcome',
    'nextStepStructured'
  ]) {
    if (!(fieldName in analysis)) {
      continue;
    }

    const fieldValue = analysis[fieldName];
    const maxLength = TEXT_LIMITS[fieldName];

    if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
      throw new AnalysisNormalizationError(`Invalid analysis.${fieldName} value`, `ANALYSIS_INVALID_${fieldName.toUpperCase()}`);
    }

    if (fieldValue.trim().length > maxLength) {
      throw new AnalysisNormalizationError(
        `Invalid analysis.${fieldName} length`,
        `ANALYSIS_INVALID_${fieldName.toUpperCase()}`
      );
    }
  }

  if ('speakerRoleConfidence' in analysis) {
    if (
      typeof analysis.speakerRoleConfidence !== 'number' ||
      !Number.isFinite(analysis.speakerRoleConfidence) ||
      analysis.speakerRoleConfidence < 0 ||
      analysis.speakerRoleConfidence > 1
    ) {
      throw new AnalysisNormalizationError(
        'Invalid analysis.speakerRoleConfidence value',
        'ANALYSIS_INVALID_SPEAKER_ROLE_CONFIDENCE'
      );
    }
  }

  if ('reconstructedTurns' in analysis) {
    if (!Array.isArray(analysis.reconstructedTurns) || analysis.reconstructedTurns.length > 20) {
      throw new AnalysisNormalizationError(
        'Invalid analysis.reconstructedTurns value',
        'ANALYSIS_INVALID_RECONSTRUCTED_TURNS'
      );
    }

    for (const turn of analysis.reconstructedTurns) {
      if (!isPlainObject(turn)) {
        throw new AnalysisNormalizationError(
          'Invalid analysis.reconstructedTurns item',
          'ANALYSIS_INVALID_RECONSTRUCTED_TURNS'
        );
      }

      if (
        !['client', 'employee', 'unknown'].includes(turn.role) ||
        typeof turn.speaker !== 'string' ||
        typeof turn.text !== 'string' ||
        turn.speaker.trim() === '' ||
        turn.text.trim() === ''
      ) {
        throw new AnalysisNormalizationError(
          'Invalid analysis.reconstructedTurns item',
          'ANALYSIS_INVALID_RECONSTRUCTED_TURNS'
        );
      }

      if (
        turn.speaker.length > TEXT_LIMITS.reconstructedTurnSpeaker ||
        turn.text.length > TEXT_LIMITS.reconstructedTurnText
      ) {
        throw new AnalysisNormalizationError(
          'Invalid analysis.reconstructedTurns item length',
          'ANALYSIS_INVALID_RECONSTRUCTED_TURNS'
        );
      }

      if ('confidence' in turn) {
        if (
          typeof turn.confidence !== 'number' ||
          !Number.isFinite(turn.confidence) ||
          turn.confidence < 0 ||
          turn.confidence > 1
        ) {
          throw new AnalysisNormalizationError(
            'Invalid analysis.reconstructedTurns confidence',
            'ANALYSIS_INVALID_RECONSTRUCTED_TURNS'
          );
        }
      }
    }
  }

  if ('analysisWarnings' in analysis) {
    if (!Array.isArray(analysis.analysisWarnings) || analysis.analysisWarnings.length > 8) {
      throw new AnalysisNormalizationError(
        'Invalid analysis.analysisWarnings value',
        'ANALYSIS_INVALID_ANALYSIS_WARNINGS'
      );
    }

    const warningSet = new Set();
    for (const warning of analysis.analysisWarnings) {
      if (typeof warning !== 'string' || warning.trim() === '') {
        throw new AnalysisNormalizationError(
          'Invalid analysis.analysisWarnings item',
          'ANALYSIS_INVALID_ANALYSIS_WARNINGS'
        );
      }

      if (warning.length > TEXT_LIMITS.analysisWarningItem) {
        throw new AnalysisNormalizationError(
          'Invalid analysis.analysisWarnings item length',
          'ANALYSIS_INVALID_ANALYSIS_WARNINGS'
        );
      }

      const warningKey = warning.toLowerCase();
      if (warningSet.has(warningKey)) {
        throw new AnalysisNormalizationError(
          'Invalid analysis.analysisWarnings duplicates',
          'ANALYSIS_INVALID_ANALYSIS_WARNINGS'
        );
      }

      warningSet.add(warningKey);
    }
  }

  if (typeof analysis.confidence !== 'number' || !Number.isFinite(analysis.confidence) || analysis.confidence < 0 || analysis.confidence > 1) {
    throw new AnalysisNormalizationError('Invalid analysis.confidence value', 'ANALYSIS_INVALID_CONFIDENCE');
  }
}

function pickFirstDefined(payload, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return payload[key];
    }
  }

  return undefined;
}

function normalizeAndValidateAnalysis(payload, options = {}) {
  if (!isPlainObject(payload)) {
    throw new AnalysisNormalizationError('Analysis payload must be an object', 'ANALYSIS_INVALID_JSON');
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
  const primaryScenario = normalizePrimaryScenario(payload.primaryScenario, category, contextText);
  const wantedSummary = normalizeWantedSummary(payload.wantedSummary, [
    payload.summary,
    payload.result,
    summary,
    result
  ]);
  const partsRequested = normalizeUniqueStringArray(payload.partsRequested, {
    maxLength: TEXT_LIMITS.partsItem,
    maxItems: 10
  });
  const rentalStart = applyFuzzyRelativeDateGuard(payload.rentalStart, transcript, TEXT_LIMITS.rentalStart);
  const rentalDuration = normalizeOptionalText(payload.rentalDuration, TEXT_LIMITS.rentalDuration);
  const rentalAddress = normalizeOptionalText(payload.rentalAddress, TEXT_LIMITS.rentalAddress);
  const repairEquipment = normalizeOptionalText(payload.repairEquipment, TEXT_LIMITS.repairEquipment);
  const repairDateOrTerm = applyFuzzyRelativeDateGuard(
    payload.repairDateOrTerm,
    transcript,
    TEXT_LIMITS.repairDateOrTerm
  );
  const repairType = normalizeRepairType(payload.repairType);
  const repairAddress = normalizeOptionalText(payload.repairAddress, TEXT_LIMITS.repairAddress);
  const deliveryDetails = normalizeOptionalText(payload.deliveryDetails, TEXT_LIMITS.deliveryDetails);
  const companyName = normalizeOptionalText(payload.companyName, TEXT_LIMITS.companyName);
  const orderNumber = normalizeOptionalText(payload.orderNumber, TEXT_LIMITS.orderNumber);
  const transcriptPlain = clampMultilineText(
    stringFromUnknown(
      pickFirstDefined(payload, ['transcriptPlain', 'transcript_plain']) || transcript
    ),
    TEXT_LIMITS.transcriptPlain
  );
  const reconstructedTurns = normalizeReconstructedTurns(
    pickFirstDefined(payload, ['reconstructedTurns', 'reconstructed_turns'])
  );
  const participantsAssumption = normalizeOptionalText(
    pickFirstDefined(payload, ['participantsAssumption', 'participants_assumption']),
    TEXT_LIMITS.participantsAssumption
  ) || 'Предположение: два участника разговора (клиент и сотрудник).';
  const detectedClientSpeaker = normalizeOptionalText(
    pickFirstDefined(payload, ['detectedClientSpeaker', 'detected_client_speaker']),
    TEXT_LIMITS.detectedClientSpeaker
  );
  const detectedEmployeeSpeaker = normalizeOptionalText(
    pickFirstDefined(payload, ['detectedEmployeeSpeaker', 'detected_employee_speaker']),
    TEXT_LIMITS.detectedEmployeeSpeaker
  );
  const speakerRoleConfidence = normalizeOptionalConfidence(
    pickFirstDefined(payload, ['speakerRoleConfidence', 'speaker_role_confidence'])
  );
  const clientGoal = normalizeOptionalText(
    pickFirstDefined(payload, ['clientGoal', 'client_goal']),
    TEXT_LIMITS.clientGoal
  );
  const employeeResponse = normalizeOptionalText(
    pickFirstDefined(payload, ['employeeResponse', 'employee_response']),
    TEXT_LIMITS.employeeResponse
  );
  const issueReason = normalizeOptionalText(
    pickFirstDefined(payload, ['issueReason', 'issue_reason']),
    TEXT_LIMITS.issueReason
  );
  const outcome = normalizeOptionalText(
    pickFirstDefined(payload, ['outcome']),
    TEXT_LIMITS.outcome
  );
  const nextStepStructured = normalizeOptionalText(
    pickFirstDefined(payload, ['nextStepStructured', 'next_step_structured']),
    TEXT_LIMITS.nextStepStructured
  );
  const analysisWarnings = normalizeAnalysisWarnings(
    pickFirstDefined(payload, ['analysisWarnings', 'analysis_warnings'])
  );

  if (speakerRoleConfidence !== null && speakerRoleConfidence < 0.45 && analysisWarnings.length === 0) {
    analysisWarnings.push('Низкая уверенность в назначении ролей участников.');
  }

  const normalized = {
    category,
    topic,
    summary,
    result,
    nextStep,
    urgency,
    tags,
    confidence,
    primaryScenario,
    wantedSummary
  };

  if (partsRequested.length > 0) {
    normalized.partsRequested = partsRequested;
  }

  if (rentalStart) {
    normalized.rentalStart = rentalStart;
  }

  if (rentalDuration) {
    normalized.rentalDuration = rentalDuration;
  }

  if (rentalAddress) {
    normalized.rentalAddress = rentalAddress;
  }

  if (repairEquipment) {
    normalized.repairEquipment = repairEquipment;
  }

  if (repairDateOrTerm) {
    normalized.repairDateOrTerm = repairDateOrTerm;
  }

  if (repairType) {
    normalized.repairType = repairType;
  }

  if (repairAddress) {
    normalized.repairAddress = repairAddress;
  }

  if (deliveryDetails) {
    normalized.deliveryDetails = deliveryDetails;
  }

  if (companyName && isCompanyExplicitlyMentioned(companyName, transcript)) {
    normalized.companyName = companyName;
  }

  if (orderNumber && isOrderNumberExplicitlyMentioned(orderNumber, transcript)) {
    normalized.orderNumber = orderNumber;
  }

  if (transcriptPlain) {
    normalized.transcriptPlain = transcriptPlain;
  }

  if (reconstructedTurns.length > 0) {
    normalized.reconstructedTurns = reconstructedTurns;
  }

  if (participantsAssumption) {
    normalized.participantsAssumption = participantsAssumption;
  }

  if (detectedClientSpeaker) {
    normalized.detectedClientSpeaker = detectedClientSpeaker;
  }

  if (detectedEmployeeSpeaker) {
    normalized.detectedEmployeeSpeaker = detectedEmployeeSpeaker;
  }

  if (speakerRoleConfidence !== null) {
    normalized.speakerRoleConfidence = speakerRoleConfidence;
  }

  if (clientGoal) {
    normalized.clientGoal = clientGoal;
  }

  if (employeeResponse) {
    normalized.employeeResponse = employeeResponse;
  }

  if (issueReason) {
    normalized.issueReason = issueReason;
  }

  if (outcome) {
    normalized.outcome = outcome;
  }

  if (nextStepStructured) {
    normalized.nextStepStructured = nextStepStructured;
  }

  if (analysisWarnings.length > 0) {
    normalized.analysisWarnings = analysisWarnings;
  }

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
