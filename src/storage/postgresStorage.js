const { normalizePhone } = require('../utils/ignoredPhones');

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

function normalizePositiveInteger(value, fallback = 0) {
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

function normalizeJsonArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  return JSON.stringify(value);
}

function normalizeSpeakerRoleConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) {
      return 0;
    }

    if (value > 1) {
      return 1;
    }

    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim().replace(',', '.'));
    if (Number.isFinite(parsed)) {
      return normalizeSpeakerRoleConfidence(parsed);
    }
  }

  return null;
}

function normalizeShortText(value, maxLength = 256) {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  return normalized.slice(0, maxLength);
}

function normalizeAiUsageStatus(value) {
  const normalized = normalizeShortText(value, 40).toLowerCase();
  if (normalized === 'success' || normalized === 'failed' || normalized === 'skipped') {
    return normalized;
  }

  return 'failed';
}

function normalizeAiUsageOperation(value) {
  const normalized = normalizeShortText(value, 40).toLowerCase();
  if (!normalized) {
    return 'analyze';
  }

  return normalized;
}

function normalizeNullablePositiveInteger(value) {
  const normalized = normalizePositiveInteger(value, -1);
  if (normalized < 0) {
    return null;
  }

  return normalized;
}

function normalizeNullableNonNegativeInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeEstimatedCostRub(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Number(value.toFixed(6));
  }

  if (typeof value === 'string' && /^[0-9]+([.,][0-9]+)?$/.test(value.trim())) {
    const parsed = Number.parseFloat(value.trim().replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Number(parsed.toFixed(6));
    }
  }

  return null;
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

  async function insertAiUsageAudit({
    xRequestId = '',
    callEventId = null,
    callId = '',
    operation = 'analyze',
    model = '',
    provider = '',
    promptTokens = null,
    completionTokens = null,
    totalTokens = null,
    transcriptCharsRaw = null,
    transcriptCharsSent = null,
    durationMs = null,
    responseStatus = 'failed',
    skipReason = '',
    estimatedCostRub = null,
    createdAt = ''
  }) {
    await pool.query(
      `
      INSERT INTO ai_usage_audit (
        x_request_id,
        call_event_id,
        call_id,
        operation,
        model,
        provider,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        transcript_chars_raw,
        transcript_chars_sent,
        duration_ms,
        response_status,
        skip_reason,
        estimated_cost_rub,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, COALESCE($16::timestamptz, NOW())
      )
      `,
      [
        normalizeShortText(xRequestId, 128) || null,
        normalizeNullablePositiveInteger(callEventId),
        normalizeShortText(callId, 256) || null,
        normalizeAiUsageOperation(operation),
        normalizeShortText(model, 120) || null,
        normalizeShortText(provider, 80) || null,
        normalizeNullableNonNegativeInteger(promptTokens),
        normalizeNullableNonNegativeInteger(completionTokens),
        normalizeNullableNonNegativeInteger(totalTokens),
        normalizeNullableNonNegativeInteger(transcriptCharsRaw),
        normalizeNullableNonNegativeInteger(transcriptCharsSent),
        normalizeNullableNonNegativeInteger(durationMs),
        normalizeAiUsageStatus(responseStatus),
        normalizeShortText(skipReason, 200) || null,
        normalizeEstimatedCostRub(estimatedCostRub),
        toDateOrNull(createdAt)
      ]
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
        confidence,
        transcript_plain,
        reconstructed_turns,
        participants_assumption,
        detected_client_speaker,
        detected_employee_speaker,
        speaker_role_confidence,
        client_goal,
        employee_response,
        issue_reason,
        outcome_structured,
        next_step_structured,
        analysis_warnings
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
        $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb
      )
      ON CONFLICT (call_event_id)
      DO UPDATE
      SET category = EXCLUDED.category,
          topic = EXCLUDED.topic,
          summary = EXCLUDED.summary,
          result = EXCLUDED.result,
          next_step = EXCLUDED.next_step,
          urgency = EXCLUDED.urgency,
          tags = EXCLUDED.tags,
          confidence = EXCLUDED.confidence,
          transcript_plain = EXCLUDED.transcript_plain,
          reconstructed_turns = EXCLUDED.reconstructed_turns,
          participants_assumption = EXCLUDED.participants_assumption,
          detected_client_speaker = EXCLUDED.detected_client_speaker,
          detected_employee_speaker = EXCLUDED.detected_employee_speaker,
          speaker_role_confidence = EXCLUDED.speaker_role_confidence,
          client_goal = EXCLUDED.client_goal,
          employee_response = EXCLUDED.employee_response,
          issue_reason = EXCLUDED.issue_reason,
          outcome_structured = EXCLUDED.outcome_structured,
          next_step_structured = EXCLUDED.next_step_structured,
          analysis_warnings = EXCLUDED.analysis_warnings
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
        analysis.confidence,
        normalizeTranscriptText(analysis.transcriptPlain),
        normalizeJsonArray(analysis.reconstructedTurns),
        typeof analysis.participantsAssumption === 'string'
          ? analysis.participantsAssumption.trim()
          : null,
        typeof analysis.detectedClientSpeaker === 'string'
          ? analysis.detectedClientSpeaker.trim()
          : null,
        typeof analysis.detectedEmployeeSpeaker === 'string'
          ? analysis.detectedEmployeeSpeaker.trim()
          : null,
        normalizeSpeakerRoleConfidence(analysis.speakerRoleConfidence),
        typeof analysis.clientGoal === 'string' ? analysis.clientGoal.trim() : null,
        typeof analysis.employeeResponse === 'string' ? analysis.employeeResponse.trim() : null,
        typeof analysis.issueReason === 'string' ? analysis.issueReason.trim() : null,
        typeof analysis.outcome === 'string' ? analysis.outcome.trim() : null,
        typeof analysis.nextStepStructured === 'string' ? analysis.nextStepStructured.trim() : null,
        normalizeJsonArray(analysis.analysisWarnings)
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

  async function findActiveEmployeeByPhone(phone) {
    const normalizedPhone = normalizePhone(typeof phone === 'string' ? phone.trim() : '');
    if (!normalizedPhone) {
      return null;
    }

    const result = await pool.query(
      `
      SELECT
        id,
        phone_normalized,
        employee_name,
        employee_title,
        is_active,
        notes
      FROM employee_phone_directory
      WHERE phone_normalized = $1
        AND is_active = TRUE
      LIMIT 1
      `,
      [normalizedPhone]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];

    return {
      id: Number.isSafeInteger(Number(row.id)) ? Number(row.id) : null,
      phoneNormalized: typeof row.phone_normalized === 'string' ? row.phone_normalized : normalizedPhone,
      employeeName: typeof row.employee_name === 'string' ? row.employee_name : '',
      employeeTitle: typeof row.employee_title === 'string' ? row.employee_title : '',
      isActive: row.is_active === true,
      notes: typeof row.notes === 'string' ? row.notes : ''
    };
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

  async function getTelegramUpdateOffset({ botKey = 'default' } = {}) {
    const result = await pool.query(
      `
      SELECT last_update_id
      FROM telegram_update_offsets
      WHERE bot_key = $1
      LIMIT 1
      `,
      [botKey]
    );

    if (result.rowCount === 0) {
      return {
        botKey,
        lastUpdateId: 0
      };
    }

    return {
      botKey,
      lastUpdateId: normalizePositiveInteger(result.rows[0].last_update_id, 0)
    };
  }

  async function saveTelegramUpdateOffset({ botKey = 'default', lastUpdateId }) {
    const normalizedOffset = normalizePositiveInteger(lastUpdateId, -1);
    if (normalizedOffset < 0) {
      throw new Error('lastUpdateId must be a non-negative integer');
    }

    await pool.query(
      `
      INSERT INTO telegram_update_offsets (
        bot_key,
        last_update_id,
        updated_at
      )
      VALUES ($1, $2, NOW())
      ON CONFLICT (bot_key)
      DO UPDATE
      SET last_update_id = EXCLUDED.last_update_id,
          updated_at = NOW()
      `,
      [botKey, normalizedOffset]
    );

    return {
      botKey,
      lastUpdateId: normalizedOffset
    };
  }

  return {
    healthcheck,
    close,
    createCallEvent,
    updateCallEventStatus,
    appendAuditEvent,
    insertAiUsageAudit,
    saveSummary,
    saveTelegramDelivery,
    isPhoneIgnored,
    findActiveEmployeeByPhone,
    seedIgnoreList,
    acquireDedupKey,
    completeDedupKey,
    getCallTranscriptByEventId,
    getTelegramUpdateOffset,
    saveTelegramUpdateOffset,
    pool,
    logger
  };
}

module.exports = {
  buildPostgresStorage
};
