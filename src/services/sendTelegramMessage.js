const { formatTelegramCallSummary } = require('./telegramMessageFormatter');
const DEFAULT_TELEGRAM_API_TIMEOUT_MS = 10000;

class TelegramConfigurationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TelegramConfigurationError';
    this.statusCode = 500;
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseTelegramApiTimeoutMs(envValue) {
  if (envValue === undefined) {
    return DEFAULT_TELEGRAM_API_TIMEOUT_MS;
  }

  if (typeof envValue !== 'string') {
    throw new TelegramConfigurationError(
      'Server configuration error: TELEGRAM_API_TIMEOUT_MS must be a positive integer',
      'TELEGRAM_INVALID_TIMEOUT'
    );
  }

  const trimmedValue = envValue.trim();
  if (!/^[0-9]+$/.test(trimmedValue)) {
    throw new TelegramConfigurationError(
      'Server configuration error: TELEGRAM_API_TIMEOUT_MS must be a positive integer',
      'TELEGRAM_INVALID_TIMEOUT'
    );
  }

  const timeoutMs = Number.parseInt(trimmedValue, 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TelegramConfigurationError(
      'Server configuration error: TELEGRAM_API_TIMEOUT_MS must be a positive integer',
      'TELEGRAM_INVALID_TIMEOUT'
    );
  }

  return timeoutMs;
}

async function sendTelegramMessage({ phone, callDateTime, analysis }) {
  const timeoutMs = parseTelegramApiTimeoutMs(process.env.TELEGRAM_API_TIMEOUT_MS);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!isNonEmptyString(botToken) || !isNonEmptyString(chatId)) {
    console.error('Telegram configuration error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
    return { status: 'failed' };
  }

  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  const text = formatTelegramCallSummary({ phone, callDateTime, analysis });
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: abortController.signal,
      body: JSON.stringify({
        chat_id: chatId.trim(),
        text
      })
    });

    let responseJson = null;
    try {
      responseJson = await response.json();
    } catch (error) {
      responseJson = null;
    }

    if (!response.ok || responseJson?.ok !== true) {
      const description = isNonEmptyString(responseJson?.description)
        ? responseJson.description
        : 'Telegram returned an unexpected response';
      throw new Error(`HTTP ${response.status}: ${description}`);
    }

    return { status: 'sent' };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      console.error(`Telegram send timeout: request exceeded ${timeoutMs} ms`);
      return { status: 'failed' };
    }

    console.error(`Telegram send failed: ${error.message}`);
    return { status: 'failed' };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  sendTelegramMessage
};
