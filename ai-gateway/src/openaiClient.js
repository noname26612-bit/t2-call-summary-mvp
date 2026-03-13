const OpenAI = require('openai');

const ANALYSIS_CATEGORIES = Object.freeze([
  'продажа',
  'сервис',
  'запчасти',
  'аренда',
  'спам',
  'прочее'
]);

const ANALYSIS_PRIORITIES = Object.freeze(['low', 'medium', 'high']);

const MAX_TEXT_LENGTH = Object.freeze({
  topic: 80,
  summary: 220,
  outcome: 180,
  nextStep: 180
});

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'topic', 'summary', 'outcome', 'nextStep', 'priority', 'tags'],
  properties: {
    category: {
      type: 'string',
      enum: ANALYSIS_CATEGORIES
    },
    topic: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.topic
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.summary
    },
    outcome: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.outcome
    },
    nextStep: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.nextStep
    },
    priority: {
      type: 'string',
      enum: ANALYSIS_PRIORITIES
    },
    tags: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 32
      }
    }
  }
};

const SYSTEM_PROMPT = `
Ты анализатор телефонных разговоров.
Верни строго JSON-объект без markdown и без пояснений.

Поле category: одно значение из [продажа, сервис, запчасти, аренда, спам, прочее].
Поле priority: одно значение из [low, medium, high].
Поле tags: массив строк от 1 до 5 тегов без дублей.

Если данных мало, ставь:
- category: "прочее"
- priority: "low"
- нейтральные формулировки в summary/outcome/nextStep.
`;

class OpenAIClientError extends Error {
  constructor(message, statusCode = 502, code = 'POLZA_CLIENT_ERROR') {
    super(message);
    this.name = 'OpenAIClientError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function sanitizePolzaErrorMessage(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;

  if (status === 401) {
    return 'Polza authentication failed';
  }

  if (status === 429) {
    return 'Polza rate limit reached';
  }

  if (status && status >= 500) {
    return 'Polza upstream server error';
  }

  if (status) {
    return `Polza request failed with status ${status}`;
  }

  return 'Polza request failed';
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeText(value, maxLength) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

function normalizeEnum(value, allowedValues, fallbackValue) {
  if (!isNonEmptyString(value)) {
    return fallbackValue;
  }

  const normalized = normalizeWhitespace(value).toLowerCase();
  if (allowedValues.includes(normalized)) {
    return normalized;
  }

  return fallbackValue;
}

function normalizeTags(rawTags) {
  if (!Array.isArray(rawTags)) {
    return [];
  }

  const unique = new Set();
  const tags = [];

  for (const tag of rawTags) {
    if (!isNonEmptyString(tag)) {
      continue;
    }

    const normalized = normalizeText(tag, 32).toLowerCase();
    if (!normalized || unique.has(normalized)) {
      continue;
    }

    unique.add(normalized);
    tags.push(normalized);

    if (tags.length === 5) {
      break;
    }
  }

  return tags;
}

function normalizeAndValidateAnalysis(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenAIClientError('Polza returned invalid analysis payload shape', 502, 'POLZA_INVALID_PAYLOAD');
  }

  const normalized = {
    category: normalizeEnum(raw.category, ANALYSIS_CATEGORIES, 'прочее'),
    topic: normalizeText(raw.topic, MAX_TEXT_LENGTH.topic),
    summary: normalizeText(raw.summary, MAX_TEXT_LENGTH.summary),
    outcome: normalizeText(raw.outcome, MAX_TEXT_LENGTH.outcome),
    nextStep: normalizeText(raw.nextStep, MAX_TEXT_LENGTH.nextStep),
    priority: normalizeEnum(raw.priority, ANALYSIS_PRIORITIES, 'low'),
    tags: normalizeTags(raw.tags)
  };

  if (!normalized.topic) {
    normalized.topic = 'Общий запрос клиента';
  }

  if (!normalized.summary) {
    normalized.summary = 'Запрос клиента зафиксирован.';
  }

  if (!normalized.outcome) {
    normalized.outcome = 'Требуется уточнение деталей.';
  }

  if (!normalized.nextStep) {
    normalized.nextStep = 'Связаться с клиентом для уточнения деталей.';
  }

  if (normalized.tags.length === 0) {
    normalized.tags = ['звонок'];
  }

  return normalized;
}

function buildUserPrompt(payload) {
  const lines = [
    'Сформируй структурированный анализ по транскрипту звонка.',
    `phone: ${isNonEmptyString(payload.phone) ? payload.phone.trim() : 'unknown'}`,
    `callDateTime: ${isNonEmptyString(payload.callDateTime) ? payload.callDateTime.trim() : 'unknown'}`,
    'transcript:',
    payload.transcript
  ];

  return lines.join('\n');
}

function createOpenAIAnalyzer(config, logger) {
  if (!config || !isNonEmptyString(config.apiKey)) {
    throw new OpenAIClientError(
      'POLZA_API_KEY is required',
      500,
      'POLZA_MISSING_API_KEY'
    );
  }

  // Assumption/TODO:
  // Current implementation expects Polza to be OpenAI-compatible for /chat/completions
  // and response_format=json_schema. If Polza contract differs, adjust this request shape here.
  const client = new OpenAI({
    apiKey: config.apiKey.trim(),
    baseURL: isNonEmptyString(config.baseUrl) ? config.baseUrl.trim() : undefined,
    timeout: config.timeoutMs
  });

  const model = isNonEmptyString(config.model) ? config.model.trim() : 'gpt-4.1-mini';

  return async function analyzeCall(payload) {
    let completion;

    try {
      completion = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'call_analysis_gateway',
            strict: true,
            schema: ANALYSIS_SCHEMA
          }
        },
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT.trim()
          },
          {
            role: 'user',
            content: buildUserPrompt(payload)
          }
        ]
      });
    } catch (error) {
      throw new OpenAIClientError(
        sanitizePolzaErrorMessage(error),
        502,
        'POLZA_REQUEST_FAILED'
      );
    }

    const modelContent = completion?.choices?.[0]?.message?.content;
    if (!isNonEmptyString(modelContent)) {
      throw new OpenAIClientError(
        'Polza returned empty response content',
        502,
        'POLZA_EMPTY_RESPONSE'
      );
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(modelContent);
    } catch (error) {
      throw new OpenAIClientError(
        'Polza returned invalid JSON that cannot be parsed',
        502,
        'POLZA_INVALID_JSON_PARSE'
      );
    }

    const normalized = normalizeAndValidateAnalysis(parsedJson);

    logger.info('polza_analysis_success', {
      requestId: payload.requestId || '',
      category: normalized.category,
      priority: normalized.priority,
      tagsCount: normalized.tags.length
    });

    return normalized;
  };
}

module.exports = {
  createOpenAIAnalyzer,
  OpenAIClientError
};
