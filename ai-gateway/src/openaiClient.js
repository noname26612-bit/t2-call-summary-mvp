const crypto = require('crypto');
const fs = require('fs');
const OpenAI = require('openai');
const os = require('os');
const path = require('path');

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

const MAX_TRANSCRIBE_AUDIO_BYTES = 20 * 1024 * 1024;

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

function createPolzaClient(config) {
  if (!config || !isNonEmptyString(config.apiKey)) {
    throw new OpenAIClientError(
      'POLZA_API_KEY is required',
      500,
      'POLZA_MISSING_API_KEY'
    );
  }

  const client = new OpenAI({
    apiKey: config.apiKey.trim(),
    baseURL: isNonEmptyString(config.baseUrl) ? config.baseUrl.trim() : undefined,
    timeout: config.timeoutMs
  });

  return {
    client,
    analyzeModel: isNonEmptyString(config.model) ? config.model.trim() : 'gpt-4.1-mini',
    transcribeModel: isNonEmptyString(config.transcribeModel)
      ? config.transcribeModel.trim()
      : 'openai/gpt-4o-mini-transcribe',
    transcribeCandidateModel: isNonEmptyString(config.transcribeCandidateModel)
      ? config.transcribeCandidateModel.trim()
      : ''
  };
}

function normalizeTranscriptionText(raw) {
  if (!isNonEmptyString(raw)) {
    return '';
  }

  return raw.replace(/\s+/g, ' ').trim();
}

function decodeAudioBase64(rawAudioBase64) {
  if (!isNonEmptyString(rawAudioBase64)) {
    throw new OpenAIClientError(
      'audioBase64 is required and must be a non-empty string',
      400,
      'TRANSCRIBE_VALIDATION_FAILED'
    );
  }

  const withNoPrefix = rawAudioBase64.includes('base64,')
    ? rawAudioBase64.slice(rawAudioBase64.indexOf('base64,') + 'base64,'.length)
    : rawAudioBase64;

  const normalized = withNoPrefix.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    throw new OpenAIClientError(
      'audioBase64 contains invalid characters',
      400,
      'TRANSCRIBE_VALIDATION_FAILED'
    );
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer || buffer.length === 0) {
    throw new OpenAIClientError(
      'audioBase64 cannot be decoded to non-empty audio bytes',
      400,
      'TRANSCRIBE_VALIDATION_FAILED'
    );
  }

  if (buffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
    throw new OpenAIClientError(
      `Audio payload is too large (max ${MAX_TRANSCRIBE_AUDIO_BYTES} bytes)`,
      413,
      'TRANSCRIBE_AUDIO_TOO_LARGE'
    );
  }

  return buffer;
}

function resolveAudioBuffer(payload) {
  if (Buffer.isBuffer(payload?.audioBuffer)) {
    const buffer = payload.audioBuffer;

    if (buffer.length === 0) {
      throw new OpenAIClientError(
        'Uploaded audio file is empty',
        400,
        'TRANSCRIBE_VALIDATION_FAILED'
      );
    }

    if (buffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
      throw new OpenAIClientError(
        `Audio payload is too large (max ${MAX_TRANSCRIBE_AUDIO_BYTES} bytes)`,
        413,
        'TRANSCRIBE_AUDIO_TOO_LARGE'
      );
    }

    return buffer;
  }

  return decodeAudioBase64(payload?.audioBase64);
}

function resolveTranscriptionFileExtension({ fileName, mimeType }) {
  const fromName = isNonEmptyString(fileName) ? path.extname(fileName.trim()) : '';
  const allowed = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.mp4', '.mpeg']);

  if (allowed.has(fromName.toLowerCase())) {
    return fromName.toLowerCase();
  }

  const normalizedMime = isNonEmptyString(mimeType) ? mimeType.trim().toLowerCase() : '';
  if (normalizedMime.includes('wav')) {
    return '.wav';
  }

  if (normalizedMime.includes('ogg')) {
    return '.ogg';
  }

  if (normalizedMime.includes('webm')) {
    return '.webm';
  }

  if (normalizedMime.includes('mp4')) {
    return '.mp4';
  }

  if (normalizedMime.includes('mpeg') || normalizedMime.includes('mp3')) {
    return '.mp3';
  }

  return '.mp3';
}

function writeAudioBufferToTempFile(audioBuffer, extension) {
  const tempFilePath = path.join(
    os.tmpdir(),
    `ai-gateway-transcribe-${crypto.randomUUID()}${extension}`
  );

  fs.writeFileSync(tempFilePath, audioBuffer);
  return tempFilePath;
}

function safeRemoveFile(filePath) {
  if (!isNonEmptyString(filePath)) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    // non-critical cleanup failure
  }
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
  const { client, analyzeModel } = createPolzaClient(config);

  return async function analyzeCall(payload) {
    let completion;

    try {
      completion = await client.chat.completions.create({
        model: analyzeModel,
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

function createOpenAITranscriber(config, logger) {
  const { client, transcribeModel, transcribeCandidateModel } = createPolzaClient(config);

  function resolveTranscribeModel(requestedModelRaw) {
    const requested = isNonEmptyString(requestedModelRaw) ? requestedModelRaw.trim() : '';
    if (!requested) {
      return transcribeModel;
    }

    if (requested.toLowerCase() === 'candidate') {
      if (!isNonEmptyString(transcribeCandidateModel)) {
        throw new OpenAIClientError(
          'POLZA_TRANSCRIBE_MODEL_CANDIDATE is not configured',
          400,
          'TRANSCRIBE_CANDIDATE_MODEL_NOT_CONFIGURED'
        );
      }

      return transcribeCandidateModel;
    }

    return requested;
  }

  return async function transcribeAudio(payload) {
    const audioBuffer = resolveAudioBuffer(payload);
    const effectiveModel = resolveTranscribeModel(payload?.transcribeModel);
    const extension = resolveTranscriptionFileExtension({
      fileName: payload?.fileName || '',
      mimeType: payload?.mimeType || ''
    });
    const tempFilePath = writeAudioBufferToTempFile(audioBuffer, extension);

    let response;
    try {
      response = await client.audio.transcriptions.create({
        model: effectiveModel,
        file: fs.createReadStream(tempFilePath),
        response_format: 'text'
      });
    } catch (error) {
      throw new OpenAIClientError(
        sanitizePolzaErrorMessage(error),
        502,
        'POLZA_TRANSCRIBE_FAILED'
      );
    } finally {
      safeRemoveFile(tempFilePath);
    }

    const transcript = normalizeTranscriptionText(
      typeof response === 'string' ? response : response?.text
    );

    if (!isNonEmptyString(transcript)) {
      throw new OpenAIClientError(
        'Polza returned empty transcription',
        502,
        'POLZA_EMPTY_TRANSCRIPTION'
      );
    }

    logger.info('polza_transcription_success', {
      requestId: payload?.requestId || '',
      transcriptLength: transcript.length,
      model: effectiveModel,
      audioBytes: audioBuffer.length
    });

    return {
      transcript,
      model: effectiveModel,
      audioBytes: audioBuffer.length
    };
  };
}

module.exports = {
  createOpenAIAnalyzer,
  createOpenAITranscriber,
  OpenAIClientError
};
