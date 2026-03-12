const {
  AnalysisNormalizationError,
  normalizeAndValidateAnalysis
} = require('./analysisNormalizer');

class GatewayAnalyzeError extends Error {
  constructor(message, statusCode = 502, code = 'AI_GATEWAY_ANALYZE_FAILED') {
    super(message);
    this.name = 'GatewayAnalyzeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeOptionalString(value) {
  return isNonEmptyString(value) ? value.trim() : '';
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
      'AI_GATEWAY_BAD_REQUEST'
    );
  }

  if (status === 401) {
    return new GatewayAnalyzeError(
      'AI gateway unauthorized: shared secret mismatch',
      401,
      'AI_GATEWAY_UNAUTHORIZED'
    );
  }

  if (status >= 500) {
    return new GatewayAnalyzeError(
      `AI gateway upstream error (${status})`,
      502,
      'AI_GATEWAY_UPSTREAM_ERROR'
    );
  }

  return new GatewayAnalyzeError(
    `AI gateway request failed with status ${status}: ${gatewayMessage}`,
    502,
    'AI_GATEWAY_REQUEST_FAILED'
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
      phone: normalizeOptionalString(payload?.phone),
      callDateTime: normalizeOptionalString(payload?.callDateTime),
      transcript
    };

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
          'x-gateway-secret': sharedSecret
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

    try {
      return normalizeAndValidateAnalysis(normalizedGatewayPayload, { transcript });
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
