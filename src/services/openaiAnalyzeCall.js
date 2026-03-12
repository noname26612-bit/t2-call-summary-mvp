const OpenAI = require('openai');
const {
  ANALYSIS_CATEGORIES,
  ANALYSIS_URGENCY,
  TEXT_LIMITS,
  REQUIRED_FIELDS,
  AnalysisNormalizationError,
  normalizeAndValidateAnalysis
} = require('./analysisNormalizer');

const SYSTEM_PROMPT = `
Ты анализатор телефонных разговоров.
Верни только JSON-объект и ничего больше.
Нельзя использовать markdown, комментарии и пояснения.

Требования к полям analysis:
- category: одно значение из [продажа, сервис, запчасти, аренда, спам, прочее]
- topic: непустая строка, максимум 80 символов после trim
- summary: непустая строка, максимум 220 символов после trim
- result: непустая строка, максимум 160 символов после trim
- nextStep: непустая строка, максимум 160 символов после trim
- urgency: одно значение из [низкая, средняя, высокая]
- tags: массив строк от 1 до 5 элементов, без дублей, каждый тег непустой после trim
- confidence: число от 0 до 1

Если данных мало, используй category="прочее" и нейтральные формулировки.
Если по смыслу это ремонт/доставка/обслуживание, используй category="сервис".
Если по смыслу это покупка оборудования, используй category="продажа".
`;

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: REQUIRED_FIELDS,
  properties: {
    category: {
      type: 'string',
      enum: ANALYSIS_CATEGORIES
    },
    topic: {
      type: 'string',
      minLength: 1,
      maxLength: TEXT_LIMITS.topic
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: TEXT_LIMITS.summary
    },
    result: {
      type: 'string',
      minLength: 1,
      maxLength: TEXT_LIMITS.result
    },
    nextStep: {
      type: 'string',
      minLength: 1,
      maxLength: TEXT_LIMITS.nextStep
    },
    urgency: {
      type: 'string',
      enum: ANALYSIS_URGENCY
    },
    tags: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'string',
        minLength: 1
      }
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1
    }
  }
};

class OpenAIAnalyzeError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'OpenAIAnalyzeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function createOpenAIAnalyzeCall(config) {
  if (!config || !isNonEmptyString(config.apiKey)) {
    throw new OpenAIAnalyzeError(
      'Server configuration error: OPENAI_API_KEY is required for call analysis',
      500,
      'OPENAI_MISSING_API_KEY'
    );
  }

  const client = new OpenAI({ apiKey: config.apiKey.trim() });
  const model = isNonEmptyString(config.model) ? config.model.trim() : 'gpt-4.1-mini';

  return async function openaiAnalyzeCall(transcript) {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'call_analysis',
            strict: true,
            schema: ANALYSIS_RESPONSE_SCHEMA
          }
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT.trim() },
          {
            role: 'user',
            content: `Транскрипт звонка:\n${transcript}`
          }
        ]
      });
    } catch (error) {
      throw new OpenAIAnalyzeError(
        `OpenAI request failed: ${error.message}`,
        502,
        'OPENAI_REQUEST_FAILED'
      );
    }

    const modelContent = completion.choices?.[0]?.message?.content;
    if (!isNonEmptyString(modelContent)) {
      throw new OpenAIAnalyzeError(
        'OpenAI returned invalid JSON: empty response content',
        502,
        'OPENAI_EMPTY_RESPONSE'
      );
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(modelContent);
    } catch (error) {
      throw new OpenAIAnalyzeError(
        'OpenAI returned invalid JSON that cannot be parsed',
        502,
        'OPENAI_INVALID_JSON_PARSE'
      );
    }

    try {
      return normalizeAndValidateAnalysis(parsedJson, { transcript });
    } catch (error) {
      if (error instanceof AnalysisNormalizationError) {
        const normalizedCode = typeof error.code === 'string' && error.code.trim() !== ''
          ? error.code.trim()
          : 'ANALYSIS_NORMALIZATION_FAILED';

        throw new OpenAIAnalyzeError(
          `OpenAI returned invalid analysis payload: ${error.message}`,
          502,
          `OPENAI_${normalizedCode}`
        );
      }

      throw error;
    }
  };
}

module.exports = {
  createOpenAIAnalyzeCall,
  OpenAIAnalyzeError
};
