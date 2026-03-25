const { formatTelegramCallSummary } = require('./telegramMessageFormatter');
const { normalizePhone } = require('../utils/ignoredPhones');
const { resolveEmployeePhoneFromCallMeta } = require('../utils/callParticipants');

const TRANSCRIPT_CALLBACK_PREFIX = 'transcript:';
const TRANSCRIPT_BUTTON_LABEL = 'Транскрипт (.txt)';
const KNOWN_CALL_TYPES = new Set(['INCOMING', 'INBOUND', 'OUTGOING', 'OUTBOUND', 'SINGLE_CHANNEL']);

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

function normalizeChatId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }

  if (!isNonEmptyString(value)) {
    return '';
  }

  const normalized = value.trim();
  if (!/^-?[0-9]+$/.test(normalized)) {
    return '';
  }

  return normalized;
}

function normalizeCallEventId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  if (!isNonEmptyString(value)) {
    return '';
  }

  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) {
    return '';
  }

  return normalized;
}

function normalizePositiveInteger(value, fallback = null) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeCallTypeForWarning(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value.trim().toUpperCase();
}

function normalizeChatIdList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();

  for (const value of values) {
    const chatId = normalizeChatId(value);
    if (!chatId || seen.has(chatId)) {
      continue;
    }

    seen.add(chatId);
    normalized.push(chatId);
  }

  return normalized;
}

function parseRouteRuleChatIdList(rawValue) {
  if (Array.isArray(rawValue)) {
    return normalizeChatIdList(rawValue);
  }

  if (typeof rawValue === 'number' || isNonEmptyString(rawValue)) {
    const values = String(rawValue)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return normalizeChatIdList(values);
  }

  return [];
}

function buildNumberRouteChatIdsMap(rawRules = []) {
  const map = new Map();

  if (!Array.isArray(rawRules)) {
    return map;
  }

  for (const rule of rawRules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      continue;
    }

    const phoneNormalized = normalizePhone(rule.phone);
    if (!phoneNormalized) {
      continue;
    }

    const chatIds = parseRouteRuleChatIdList(rule.chatIds);
    if (chatIds.length === 0) {
      continue;
    }

    const existing = map.get(phoneNormalized) || [];
    const merged = normalizeChatIdList([...existing, ...chatIds]);
    if (merged.length > 0) {
      map.set(phoneNormalized, merged);
    }
  }

  return map;
}

function resolveEmployeePhoneForRouting({
  employeePhone,
  callType,
  callerNumber,
  calleeNumber,
  destinationNumber
}) {
  const sourcePhone = isNonEmptyString(employeePhone)
    ? employeePhone
    : resolveEmployeePhoneFromCallMeta({
      callType,
      callerNumber,
      calleeNumber,
      destinationNumber
    });

  return normalizePhone(sourcePhone);
}

function buildRecipientChatIds({ defaultChatId, globalChatIds, conditionalChatIds }) {
  return normalizeChatIdList([
    defaultChatId,
    ...(Array.isArray(globalChatIds) ? globalChatIds : []),
    ...(Array.isArray(conditionalChatIds) ? conditionalChatIds : [])
  ]);
}

