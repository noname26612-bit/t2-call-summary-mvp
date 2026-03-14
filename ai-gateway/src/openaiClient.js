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
const PRIMARY_SCENARIOS = Object.freeze(['Запчасти', 'Аренда', 'Ремонт', 'Доставка', 'Другое']);
const REPAIR_TYPES = Object.freeze(['капитальный', 'выездной']);

const MAX_TEXT_LENGTH = Object.freeze({
  topic: 80,
  summary: 220,
  outcome: 180,
  nextStep: 180,
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

const MAX_TRANSCRIBE_AUDIO_BYTES = 20 * 1024 * 1024;

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'category',
    'topic',
    'summary',
    'outcome',
    'nextStep',
    'priority',
    'tags',
    'primaryScenario',
    'wantedSummary'
  ],
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
    },
    primaryScenario: {
      type: 'string',
      enum: PRIMARY_SCENARIOS
    },
    wantedSummary: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.wantedSummary
    },
    partsRequested: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TEXT_LENGTH.partsItem
      }
    },
    rentalStart: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.rentalStart
    },
    rentalDuration: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.rentalDuration
    },
    rentalAddress: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.rentalAddress
    },
    repairEquipment: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.repairEquipment
    },
    repairDateOrTerm: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.repairDateOrTerm
    },
    repairType: {
      type: 'string',
      enum: REPAIR_TYPES
    },
    repairAddress: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.repairAddress
    },
    deliveryDetails: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.deliveryDetails
    },
    companyName: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.companyName
    },
    orderNumber: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH.orderNumber
    }
  }
};

const SYSTEM_PROMPT = `
Ты анализатор телефонных разговоров.
Верни строго JSON-объект без markdown и без пояснений.

Поле category: одно значение из [продажа, сервис, запчасти, аренда, спам, прочее].
Поле priority: одно значение из [low, medium, high].
Поле tags: массив строк от 1 до 5 тегов без дублей.
Поле primaryScenario: одно значение из [Запчасти, Аренда, Ремонт, Доставка, Другое].
Поле wantedSummary: 2-4 короткие строки по сути запроса без воды.

Правила по сценариям:
- один звонок = один primaryScenario
- всё, что не входит в primaryScenario, оставляй в wantedSummary
- Запчасти: используй partsRequested (список, без дублей, не выдумывать)
- Аренда: используй rentalStart / rentalDuration / rentalAddress по фактам из звонка
- Ремонт: используй repairEquipment / repairDateOrTerm / repairType / repairAddress
- Доставка: используй deliveryDetails только если есть конкретика; не пиши шаблон "Уточнение по доставке: Вопросы по доставке"
- companyName и orderNumber заполняй только если эти данные явно и дословно прозвучали в разговоре
- если явного упоминания нет, не заполняй эти поля

Правила по датам:
- если дата точная, передавай точную дату
- если время относительное и точное (например "через 3 дня"), считай от callDateTime
- если срок неточный (например "через 2-3 недели"), не придумывай точную дату, оставляй текстом (например "примерно через 2-3 недели")

Если данных мало, ставь:
- category: "прочее"
- priority: "low"
- primaryScenario: "Другое"
- нейтральные формулировки в summary/outcome/nextStep/wantedSummary.
`;

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

