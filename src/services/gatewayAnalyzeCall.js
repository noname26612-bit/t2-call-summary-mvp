const {
  AnalysisNormalizationError,
  normalizeAndValidateAnalysis
} = require('./analysisNormalizer');

class GatewayAnalyzeError extends Error {
  constructor(message, statusCode = 502, code = 'AI_GATEWAY_ANALYZE_FAILED', aiUsage = null) {
    super(message);
    this.name = 'GatewayAnalyzeError';
    this.statusCode = statusCode;
    this.code = code;
    if (aiUsage && typeof aiUsage === 'object') {
      this.aiUsage = aiUsage;
    }
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeOptionalString(value) {
  return isNonEmptyString(value) ? value.trim() : '';
}

function normalizeOptionalBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  if (isNonEmptyString(value)) {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'да'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'n', 'нет'].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function normalizeOptionalInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }

  if (isNonEmptyString(value) && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeGatewayPriorityToUrgency(rawPriority) {
  if (!isNonEmptyString(rawPriority)) {
    return '';
  }

  const normalized = rawPriority.trim().toLowerCase();
  if (normalized === 'high') {
    return 'высокая';
  }

  if (normalized === 'medium') {
    return 'средняя';
  }

  if (normalized === 'low') {
    return 'низкая';
  }

  return '';
}

function normalizeEmployeeHint(employee) {
  if (!employee || typeof employee !== 'object' || Array.isArray(employee)) {
    return null;
  }

  const phoneNormalized = normalizeOptionalString(employee.phoneNormalized);
  const employeeName = normalizeOptionalString(employee.employeeName);
  const employeeTitle = normalizeOptionalString(employee.employeeTitle);

  if (!phoneNormalized && !employeeName && !employeeTitle) {
    return null;
  }
  const normalized = {};
  if (phoneNormalized) {
    normalized.phoneNormalized = phoneNormalized;
  }
  if (employeeName) {
    normalized.employeeName = employeeName;
  }
  if (employeeTitle) {
    normalized.employeeTitle = employeeTitle;
  }
  return normalized;
}

function normalizeAnalyzeBypassHint(rawHint) {
  if (!rawHint || typeof rawHint !== 'object' || Array.isArray(rawHint)) {
    return null;
  }

  const reason = normalizeOptionalString(rawHint.reason).slice(0, 200);
  const signalType = normalizeOptionalString(rawHint.signalType).slice(0, 80);
  const transcriptLength = normalizeOptionalInteger(rawHint.transcriptLength);
  const wordsCount = normalizeOptionalInteger(rawHint.wordsCount);
  const meaningfulWordsCount = normalizeOptionalInteger(rawHint.meaningfulWordsCount);
  const minTranscriptChars = normalizeOptionalInteger(rawHint.minTranscriptChars);

  const normalized = {};

  if (reason) {
    normalized.reason = reason;
  }
  if (signalType) {
    normalized.signalType = signalType;
  }
  if (transcriptLength !== null) {
    normalized.transcriptLength = transcriptLength;
  }
  if (wordsCount !== null) {
    normalized.wordsCount = wordsCount;
  }
  if (meaningfulWordsCount !== null) {
    normalized.meaningfulWordsCount = meaningfulWordsCount;
  }
  if (minTranscriptChars !== null) {
    normalized.minTranscriptChars = minTranscriptChars;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeAiUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) {
    return null;
  }

  const normalized = {};

  const xRequestId = normalizeOptionalString(rawUsage.xRequestId);
  if (xRequestId) {
    normalized.xRequestId = xRequestId;
  }

  const callEventIdRaw = rawUsage.callEventId;
  if (Number.isSafeInteger(callEventIdRaw) && callEventIdRaw > 0) {
    normalized.callEventId = callEventIdRaw;
  } else if (isNonEmptyString(callEventIdRaw) && /^[0-9]+$/.test(callEventIdRaw.trim())) {
    const parsed = Number.parseInt(callEventIdRaw.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      normalized.callEventId = parsed;
    }
  }

  const callId = normalizeOptionalString(rawUsage.callId);
  if (callId) {
    normalized.callId = callId.slice(0, 256);
  }

  const operation = normalizeOptionalString(rawUsage.operation);
  if (operation) {
    normalized.operation = operation;
  }

  const model = normalizeOptionalString(rawUsage.model);
  if (model) {
    normalized.model = model;
  }

  const provider = normalizeOptionalString(rawUsage.provider);
  if (provider) {
    normalized.provider = provider;
  }

  const responseStatus = normalizeOptionalString(rawUsage.responseStatus);
  if (responseStatus) {
    normalized.responseStatus = responseStatus;
  }

  const skipReason = normalizeOptionalString(rawUsage.skipReason);
  if (skipReason) {
    normalized.skipReason = skipReason;
  }

  const createdAt = normalizeOptionalString(rawUsage.createdAt);
  if (createdAt) {
    normalized.createdAt = createdAt;
  }

  const numericFields = [
    ['promptTokens', rawUsage.promptTokens],
    ['completionTokens', rawUsage.completionTokens],
    ['totalTokens', rawUsage.totalTokens],
    ['transcriptCharsRaw', rawUsage.transcriptCharsRaw],
    ['transcriptCharsSent', rawUsage.transcriptCharsSent],
    ['durationMs', rawUsage.durationMs]
  ];

  for (const [field, value] of numericFields) {
    if (Number.isSafeInteger(value) && value >= 0) {
      normalized[field] = value;
      continue;
    }

    if (isNonEmptyString(value) && /^[0-9]+$/.test(value.trim())) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        normalized[field] = parsed;
      }
    }
  }

