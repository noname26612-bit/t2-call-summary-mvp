const { formatTelegramCallSummary } = require('./telegramMessageFormatter');

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

function createTelegramSender(config, logger) {
  if (!config || !isNonEmptyString(config.botToken) || !isNonEmptyString(config.chatId)) {
    throw new TelegramConfigurationError(
      'Server configuration error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required',
      'TELEGRAM_MISSING_CONFIG'
    );
  }

  if (!Number.isSafeInteger(config.apiTimeoutMs) || config.apiTimeoutMs <= 0) {
    throw new TelegramConfigurationError(
      'Server configuration error: TELEGRAM_API_TIMEOUT_MS must be a positive integer',
      'TELEGRAM_INVALID_TIMEOUT'
    );
  }

  const botToken = config.botToken.trim();
  const chatId = config.chatId.trim();
  const timeoutMs = config.apiTimeoutMs;
  const timeZone = isNonEmptyString(config.timeZone) ? config.timeZone.trim() : 'Europe/Moscow';

  return async function sendTelegramMessage({ phone, callDateTime, analysis }) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const text = formatTelegramCallSummary({
      phone,
      callDateTime,
      analysis,
      timeZone
    });

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
          chat_id: chatId,
          text
        })
      });

      let responseJson = null;
      try {
        responseJson = await response.json();
      } catch (parseError) {
        responseJson = null;
      }

      if (!response.ok || responseJson?.ok !== true) {
        const description = isNonEmptyString(responseJson?.description)
          ? responseJson.description
          : 'Telegram returned an unexpected response';

        logger.warn('telegram_send_failed', {
          httpStatus: response.status,
          description
        });

        return {
          status: 'failed',
          httpStatus: response.status,
          errorCode: 'TELEGRAM_API_ERROR',
          errorMessage: description,
          responsePayload: responseJson
        };
      }

      return {
        status: 'sent',
        httpStatus: response.status,
        responsePayload: responseJson
      };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        logger.warn('telegram_send_timeout', {
          timeoutMs
        });

        return {
          status: 'failed',
          errorCode: 'TELEGRAM_TIMEOUT',
          errorMessage: `Telegram send timeout after ${timeoutMs} ms`,
          responsePayload: null
        };
      }

      logger.warn('telegram_send_error', {
        error
      });

      return {
        status: 'failed',
        errorCode: 'TELEGRAM_REQUEST_FAILED',
        errorMessage: error.message,
        responsePayload: null
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

module.exports = {
  createTelegramSender,
  TelegramConfigurationError
};
