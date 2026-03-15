function toDateOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed);
}

function normalizePreview(preview) {
  if (typeof preview !== 'string') {
    return '';
  }

  return preview.trim().slice(0, 240);
}

function normalizeTranscriptText(transcript) {
  if (typeof transcript !== 'string') {
    return '';
  }

  return transcript.trim();
}

function buildPostgresStorage({ pool, logger }) {
  async function healthcheck() {
    await pool.query('SELECT 1');
    return true;
  }

  async function close() {
    await pool.end();
  }

  async function createCallEvent({
    source,
    phoneRaw,
    phoneNormalized,
    callDateTimeRaw,
    transcriptHash,
    transcriptPreview,
    transcriptText,
    transcriptLength,
    dedupKey
  }) {
    const result = await pool.query(
      `
      INSERT INTO call_events (
        source,
        phone_raw,
        phone_normalized,
        call_datetime_raw,
        call_datetime_utc,
        transcript_hash,
        transcript_preview,
        transcript_text,
        transcript_length,
        dedup_key,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'received')
      RETURNING id
      `,
      [
        source,
        phoneRaw,
        phoneNormalized,
        callDateTimeRaw,
        toDateOrNull(callDateTimeRaw),
        transcriptHash,
        normalizePreview(transcriptPreview),
        normalizeTranscriptText(transcriptText),
        transcriptLength,
        dedupKey
      ]
    );

    return {
      id: result.rows[0].id
    };
  }

  async function updateCallEventStatus({ callEventId, status, reason = null, telegramStatus = null }) {
    await pool.query(
      `
      UPDATE call_events
      SET status = $2,
          reason = $3,
          telegram_status = $4,
          updated_at = NOW()
      WHERE id = $1
      `,
      [callEventId, status, reason, telegramStatus]
    );
  }

  async function appendAuditEvent({ callEventId = null, eventType, payload = {} }) {
    await pool.query(
      `
      INSERT INTO audit_events (call_event_id, event_type, payload)
      VALUES ($1, $2, $3::jsonb)
      `,
      [callEventId, eventType, JSON.stringify(payload || {})]
    );
  }

  async function saveSummary({ callEventId, analysis }) {
    await pool.query(
      `
      INSERT INTO summaries (
        call_event_id,
        category,
        topic,
        summary,
        result,
        next_step,
        urgency,
        tags,
        confidence
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      ON CONFLICT (call_event_id)
      DO UPDATE
      SET category = EXCLUDED.category,
          topic = EXCLUDED.topic,
          summary = EXCLUDED.summary,
          result = EXCLUDED.result,
          next_step = EXCLUDED.next_step,
          urgency = EXCLUDED.urgency,
          tags = EXCLUDED.tags,
          confidence = EXCLUDED.confidence
      `,
      [
        callEventId,
        analysis.category,
        analysis.topic,
        analysis.summary,
        analysis.result,
        analysis.nextStep,
        analysis.urgency,
        JSON.stringify(analysis.tags || []),
        analysis.confidence
      ]
    );
  }

  async function saveTelegramDelivery({
    callEventId,
    status,
    httpStatus = null,
    errorCode = null,
    errorMessage = null,
    responsePayload = null
  }) {
    await pool.query(
      `
      INSERT INTO telegram_deliveries (
        call_event_id,
        status,
        http_status,
        error_code,
        error_message,
        response_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        callEventId,
        status,
        httpStatus,
        errorCode,
        errorMessage,
        responsePayload ? JSON.stringify(responsePayload) : null
      ]
    );
  }

  async function isPhoneIgnored(phoneNormalized) {
    const result = await pool.query(
      `
      SELECT 1
      FROM ignore_list
      WHERE phone_normalized = $1 AND is_active = TRUE
      LIMIT 1
      `,
      [phoneNormalized]
    );

    return result.rowCount > 0;
  }

  async function seedIgnoreList(phones, source = 'env_bootstrap') {
    const uniquePhones = [...new Set(phones)].filter(Boolean);

    let upsertedCount = 0;
    for (const phone of uniquePhones) {
      const result = await pool.query(
        `
        INSERT INTO ignore_list (phone_normalized, source, is_active)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (phone_normalized)
        DO UPDATE SET
          is_active = TRUE,
          source = EXCLUDED.source,
          updated_at = NOW()
        RETURNING id
        `,
        [phone, source]
      );

      if (result.rowCount > 0) {
        upsertedCount += 1;
      }
    }

    return upsertedCount;
  }

  async function acquireDedupKey({ dedupKey, callEventId, phoneNormalized, callDateTimeRaw }) {
    const inserted = await pool.query(
      `
      INSERT INTO processed_calls (
        dedup_key,
        call_event_id,
        phone_normalized,
        call_datetime_raw,
        status
      )
      VALUES ($1, $2, $3, $4, 'processing')
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING id
      `,
      [dedupKey, callEventId, phoneNormalized, callDateTimeRaw]
    );

    if (inserted.rowCount > 0) {
      return {
        acquired: true,
        previousStatus: null
      };
    }

    const existing = await pool.query(
      `
      SELECT status
      FROM processed_calls
      WHERE dedup_key = $1
      LIMIT 1
      `,
      [dedupKey]
    );

    const existingStatus = existing.rows[0] ? existing.rows[0].status : 'unknown';

    if (existingStatus === 'failed') {
      const recovered = await pool.query(
        `
        UPDATE processed_calls
        SET status = 'processing',
            call_event_id = $2,
            phone_normalized = $3,
            call_datetime_raw = $4,
            updated_at = NOW()
        WHERE dedup_key = $1 AND status = 'failed'
        RETURNING id
        `,
        [dedupKey, callEventId, phoneNormalized, callDateTimeRaw]
      );

      if (recovered.rowCount > 0) {
        return {
          acquired: true,
          previousStatus: 'failed'
        };
      }
    }

    return {
      acquired: false,
      previousStatus: existingStatus
    };
  }

  async function completeDedupKey({ dedupKey, status, callEventId }) {
    await pool.query(
      `
      UPDATE processed_calls
      SET status = $2,
          call_event_id = COALESCE($3, call_event_id),
          updated_at = NOW()
      WHERE dedup_key = $1
      `,
      [dedupKey, status, callEventId]
    );
  }

  async function getCallTranscriptByEventId({ callEventId }) {
    const result = await pool.query(
      `
      SELECT
        ce.id,
        ce.phone_raw,
        ce.call_datetime_raw,
        ce.transcript_text,
        s.category
      FROM call_events ce
      LEFT JOIN summaries s ON s.call_event_id = ce.id
      WHERE ce.id = $1
      LIMIT 1
      `,
      [callEventId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];

    return {
      callEventId: String(row.id),
      phoneRaw: row.phone_raw,
      callDateTimeRaw: row.call_datetime_raw,
      transcriptText: typeof row.transcript_text === 'string' ? row.transcript_text : '',
      category: typeof row.category === 'string' ? row.category : ''
    };
  }

  return {
    healthcheck,
    close,
    createCallEvent,
    updateCallEventStatus,
    appendAuditEvent,
    saveSummary,
    saveTelegramDelivery,
    isPhoneIgnored,
    seedIgnoreList,
    acquireDedupKey,
    completeDedupKey,
    getCallTranscriptByEventId,
    pool,
    logger
  };
}

module.exports = {
  buildPostgresStorage
};