  if (typeof rawUsage.estimatedCostRub === 'number' && Number.isFinite(rawUsage.estimatedCostRub)) {
    normalized.estimatedCostRub = Number(rawUsage.estimatedCostRub.toFixed(6));
  } else if (
    isNonEmptyString(rawUsage.estimatedCostRub) &&
    /^[0-9]+([.,][0-9]+)?$/.test(rawUsage.estimatedCostRub.trim())
  ) {
    const parsed = Number.parseFloat(rawUsage.estimatedCostRub.trim().replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      normalized.estimatedCostRub = Number(parsed.toFixed(6));
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function resolveAnalyzeUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Unsupported URL protocol');
    }

    const normalizedBasePath = parsed.pathname.endsWith('/')
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;

    parsed.pathname = `${normalizedBasePath}/analyze`.replace(/\/{2,}/g, '/');
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString();
  } catch (error) {
    throw new GatewayAnalyzeError(
      'Server configuration error: AI_GATEWAY_URL must be a valid http(s) URL',
      500,
      'AI_GATEWAY_INVALID_URL'
    );
  }
}

async function safeReadJson(response) {
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    return null;
  }

  if (!isNonEmptyString(text)) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function normalizeGatewayAnalysisPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GatewayAnalyzeError(
      'AI gateway returned invalid JSON payload',
      502,
      'AI_GATEWAY_INVALID_JSON'
    );
  }

  const mapped = {
    ...payload
  };

  if (!Object.prototype.hasOwnProperty.call(mapped, 'result') && isNonEmptyString(payload.outcome)) {
    mapped.result = payload.outcome.trim();
  }

  if (!Object.prototype.hasOwnProperty.call(mapped, 'scenario') && isNonEmptyString(payload.primaryScenario)) {
    mapped.scenario = payload.primaryScenario.trim();
  }

  if (!Object.prototype.hasOwnProperty.call(mapped, 'callEssence') && isNonEmptyString(payload.summary)) {
    mapped.callEssence = payload.summary.trim();
  }

  if (!Object.prototype.hasOwnProperty.call(mapped, 'whatDiscussed') && isNonEmptyString(payload.result)) {
    mapped.whatDiscussed = payload.result.trim();
  }

  if (!Object.prototype.hasOwnProperty.call(mapped, 'importantNote') && Array.isArray(payload.analysisWarnings)) {
    const firstWarning = payload.analysisWarnings.find((item) => isNonEmptyString(item));
    if (firstWarning) {
      mapped.importantNote = firstWarning.trim();
    }
  }

  if (!Object.prototype.hasOwnProperty.call(mapped, 'urgency') && isNonEmptyString(payload.priority)) {
    mapped.urgency = normalizeGatewayPriorityToUrgency(payload.priority);
  }

  if (!Object.prototype.hasOwnProperty.call(mapped, 'confidence')) {
    mapped.confidence = 0.5;
  }

  return mapped;
}

function buildGatewayErrorFromHttpStatus(status, payload) {
  const gatewayMessage = isNonEmptyString(payload?.error)
    ? payload.error.trim()
    : 'Unexpected AI gateway response';

  if (status === 400) {
    return new GatewayAnalyzeError(
      `AI gateway rejected request: ${gatewayMessage}`,
      400,
      'AI_GATEWAY_BAD_REQUEST',
      normalizeAiUsage(payload?.aiUsage)
    );
  }

  if (status === 401) {
    return new GatewayAnalyzeError(
      'AI gateway unauthorized: shared secret mismatch',
      401,
      'AI_GATEWAY_UNAUTHORIZED',
      normalizeAiUsage(payload?.aiUsage)
    );
  }

  if (status >= 500) {
    return new GatewayAnalyzeError(
      `AI gateway upstream error (${status})`,
      502,
      'AI_GATEWAY_UPSTREAM_ERROR',
      normalizeAiUsage(payload?.aiUsage)
    );
  }

  return new GatewayAnalyzeError(
    `AI gateway request failed with status ${status}: ${gatewayMessage}`,
    502,
    'AI_GATEWAY_REQUEST_FAILED',
    normalizeAiUsage(payload?.aiUsage)
  );
}