function buildTranscriptCallbackData(callEventId) {
  const normalizedCallEventId = normalizeCallEventId(callEventId);
  if (!normalizedCallEventId) {
    return '';
  }

  return `${TRANSCRIPT_CALLBACK_PREFIX}${normalizedCallEventId}`;
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
  const defaultChatId = config.chatId.trim();
  const globalChatIds = normalizeChatIdList(config.globalChatIds);
  const numberRouteChatIdsMap = buildNumberRouteChatIdsMap(config.numberRouteRules);
  const timeoutMs = config.apiTimeoutMs;
  const timeZone = isNonEmptyString(config.timeZone) ? config.timeZone.trim() : 'Europe/Moscow';

  async function sendTelegramApiRequest({ method, jsonBody = null, formData = null }) {
    const url = `https://api.telegram.org/bot${botToken}/${method}`;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const requestOptions = {
      method: 'POST',
      signal: abortController.signal
    };

    if (formData) {
      requestOptions.body = formData;
    } else {
      requestOptions.headers = {
        'Content-Type': 'application/json'
      };
      requestOptions.body = JSON.stringify(jsonBody || {});
    }

    try {
      const response = await fetch(url, requestOptions);
      const rawText = await response.text();

      let responseJson = null;
      if (isNonEmptyString(rawText)) {
        try {
          responseJson = JSON.parse(rawText);
        } catch (error) {
          responseJson = null;
        }
      }

      if (!response.ok || responseJson?.ok !== true) {
        const description = isNonEmptyString(responseJson?.description)
          ? responseJson.description
          : `Telegram returned HTTP ${response.status}`;

        logger.warn('telegram_api_request_failed', {
          method,
          httpStatus: response.status,
          description
        });

        return {
          status: 'failed',
          httpStatus: response.status,
          errorCode: 'TELEGRAM_API_ERROR',
          errorMessage: description,
          responsePayload: responseJson || (isNonEmptyString(rawText) ? { raw: rawText } : null)
        };
      }

      return {
        status: 'sent',
        httpStatus: response.status,
        responsePayload: responseJson
      };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        logger.warn('telegram_api_timeout', {
          method,
          timeoutMs
        });

        return {
          status: 'failed',
          errorCode: 'TELEGRAM_TIMEOUT',
          errorMessage: `Telegram request timeout after ${timeoutMs} ms`,
          responsePayload: null
        };
      }

      logger.warn('telegram_api_request_error', {
        method,
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
  }

  async function sendTextMessage({ chatId = defaultChatId, text, replyMarkup = null }) {
    const resolvedChatId = normalizeChatId(chatId);
    if (!resolvedChatId || !isNonEmptyString(text)) {
      return {
        status: 'failed',
        errorCode: 'TELEGRAM_INVALID_MESSAGE',
        errorMessage: 'chatId and text are required for Telegram text message',
        responsePayload: null
      };
    }

    const body = {
      chat_id: resolvedChatId,
      text: text.trim()
    };

    if (replyMarkup && typeof replyMarkup === 'object') {
      body.reply_markup = replyMarkup;
    }

    return sendTelegramApiRequest({
      method: 'sendMessage',
      jsonBody: body
    });
  }

  async function sendTextDocument({ chatId, fileName, text }) {
    const resolvedChatId = normalizeChatId(chatId);
    if (!resolvedChatId || !isNonEmptyString(fileName) || !isNonEmptyString(text)) {
      return {
        status: 'failed',
        errorCode: 'TELEGRAM_INVALID_DOCUMENT',
        errorMessage: 'chatId, fileName and text are required for Telegram document send',
        responsePayload: null
      };
    }

    const formData = new FormData();
    formData.append('chat_id', resolvedChatId);
    formData.append(
      'document',
      new Blob([text], { type: 'text/plain; charset=utf-8' }),
      fileName.trim()
    );

    return sendTelegramApiRequest({
      method: 'sendDocument',
      formData
    });
  }

  async function answerCallbackQuery({ callbackQueryId, text = '', showAlert = false }) {
    if (!isNonEmptyString(callbackQueryId)) {
      return {
        status: 'failed',
        errorCode: 'TELEGRAM_INVALID_CALLBACK_QUERY_ID',
        errorMessage: 'callbackQueryId is required',
        responsePayload: null
      };
    }

    return sendTelegramApiRequest({
      method: 'answerCallbackQuery',
      jsonBody: {
        callback_query_id: callbackQueryId.trim(),
        text: isNonEmptyString(text) ? text.trim() : undefined,
        show_alert: showAlert === true
      }
    });
  }

  async function getWebhookInfo() {
    return sendTelegramApiRequest({
      method: 'getWebhookInfo',
      jsonBody: {}
    });
  }

  async function deleteWebhook({ dropPendingUpdates = false } = {}) {
    return sendTelegramApiRequest({
      method: 'deleteWebhook',
      jsonBody: {
        drop_pending_updates: dropPendingUpdates === true
      }
    });
  }

  async function getUpdates({
    offset = null,
    timeoutSec = 25,
    limit = 25,
    allowedUpdates = ['callback_query']
  } = {}) {
    const normalizedTimeoutSec = normalizePositiveInteger(timeoutSec, 25);
    const normalizedLimit = normalizePositiveInteger(limit, 25);
    const normalizedOffset = normalizePositiveInteger(offset, null);
    const maxTimeoutSecByApiTimeout = Math.max(1, Math.floor(Math.max(timeoutMs - 1500, 1000) / 1000));
    const effectiveTimeoutSec = Math.min(normalizedTimeoutSec, 50, maxTimeoutSecByApiTimeout);

    const body = {
      timeout: effectiveTimeoutSec,
      limit: Math.min(normalizedLimit, 100)
    };

    if (normalizedOffset !== null) {
      body.offset = normalizedOffset;
    }

    if (Array.isArray(allowedUpdates)) {
      body.allowed_updates = allowedUpdates
        .filter((item) => isNonEmptyString(item))
        .map((item) => item.trim());
    }

    return sendTelegramApiRequest({
      method: 'getUpdates',
      jsonBody: body
    });
  }

  async function sendTelegramMessage({
    callEventId,
    phone,
    callDateTime,
    analysis,
    employee,
    employeePhone,
    callType,
    callerNumber,
    calleeNumber,
    destinationNumber
  }) {
    const rawCallType = normalizeCallTypeForWarning(callType);
    if (rawCallType && !KNOWN_CALL_TYPES.has(rawCallType)) {
      logger.warn('telegram_unknown_call_type', {
        callEventId,
        callType: rawCallType
      });
    }

    const text = formatTelegramCallSummary({
      phone,
      callDateTime,
      analysis,
      employee,
      callType,
      callerNumber,
      calleeNumber,
      destinationNumber,
      timeZone
    });

    const callbackData = buildTranscriptCallbackData(callEventId);
    const replyMarkup = callbackData
      ? {
          inline_keyboard: [
            [
              {
                text: TRANSCRIPT_BUTTON_LABEL,
                callback_data: callbackData
              }
            ]
          ]
        }
      : null;

    const routingEmployeePhone = resolveEmployeePhoneForRouting({
      employeePhone,
      callType,
      callerNumber,
      calleeNumber,
      destinationNumber
    });
    const conditionalChatIds = routingEmployeePhone
      ? numberRouteChatIdsMap.get(routingEmployeePhone) || []
      : [];
    const targetChatIds = buildRecipientChatIds({
      defaultChatId,
      globalChatIds,
      conditionalChatIds
    });

    if (targetChatIds.length === 0) {
      return {
        status: 'failed',
        errorCode: 'TELEGRAM_INVALID_MESSAGE',
        errorMessage: 'No valid Telegram chat ids configured for delivery',
        responsePayload: {
          routePhone: routingEmployeePhone || null,
          recipients: [],
          sentCount: 0,
          failedCount: 0
        },
        recipientResults: []
      };
    }

    const recipientResults = [];

    for (const chatId of targetChatIds) {
      const sendResult = await sendTextMessage({
        chatId,
        text,
        replyMarkup
      });

      const recipientResult = {
        chatId,
        status: sendResult.status,
        httpStatus: sendResult.httpStatus || null,
        errorCode: sendResult.errorCode || null,
        errorMessage: sendResult.errorMessage || null
      };

      recipientResults.push(recipientResult);

      if (sendResult.status === 'sent') {
        logger.info('telegram_recipient_delivery_sent', {
          callEventId,
          chatId,
          httpStatus: sendResult.httpStatus || null
        });
      } else {
        logger.warn('telegram_recipient_delivery_failed', {
          callEventId,
          chatId,
          errorCode: sendResult.errorCode || null,
          httpStatus: sendResult.httpStatus || null
        });
      }
    }

    const sentCount = recipientResults.filter((item) => item.status === 'sent').length;
    const failedCount = recipientResults.length - sentCount;
    const firstFailed = recipientResults.find((item) => item.status !== 'sent') || null;
    const status = sentCount > 0 ? 'sent' : 'failed';
    const errorCode = failedCount === 0
      ? null
      : status === 'failed'
        ? (firstFailed?.errorCode || 'TELEGRAM_SEND_FAILED')
        : 'TELEGRAM_PARTIAL_FAILURE';
    const errorMessage = failedCount === 0
      ? null
      : status === 'failed'
        ? (firstFailed?.errorMessage || 'Telegram delivery failed for all recipients')
        : `Telegram delivery failed for ${failedCount} of ${recipientResults.length} recipients`;
    const httpStatus = status === 'failed' ? (firstFailed?.httpStatus || null) : null;

    return {
      status,
      httpStatus,
      errorCode,
      errorMessage,
      responsePayload: {
        routePhone: routingEmployeePhone || null,
        recipients: recipientResults,
        sentCount,
        failedCount
      },
      recipientResults
    };
  }

  sendTelegramMessage.sendTextMessage = sendTextMessage;
  sendTelegramMessage.sendTextDocument = sendTextDocument;
  sendTelegramMessage.answerCallbackQuery = answerCallbackQuery;
  sendTelegramMessage.getWebhookInfo = getWebhookInfo;
  sendTelegramMessage.deleteWebhook = deleteWebhook;
  sendTelegramMessage.getUpdates = getUpdates;
  sendTelegramMessage.defaultChatId = defaultChatId;

  return sendTelegramMessage;
}

module.exports = {
  createTelegramSender,
  TelegramConfigurationError,
  buildTranscriptCallbackData,
  TRANSCRIPT_CALLBACK_PREFIX,
  TRANSCRIPT_BUTTON_LABEL
};
