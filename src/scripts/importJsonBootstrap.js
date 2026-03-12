#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createLogger } = require('../services/logger');
const { createPgPool } = require('../db/createPgPool');
const { runMigrations } = require('../db/migrations');
const { normalizePhone } = require('../utils/ignoredPhones');
const { buildTranscriptHash, buildDedupKey } = require('../utils/dedup');

dotenv.config();

function isIsoDateLike(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }

  return !Number.isNaN(Date.parse(value.trim()));
}

function parseJsonArray(raw, label) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} has invalid JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }

  return parsed;
}

async function readArrayFile(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseJsonArray(raw, label);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function importProcessedCalls(pool, records) {
  let imported = 0;

  for (const item of records) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const dedupKey = typeof item.fingerprint === 'string' && item.fingerprint.trim() !== ''
      ? item.fingerprint.trim()
      : null;

    if (!dedupKey) {
      continue;
    }

    const phoneNormalized = normalizePhone(typeof item.phone === 'string' ? item.phone : '');
    const callDateTimeRaw = typeof item.callDateTime === 'string' ? item.callDateTime.trim() : '';
    const createdAt = isIsoDateLike(item.createdAt) ? new Date(item.createdAt) : new Date();

    const result = await pool.query(
      `
      INSERT INTO processed_calls (
        dedup_key,
        call_event_id,
        phone_normalized,
        call_datetime_raw,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, NULL, $2, $3, 'processed', $4, $4)
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING id
      `,
      [dedupKey, phoneNormalized, callDateTimeRaw, createdAt]
    );

    if (result.rowCount > 0) {
      imported += 1;
    }
  }

  return imported;
}

function normalizeHistoryStatus(status) {
  const allowed = new Set(['ignored', 'duplicate', 'processed', 'failed', 'received']);

  if (typeof status !== 'string') {
    return 'failed';
  }

  const normalized = status.trim();
  return allowed.has(normalized) ? normalized : 'failed';
}

async function importCallHistory(pool, records) {
  let importedEvents = 0;
  let importedSummaries = 0;
  let importedTelegram = 0;
  let importedAudit = 0;

  for (const item of records) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const phoneRaw = typeof item.phone === 'string' ? item.phone.trim() : '';
    const phoneNormalized = normalizePhone(phoneRaw);
    const callDateTimeRaw = typeof item.callDateTime === 'string' ? item.callDateTime.trim() : '';
    const transcriptPreview = typeof item.transcriptPreview === 'string'
      ? item.transcriptPreview.trim().slice(0, 240)
      : '';
    const transcriptHash = buildTranscriptHash(transcriptPreview || JSON.stringify(item).slice(0, 400));
    const dedupKey = buildDedupKey({
      phone: phoneNormalized,
      callDateTime: callDateTimeRaw || (typeof item.createdAt === 'string' ? item.createdAt : ''),
      transcriptHash
    });
    const status = normalizeHistoryStatus(item.status);
    const reason = typeof item.reason === 'string' && item.reason.trim() !== '' ? item.reason.trim() : null;
    const source = typeof item.source === 'string' && item.source.trim() !== ''
      ? item.source.trim()
      : 'json_bootstrap';
    const createdAt = isIsoDateLike(item.createdAt) ? new Date(item.createdAt) : new Date();

    const eventInsert = await pool.query(
      `
      INSERT INTO call_events (
        source,
        phone_raw,
        phone_normalized,
        call_datetime_raw,
        call_datetime_utc,
        transcript_hash,
        transcript_preview,
        transcript_length,
        dedup_key,
        status,
        reason,
        telegram_status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
      RETURNING id
      `,
      [
        source,
        phoneRaw,
        phoneNormalized,
        callDateTimeRaw,
        isIsoDateLike(callDateTimeRaw) ? new Date(callDateTimeRaw) : null,
        transcriptHash,
        transcriptPreview,
        transcriptPreview.length,
        dedupKey,
        status,
        reason,
        typeof item.telegramStatus === 'string' && item.telegramStatus.trim() !== ''
          ? item.telegramStatus.trim() === 'sent' ? 'sent' : 'failed'
          : null,
        createdAt
      ]
    );

    const callEventId = eventInsert.rows[0].id;
    importedEvents += 1;

    if (status === 'processed' && item.analysis && typeof item.analysis === 'object' && !Array.isArray(item.analysis)) {
      const analysis = item.analysis;
      const tags = Array.isArray(analysis.tags) ? analysis.tags : [];

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
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
        ON CONFLICT (call_event_id) DO NOTHING
        `,
        [
          callEventId,
          typeof analysis.category === 'string' ? analysis.category.trim() : 'прочее',
          typeof analysis.topic === 'string' ? analysis.topic.trim() : '—',
          typeof analysis.summary === 'string' ? analysis.summary.trim() : '—',
          typeof analysis.result === 'string' ? analysis.result.trim() : '—',
          typeof analysis.nextStep === 'string' ? analysis.nextStep.trim() : '—',
          typeof analysis.urgency === 'string' ? analysis.urgency.trim() : 'низкая',
          JSON.stringify(tags),
          Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : 0,
          createdAt
        ]
      );

      importedSummaries += 1;
    }

    if (typeof item.telegramStatus === 'string' && item.telegramStatus.trim() !== '') {
      const telegramStatus = item.telegramStatus.trim() === 'sent' ? 'sent' : 'failed';

      await pool.query(
        `
        INSERT INTO telegram_deliveries (
          call_event_id,
          status,
          response_payload,
          created_at
        )
        VALUES ($1, $2, NULL, $3)
        `,
        [callEventId, telegramStatus, createdAt]
      );

      importedTelegram += 1;
    }

    await pool.query(
      `
      INSERT INTO audit_events (
        call_event_id,
        event_type,
        payload,
        created_at
      )
      VALUES ($1, 'json_bootstrap_import', $2::jsonb, $3)
      `,
      [callEventId, JSON.stringify(item), createdAt]
    );

    importedAudit += 1;
  }

  return {
    importedEvents,
    importedSummaries,
    importedTelegram,
    importedAudit
  };
}

async function main() {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const processedCallsPath = path.join(dataDir, 'processed-calls.json');
  const callHistoryPath = path.join(dataDir, 'call-history.json');

  const config = loadConfig({ validateRuntimeSecrets: false });
  const logger = createLogger({ level: config.logLevel, service: 'ats-call-summary-bootstrap' });
  const pool = createPgPool(config.database);

  try {
    await runMigrations({
      pool,
      migrationsDir: path.join(rootDir, 'migrations'),
      logger
    });

    const processedCalls = await readArrayFile(processedCallsPath, 'processed-calls.json');
    const callHistory = await readArrayFile(callHistoryPath, 'call-history.json');

    const processedImported = await importProcessedCalls(pool, processedCalls);
    const historyImported = await importCallHistory(pool, callHistory);

    logger.info('json_bootstrap_import_completed', {
      processedInputCount: processedCalls.length,
      historyInputCount: callHistory.length,
      processedImported,
      ...historyImported
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