function createGatewayAnalyzeCall(config) {
  if (!config || !isNonEmptyString(config.url)) {
    throw new GatewayAnalyzeError(
      'Server configuration error: AI_GATEWAY_URL is required',
      500,
      'AI_GATEWAY_MISSING_URL'
    );
  }

  if (!isNonEmptyString(config.sharedSecret)) {
    throw new GatewayAnalyzeError(
      'Server configuration error: AI_GATEWAY_SHARED_SECRET is required',
      500,
      'AI_GATEWAY_MISSING_SHARED_SECRET'
    );
  }

  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new GatewayAnalyzeError(
      'Server configuration error: AI_GATEWAY_TIMEOUT_MS must be a positive integer',
      500,
      'AI_GATEWAY_INVALID_TIMEOUT'
    );
  }

  const analyzeUrl = resolveAnalyzeUrl(config.url.trim());
  const sharedSecret = config.sharedSecret.trim();
  const timeoutMs = config.timeoutMs;

  return async function gatewayAnalyzeCall(payload) {
    const transcript = normalizeOptionalString(payload?.transcript);
    if (!transcript) {
      throw new GatewayAnalyzeError(
        'Call analysis input error: transcript is required',
        400,
        'AI_GATEWAY_EMPTY_TRANSCRIPT'
      );
    }

    const requestPayload = {
      requestId: normalizeOptionalString(payload?.requestId),
      callEventId: Number.isSafeInteger(payload?.callEventId) ? payload.callEventId : null,
      callId: normalizeOptionalString(payload?.callId),
      phone: normalizeOptionalString(payload?.phone),
      callDateTime: normalizeOptionalString(payload?.callDateTime),
      transcript,
      callType: normalizeOptionalString(payload?.callType),
      callerNumber: normalizeOptionalString(payload?.callerNumber),
      calleeNumber: normalizeOptionalString(payload?.calleeNumber),
      destinationNumber: normalizeOptionalString(payload?.destinationNumber),
      durationSec: normalizeOptionalInteger(payload?.durationSec),
      answered: normalizeOptionalBoolean(payload?.answered),
      noAnswer: normalizeOptionalBoolean(payload?.noAnswer),
      employeePhone: normalizeOptionalString(payload?.employeePhone),
      clientPhone: normalizeOptionalString(payload?.clientPhone),
      transcriptLength: normalizeOptionalInteger(payload?.transcriptLength),
      shortCall: normalizeOptionalBoolean(payload?.shortCall),
      callDirectionContext: normalizeOptionalString(payload?.callDirectionContext),
      whoCalledWhom: normalizeOptionalString(payload?.whoCalledWhom)
    };

    const employeeHint = normalizeEmployeeHint(payload?.employee);
    if (employeeHint) {
      requestPayload.employee = employeeHint;
    }

    const analyzeBypassHint = normalizeAnalyzeBypassHint(payload?.analyzeBypassHint);
    if (analyzeBypassHint) {
      requestPayload.analyzeBypassHint = analyzeBypassHint;
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    let response;

    try {
      response = await fetch(analyzeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gateway-secret': sharedSecret,
          ...(requestPayload.requestId ? { 'x-request-id': requestPayload.requestId } : {})
        },
        signal: abortController.signal,
        body: JSON.stringify(requestPayload)
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new GatewayAnalyzeError(
          `AI gateway timeout after ${timeoutMs} ms`,
          502,
          'AI_GATEWAY_TIMEOUT'
        );
      }

      throw new GatewayAnalyzeError(
        `AI gateway network error: ${error.message}`,
        502,
        'AI_GATEWAY_NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const responsePayload = await safeReadJson(response);

    if (!response.ok) {
      throw buildGatewayErrorFromHttpStatus(response.status, responsePayload);
    }

    const normalizedGatewayPayload = normalizeGatewayAnalysisPayload(responsePayload);
    const aiUsage = normalizeAiUsage(responsePayload?.aiUsage);

    try {
      const normalized = normalizeAndValidateAnalysis(normalizedGatewayPayload, { transcript });
      if (aiUsage) {
        normalized.aiUsage = aiUsage;
      }

      return normalized;
    } catch (error) {
      if (error instanceof AnalysisNormalizationError) {
        const normalizedCode = isNonEmptyString(error.code)
          ? error.code.trim()
          : 'ANALYSIS_NORMALIZATION_FAILED';

        throw new GatewayAnalyzeError(
          `AI gateway returned invalid analysis payload: ${error.message}`,
          502,
          `AI_GATEWAY_${normalizedCode}`
        );
      }

      throw error;
    }
  };
}

module.exports = {
  createGatewayAnalyzeCall,
  GatewayAnalyzeError
};