function normalizeUniqueItems(rawValues, { maxLength, maxItems }) {
  if (!Array.isArray(rawValues)) {
    return [];
  }

  const normalizedItems = [];
  const seen = new Set();

  for (const rawValue of rawValues) {
    const normalized = normalizeOptionalText(rawValue, maxLength);
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

function inferPrimaryScenarioFromText(text) {
  if (!text) {
    return '';
  }

  if (text.includes('запчаст') || text.includes('подшип') || text.includes('ролик')) {
    return 'Запчасти';
  }

  if (text.includes('аренд') || text.includes('прокат')) {
    return 'Аренда';
  }

  if (text.includes('доставк') || text.includes('логист') || text.includes('самовывоз') || text.includes('отгруз')) {
    return 'Доставка';
  }

  if (text.includes('ремонт') || text.includes('сервис') || text.includes('неисправ') || text.includes('диагност')) {
    return 'Ремонт';
  }

  return '';
}

function normalizePrimaryScenario(rawPrimaryScenario, category, contextText) {
  if (isNonEmptyString(rawPrimaryScenario)) {
    const token = normalizeWhitespace(rawPrimaryScenario).toLowerCase().replace(/[\s-]+/g, '_');
    const aliasValue = PRIMARY_SCENARIO_ALIASES[token];
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
  const rawLines = stringFromUnknown(rawWantedSummary)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => normalizeOptionalText(line, MAX_TEXT_LENGTH.wantedSummary))
    .filter((line) => line !== '');

  const fallbackLines = fallbackCandidates
    .map((line) => normalizeOptionalText(line, MAX_TEXT_LENGTH.summary))
    .filter((line) => line !== '');

  const merged = [...rawLines];
  if (rawLines.length < 2) {
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
    return clampMultilineText(`${deduped[0]}\nКлючевые детали уточняются.`, MAX_TEXT_LENGTH.wantedSummary);
  }

  return clampMultilineText(deduped.join('\n'), MAX_TEXT_LENGTH.wantedSummary);
}

function normalizeRepairType(rawRepairType) {
  if (!isNonEmptyString(rawRepairType)) {
    return '';
  }

  const token = normalizeWhitespace(rawRepairType).toLowerCase().replace(/[\s-]+/g, '_');
  if (['выездной', 'выезд', 'on_site', 'onsite'].includes(token)) {
    return 'выездной';
  }

  if (['капитальный', 'цех', 'в_цеху', 'стационарный'].includes(token)) {
    return 'капитальный';
  }

  return '';
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

  const normalizedCategory = normalizeEnum(raw.category, ANALYSIS_CATEGORIES, 'прочее');
  const normalizedTopic = normalizeText(raw.topic, MAX_TEXT_LENGTH.topic) || 'Общий запрос клиента';
  const normalizedSummary = normalizeText(raw.summary, MAX_TEXT_LENGTH.summary) || 'Запрос клиента зафиксирован.';
  const normalizedOutcome = normalizeText(raw.outcome, MAX_TEXT_LENGTH.outcome) || 'Требуется уточнение деталей.';
  const normalizedNextStep = normalizeText(raw.nextStep, MAX_TEXT_LENGTH.nextStep) || 'Связаться с клиентом для уточнения деталей.';
  const normalizedPriority = normalizeEnum(raw.priority, ANALYSIS_PRIORITIES, 'low');
  const normalizedTags = normalizeTags(raw.tags);
  const contextText = [
    normalizedTopic,
    normalizedSummary,
    normalizedOutcome,
    normalizedNextStep,
    normalizeText(raw.wantedSummary, MAX_TEXT_LENGTH.wantedSummary),
    normalizeText(raw.primaryScenario, 32),
    normalizeText(raw.deliveryDetails, MAX_TEXT_LENGTH.deliveryDetails)
  ]
    .join(' ')
    .toLowerCase();

  const partsRequested = normalizeUniqueItems(raw.partsRequested, {
    maxLength: MAX_TEXT_LENGTH.partsItem,
    maxItems: 10
  });
  const repairType = normalizeRepairType(raw.repairType);

  const normalized = {
    category: normalizedCategory,
    topic: normalizedTopic,
    summary: normalizedSummary,
    outcome: normalizedOutcome,
    nextStep: normalizedNextStep,
    priority: normalizedPriority,
    tags: normalizedTags,
    primaryScenario: normalizePrimaryScenario(raw.primaryScenario, normalizedCategory, contextText),
    wantedSummary: normalizeWantedSummary(raw.wantedSummary, [
      normalizedSummary,
      normalizedOutcome
    ])
  };

  if (partsRequested.length > 0) {
    normalized.partsRequested = partsRequested;
  }

  const rentalStart = normalizeOptionalText(raw.rentalStart, MAX_TEXT_LENGTH.rentalStart);
  if (rentalStart) {
    normalized.rentalStart = rentalStart;
  }

  const rentalDuration = normalizeOptionalText(raw.rentalDuration, MAX_TEXT_LENGTH.rentalDuration);
  if (rentalDuration) {
    normalized.rentalDuration = rentalDuration;
  }

  const rentalAddress = normalizeOptionalText(raw.rentalAddress, MAX_TEXT_LENGTH.rentalAddress);
  if (rentalAddress) {
    normalized.rentalAddress = rentalAddress;
  }

  const repairEquipment = normalizeOptionalText(raw.repairEquipment, MAX_TEXT_LENGTH.repairEquipment);
  if (repairEquipment) {
    normalized.repairEquipment = repairEquipment;
  }

  const repairDateOrTerm = normalizeOptionalText(raw.repairDateOrTerm, MAX_TEXT_LENGTH.repairDateOrTerm);
  if (repairDateOrTerm) {
    normalized.repairDateOrTerm = repairDateOrTerm;
  }

  if (repairType) {
    normalized.repairType = repairType;
  }

  const repairAddress = normalizeOptionalText(raw.repairAddress, MAX_TEXT_LENGTH.repairAddress);
  if (repairAddress) {
    normalized.repairAddress = repairAddress;
  }

  const deliveryDetails = normalizeOptionalText(raw.deliveryDetails, MAX_TEXT_LENGTH.deliveryDetails);
  if (deliveryDetails) {
    normalized.deliveryDetails = deliveryDetails;
  }

  const companyName = normalizeOptionalText(raw.companyName, MAX_TEXT_LENGTH.companyName);
  if (companyName) {
    normalized.companyName = companyName;
  }

  const orderNumber = normalizeOptionalText(raw.orderNumber, MAX_TEXT_LENGTH.orderNumber);
  if (orderNumber) {
    normalized.orderNumber = orderNumber;
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
