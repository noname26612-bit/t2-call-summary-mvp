function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeNonNegativeInteger(value, fallback = null) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function maxOrNull(left, right) {
  if (left === null || left === undefined) {
    return right;
  }

  if (right === null || right === undefined) {
    return left;
  }

  return left > right ? left : right;
}

function serializeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    statusCode: error.statusCode
  };
}

function createTelegramUpdatePollingService({
  storage,
  telegramSender,
  handleTelegramUpdate,
  logger,
  config = {}
}) {
  const enabled = config.enabled === true;
  const offsetKey = isNonEmptyString(config.offsetKey) ? config.offsetKey.trim() : 'transcript_callback';
  const timeoutSec = normalizeNonNegativeInteger(config.timeoutSec, 25) || 25;
  const idleDelayMs = normalizeNonNegativeInteger(config.idleDelayMs, 400) || 400;
  const errorDelayMs = normalizeNonNegativeInteger(config.errorDelayMs, 3000) || 3000;
  const maxBatchSize = normalizeNonNegativeInteger(config.maxBatchSize, 25) || 25;
  const clearWebhookOnStart = config.clearWebhookOnStart !== false;
  const skipBacklogOnFirstStart = config.skipBacklogOnFirstStart !== false;

  let loopPromise = null;
  let stopRequested = false;

  async function ensurePollingMode() {
    if (!clearWebhookOnStart || typeof telegramSender.deleteWebhook !== 'function') {
      return;
    }

    const infoResult = typeof telegramSender.getWebhookInfo === 'function'
      ? await telegramSender.getWebhookInfo()
      : null;

    const activeWebhookUrl = infoResult?.responsePayload?.result?.url;
    if (isNonEmptyString(activeWebhookUrl)) {
      logger.warn('telegram_polling_switch_from_webhook', {
        webhookUrl: activeWebhookUrl
      });
    }

    const deleteResult = await telegramSender.deleteWebhook({
      dropPendingUpdates: false
    });

    if (deleteResult.status !== 'sent') {
      logger.warn('telegram_polling_delete_webhook_failed', {
        status: deleteResult.status,
        errorCode: deleteResult.errorCode || null,
        httpStatus: deleteResult.httpStatus || null
      });
    } else {
      logger.info('telegram_polling_delete_webhook_ok');
    }
  }

  async function loadOffsetState() {
    const offsetState = await storage.getTelegramUpdateOffset({
      botKey: offsetKey
    });

    return normalizeNonNegativeInteger(offsetState.lastUpdateId, 0);
  }

  async function saveOffsetState(lastUpdateId) {
    const normalized = normalizeNonNegativeInteger(lastUpdateId, null);
    if (normalized === null) {
      return;
    }

    await storage.saveTelegramUpdateOffset({
      botKey: offsetKey,
      lastUpdateId: normalized
    });
  }

  async function processUpdatesBatch(updates) {
    let ackedUpdateId = null;
    let processedCallbacks = 0;
    let failedUpdateId = null;
    let failedReason = '';

    for (const update of updates) {
      const updateId = normalizeNonNegativeInteger(update?.update_id, null);
      if (updateId === null) {
        logger.warn('telegram_update_missing_update_id');
        continue;
      }

      if (!update || typeof update !== 'object' || !update.callback_query) {
        ackedUpdateId = maxOrNull(ackedUpdateId, updateId);
        continue;
      }

      try {
        const callbackResult = await handleTelegramUpdate(update, {
          source: 'telegram_get_updates_poll',
          updateId: updateId === null ? '' : String(updateId)
        });

        if (callbackResult?.status === 'failed') {
          failedUpdateId = updateId;
          failedReason = 'callback_failed_status';
          logger.warn('telegram_update_callback_failed_status', {
            updateId,
            callbackStatus: callbackResult.status
          });
          break;
        }

        ackedUpdateId = maxOrNull(ackedUpdateId, updateId);
        processedCallbacks += 1;
      } catch (error) {
        failedUpdateId = updateId;
        failedReason = 'callback_exception';
        logger.error('telegram_update_callback_failed', {
          updateId,
          error: serializeError(error)
        });
        break;
      }
    }

    return {
      ackedUpdateId,
      processedCallbacks,
      failedUpdateId,
      failedReason
    };
  }

  function extractMaxUpdateId(updates) {
    let maxUpdateId = null;

    for (const update of updates) {
      const updateId = normalizeNonNegativeInteger(update?.update_id, null);
      if (updateId !== null && (maxUpdateId === null || updateId > maxUpdateId)) {
        maxUpdateId = updateId;
      }
    }

    return maxUpdateId;
  }

  async function skipInitialBacklogIfNeeded(lastProcessedUpdateId) {
    if (!skipBacklogOnFirstStart || lastProcessedUpdateId > 0) {
      return lastProcessedUpdateId;
    }

    const bootstrapResult = await telegramSender.getUpdates({
      timeoutSec: 1,
      limit: maxBatchSize,
      allowedUpdates: ['callback_query']
    });

    if (bootstrapResult.status !== 'sent') {
      logger.warn('telegram_polling_bootstrap_read_failed', {
        status: bootstrapResult.status,
        httpStatus: bootstrapResult.httpStatus || null,
        errorCode: bootstrapResult.errorCode || null
      });
      return lastProcessedUpdateId;
    }

    const bootstrapUpdates = Array.isArray(bootstrapResult.responsePayload?.result)
      ? bootstrapResult.responsePayload.result
      : [];

    if (bootstrapUpdates.length === 0) {
      return lastProcessedUpdateId;
    }

    const maxUpdateId = extractMaxUpdateId(bootstrapUpdates);
    if (maxUpdateId === null) {
      return lastProcessedUpdateId;
    }

    await saveOffsetState(maxUpdateId);
    logger.info('telegram_polling_bootstrap_offset_saved', {
      skippedUpdateCount: bootstrapUpdates.length,
      lastUpdateId: maxUpdateId
    });

    return maxUpdateId;
  }

  async function pollingLoop() {
    if (typeof telegramSender.getUpdates !== 'function') {
      logger.warn('telegram_polling_disabled_no_get_updates_method');
      return;
    }

    let lastProcessedUpdateId = await loadOffsetState();

    try {
      await ensurePollingMode();
    } catch (error) {
      logger.warn('telegram_polling_mode_init_failed', {
        error: serializeError(error)
      });
    }

    try {
      lastProcessedUpdateId = await skipInitialBacklogIfNeeded(lastProcessedUpdateId);
    } catch (error) {
      logger.warn('telegram_polling_bootstrap_failed', {
        error: serializeError(error)
      });
    }

    logger.info('telegram_polling_started', {
      offsetKey,
      lastProcessedUpdateId,
      timeoutSec,
      idleDelayMs,
      errorDelayMs
    });

    while (!stopRequested) {
      const nextOffset = lastProcessedUpdateId > 0 ? lastProcessedUpdateId + 1 : null;

      let updatesResult;
      try {
        updatesResult = await telegramSender.getUpdates({
          offset: nextOffset,
          timeoutSec,
          limit: maxBatchSize,
          allowedUpdates: ['callback_query']
        });
      } catch (error) {
        logger.warn('telegram_polling_get_updates_throw', {
          error: serializeError(error)
        });
        await sleep(errorDelayMs);
        continue;
      }

      if (updatesResult.status !== 'sent') {
        const retryAfterSeconds = normalizeNonNegativeInteger(
          updatesResult?.responsePayload?.parameters?.retry_after,
          0
        );
        const retryAfterMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
        const delayMs = Math.max(errorDelayMs, retryAfterMs);

        logger.warn('telegram_polling_get_updates_failed', {
          status: updatesResult.status,
          httpStatus: updatesResult.httpStatus || null,
          errorCode: updatesResult.errorCode || null,
          retryAfterSeconds
        });
        await sleep(delayMs);
        continue;
      }

      const updates = Array.isArray(updatesResult.responsePayload?.result)
        ? updatesResult.responsePayload.result
        : [];

      if (updates.length === 0) {
        await sleep(idleDelayMs);
        continue;
      }

      const {
        ackedUpdateId,
        processedCallbacks,
        failedUpdateId,
        failedReason
      } = await processUpdatesBatch(updates);
      const hasProgress = ackedUpdateId !== null && ackedUpdateId > lastProcessedUpdateId;

      if (hasProgress) {
        await saveOffsetState(ackedUpdateId);
        lastProcessedUpdateId = ackedUpdateId;

        logger.info('telegram_polling_offset_advanced', {
          offsetKey,
          lastProcessedUpdateId,
          fetchedUpdates: updates.length,
          processedCallbacks
        });
      }

      if (failedUpdateId !== null) {
        logger.warn('telegram_polling_batch_halted_on_failed_update', {
          failedUpdateId,
          failedReason
        });
        await sleep(errorDelayMs);
        continue;
      }

      if (!hasProgress) {
        await sleep(idleDelayMs);
      }
    }

    logger.info('telegram_polling_stopped', {
      offsetKey
    });
  }

  function start() {
    if (!enabled) {
      logger.info('telegram_polling_disabled');
      return {
        status: 'disabled'
      };
    }

    if (loopPromise) {
      return {
        status: 'already_started'
      };
    }

    stopRequested = false;
    loopPromise = pollingLoop()
      .catch((error) => {
        logger.error('telegram_polling_crashed', {
          error: serializeError(error)
        });
      })
      .finally(() => {
        loopPromise = null;
      });

    return {
      status: 'started'
    };
  }

  async function stop() {
    stopRequested = true;

    if (!loopPromise) {
      return {
        status: 'not_running'
      };
    }

    await loopPromise;
    return {
      status: 'stopped'
    };
  }

  return {
    start,
    stop
  };
}

module.exports = {
  createTelegramUpdatePollingService
};
