function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function getT2Config() {
  const rawTimeout = process.env.T2_API_TIMEOUT_MS;
  let timeoutMs = 10000;

  if (isNonEmptyString(rawTimeout)) {
    const parsed = Number.parseInt(rawTimeout, 10);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('T2_API_TIMEOUT_MS must be a positive integer');
    }

    timeoutMs = parsed;
  }

  return {
    baseUrl: process.env.T2_API_BASE_URL,
    token: process.env.T2_API_TOKEN,
    timeoutMs
  };
}

function validateT2Config() {
  const config = getT2Config();
  const errors = [];

  if (!isNonEmptyString(config.baseUrl)) {
    errors.push('T2_API_BASE_URL is required and must be a non-empty string');
  }

  if (!isNonEmptyString(config.token)) {
    errors.push('T2_API_TOKEN is required and must be a non-empty string');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid T2 configuration: ${errors.join('; ')}`);
  }

  return config;
}

function buildT2Headers() {
  const config = validateT2Config();

  return {
    Authorization: `Bearer ${config.token.trim()}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

function buildT2Url(pathname) {
  if (!isNonEmptyString(pathname)) {
    throw new Error('pathname is required and must be a non-empty string');
  }

  const config = validateT2Config();
  const base = config.baseUrl.trim().endsWith('/')
    ? config.baseUrl.trim()
    : `${config.baseUrl.trim()}/`;
  const normalizedPath = pathname.trim().startsWith('/')
    ? pathname.trim().slice(1)
    : pathname.trim();

  return new URL(normalizedPath, base).toString();
}

async function fetchT2Json({ pathname, method = 'GET', body } = {}) {
  const config = validateT2Config();
  const url = buildT2Url(pathname);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: buildT2Headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`T2 API response is not JSON (status ${response.status})`);
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`Failed to parse T2 API JSON response (status ${response.status})`);
    }

    if (!response.ok) {
      const requestError = new Error(`T2 API request failed with status ${response.status}`);
      requestError.statusCode = response.status;
      requestError.code = 'T2_HTTP_ERROR';
      requestError.responseBody = data;
      throw requestError;
    }

    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(`T2 API request timed out after ${config.timeoutMs} ms`);
      timeoutError.code = 'T2_TIMEOUT';
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  getT2Config,
  validateT2Config,
  buildT2Headers,
  buildT2Url,
  fetchT2Json
};
