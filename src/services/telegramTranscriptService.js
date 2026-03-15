const { parseDateOrNull } = require('../utils/dateTime');
const { TRANSCRIPT_CALLBACK_PREFIX } = require('./sendTelegramMessage');

const EMPTY_VALUE = '—';
const MISSING_TRANSCRIPT_TEXT = 'Транскрипт для этого звонка не сохранён.';

const CATEGORY_MAP = Object.freeze({
  запчасти: 'Запчасти',
  запчасть: 'Запчасти',
  parts: 'Запчасти',
  аренда: 'Аренда',
  rental: 'Аренда',
  прокат: 'Аренда',
  ремонт: 'Ремонт',
  сервис: 'Ремонт',
  service: 'Ремонт',
  доставка: 'Доставка',
  delivery: 'Доставка',
  логистика: 'Доставка',
  прочее: 'Другое',
  другое: 'Другое',
  спам: 'Другое',
  продажа: 'Другое'
});

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeSingleLine(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function normalizeTranscriptText(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }

  return value.replace(/\r\n/g, '\n').trim();
}

function formatCallDateTime(callDateTime, timeZone) {
  const date = parseDateOrNull(callDateTime);
  if (!date) {
    return normalizeSingleLine(callDateTime) || EMPTY_VALUE;
  }

  const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit'
  });

  return `${timeFormatter.format(date)}, ${dateFormatter.format(date)}`;
}

function normalizeCategory(categoryRaw) {
  const normalized = normalizeSingleLine(categoryRaw).toLowerCase();
  if (!normalized) {
    return 'Другое';
  }

  return CATEGORY_MAP[normalized] || 'Другое';
}

function parseTranscriptCallbackData(callbackData) {
  if (!isNonEmptyString(callbackData)) {
    return null;
  }

  const normalized = callbackData.trim();
  const expectedPrefix = TRANSCRIPT_CALLBACK_PREFIX;

  if (!normalized.startsWith(expectedPrefix)) {
    return null;
  }

  const callEventId = normalized.slice(expectedPrefix.length);
  if (!/^[0-9]+$/.test(callEventId)) {
    return null;
  }

  return {
    callEventId
  };
}

function buildTranscriptFileName({ callEventId, callDateTime }) {
  const parsedDate = parseDateOrNull(callDateTime);

  if (!parsedDate) {
    return `call-${callEventId}-transcript.txt`;
  }

  const year = String(parsedDate.getUTCFullYear());
  const month = String(parsedDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsedDate.getUTCDate()).padStart(2, '0');
  const hour = String(parsedDate.getUTCHours()).padStart(2, '0');
  const minute = String(parsedDate.getUTCMinutes()).padStart(2, '0');

  return `call-${callEventId}-${year}${month}${day}-${hour}${minute}.txt`;
}

function buildTranscriptTextFile({ phone, callDateTime, category, transcript, timeZone }) {
  const lines = [
    `Кто звонил: ${normalizeSingleLine(phone) || EMPTY_VALUE}`,
    `Когда звонил: ${formatCallDateTime(callDateTime, timeZone)}`,
    `Категория: ${normalizeCategory(category)}`,
    '',
    'Транскрипт:',
    normalizeTranscriptText(transcript) || EMPTY_VALUE
  ];

  return lines.join('\n');
}

function createTelegramTranscriptService({ storage, telegramSender, logger, timeZone = 'Europe/Moscow' }) {
  async function answerCallbackSafely({ callbackQueryId, text }) {
    if (!isNonEmptyString(callbackQueryId) || typeof telegramSender.answerCallbackQuery !== 'function') {
      return;
    }

    try {
      await telegramSender.answerCallbackQuery({
        callbackQueryId,
        text
      });
    } catch (error) {
      logger.warn('telegram_callback_answer_failed', {
        callbackQueryId,
        error
      });
    }
  }

  async function sendMissingTranscriptMessage({ chatId, callbackQueryId, callEventId }) {
    if (typeof telegramSender.sendTextMessage === 'function') {
      await telegramSender.sendTextMessage({
        chatId,
        text: MISSING_TRANSCRIPT_TEXT
      });
    }

    await answerCallbackSafely({
      callbackQueryId,
      text: 'Транскрипт отсутствует'
    });

    logger.info('telegram_transcript_missing', {
      callEventId
    });

    return {
      status: 'missing_transcript',
      callEventId
    };
  }

  async function handleTranscriptCallback(callbackQuery, options = {}) {
    const parsedCallback = parseTranscriptCallbackData(callbackQuery?.data);
    if (!parsedCallback) {
      await answerCallbackSafely({
        callbackQueryId: callbackQuery?.id,
        text: 'Неизвестная команда'
      });

      return {
        status: 'ignored',
        reason: 'unsupported_callback_data'
      };
    }

    const callEventId = parsedCallback.callEventId;
    const callbackQueryId = isNonEmptyString(callbackQuery?.id) ? callbackQuery.id.trim() : '';
    const chatId = callbackQuery?.message?.chat?.id;

    if (chatId === undefined || chatId === null) {
      await answerCallbackSafely({
        callbackQueryId,
        text: 'Чат не найден'
      });

      return {
        status: 'ignored',
        reason: 'missing_chat_id',
        callEventId
      };
    }

    const transcriptRow = await storage.getCallTranscriptByEventId({
      callEventId
    });

    if (!transcriptRow || !isNonEmptyString(transcriptRow.transcriptText)) {
      return sendMissingTranscriptMessage({
        chatId,
        callbackQueryId,
        callEventId
      });
    }

    const fileContent = buildTranscriptTextFile({
      phone: transcriptRow.phoneRaw,
      callDateTime: transcriptRow.callDateTimeRaw,
      category: transcriptRow.category,
      transcript: transcriptRow.transcriptText,
      timeZone
    });

    const fileName = buildTranscriptFileName({
      callEventId,
      callDateTime: transcriptRow.callDateTimeRaw
    });

    const sendResult = await telegramSender.sendTextDocument({
      chatId,
      fileName,
      text: fileContent
    });

    await answerCallbackSafely({
      callbackQueryId,
      text: sendResult.status === 'sent' ? 'Транскрипт отправлен' : 'Не удалось отправить файл'
    });

    logger.info('telegram_transcript_sent', {
      requestId: options.requestId,
      callEventId,
      chatId: String(chatId),
      sendStatus: sendResult.status
    });

    return {
      status: sendResult.status,
      callEventId,
      telegram: {
        status: sendResult.status,
        httpStatus: sendResult.httpStatus || null
      }
    };
  }

  async function handleTelegramUpdate(update, options = {}) {
    if (!update || typeof update !== 'object') {
      return {
        status: 'ignored',
        reason: 'invalid_payload'
      };
    }

    if (!update.callback_query) {
      return {
        status: 'ignored',
        reason: 'no_callback_query'
      };
    }

    return handleTranscriptCallback(update.callback_query, options);
  }

  return {
    handleTelegramUpdate
  };
}

module.exports = {
  createTelegramTranscriptService,
  parseTranscriptCallbackData,
  buildTranscriptTextFile,
  MISSING_TRANSCRIPT_TEXT
};
