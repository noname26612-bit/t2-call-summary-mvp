#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createPgPool } = require('../db/createPgPool');

dotenv.config();

const DEFAULT_TIME_ZONE = process.env.APP_TIMEZONE || 'Europe/Moscow';
const DEFAULT_REASONS = ['T2_FILE_HTTP_ERROR', 'POLZA_EMPTY_TRANSCRIPTION', 'AI_GATEWAY_EMPTY_TRANSCRIPT'];
const DEFAULT_STATUSES = ['failed', 'skipped'];
const DEFAULT_PROCESS_URL = process.env.PROCESS_CALL_URL || 'http://t2-call-summary:3000/api/process-call';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parsePositiveInt(rawValue, name, fallbackValue) {
  if (!isNonEmptyString(rawValue)) {
    return fallbackValue;
  }

  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseCsvList(rawValue) {
  if (!isNonEmptyString(rawValue)) {
    return [];
  }

  const seen = new Set();
  const values = [];

  for (const token of rawValue.split(',')) {
    const normalized = token.trim();
    if (!normalized) {
      continue;
    }

    const upper = normalized.toUpperCase();
    if (seen.has(upper)) {
      continue;
    }

    seen.add(upper);
    values.push(upper);
  }

  return values;
}

function getTodayDateInTimeZone(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((item) => item.type === 'year')?.value || '1970';
  const month = parts.find((item) => item.type === 'month')?.value || '01';
  const day = parts.find((item) => item.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

function parseArgs(argv) {
  const parsed = {
    date: '',
    timeZone: DEFAULT_TIME_ZONE,
    reasons: [...DEFAULT_REASONS],
    statuses: [...DEFAULT_STATUSES],
    limit: 20,
    dryRun: false,
    timeoutMs: parsePositiveInt(process.env.T2_API_TIMEOUT_MS, 'T2_API_TIMEOUT_MS', 20000),
    fetchLimit: parsePositiveInt(process.env.TELE2_POLL_FETCH_LIMIT, 'TELE2_POLL_FETCH_LIMIT', 30),
    replayFetchLimit: parsePositiveInt(process.env.TELE2_POLL_REPLAY_FETCH_LIMIT, 'TELE2_POLL_REPLAY_FETCH_LIMIT', 500),
    processUrl: DEFAULT_PROCESS_URL
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg.startsWith('--date=')) {
      parsed.date = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--date') {
      parsed.date = args.shift() || '';
      continue;
    }

    if (arg.startsWith('--timezone=')) {
      parsed.timeZone = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--timezone') {
      parsed.timeZone = args.shift() || parsed.timeZone;
      continue;
    }

    if (arg.startsWith('--reasons=')) {
      parsed.reasons = parseCsvList(arg.split('=').slice(1).join('='));
      continue;
    }

    if (arg === '--reasons') {
      parsed.reasons = parseCsvList(args.shift());
      continue;
    }

    if (arg.startsWith('--statuses=')) {
      parsed.statuses = parseCsvList(arg.split('=').slice(1).join('=')).map((item) => item.toLowerCase());
      continue;
    }

    if (arg === '--statuses') {
      parsed.statuses = parseCsvList(args.shift()).map((item) => item.toLowerCase());
      continue;
    }

    if (arg.startsWith('--limit=')) {
      parsed.limit = parsePositiveInt(arg.split('=').slice(1).join('='), 'limit', parsed.limit);
      continue;
    }

    if (arg === '--limit') {
      parsed.limit = parsePositiveInt(args.shift(), 'limit', parsed.limit);
      continue;
    }

    if (arg.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = parsePositiveInt(arg.split('=').slice(1).join('='), 'timeout-ms', parsed.timeoutMs);
      continue;
    }

    if (arg === '--timeout-ms') {
      parsed.timeoutMs = parsePositiveInt(args.shift(), 'timeout-ms', parsed.timeoutMs);
      continue;
    }

    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (arg === '--no-dry-run') {
      parsed.dryRun = false;
      continue;
    }

    if (arg.startsWith('--process-url=')) {
      parsed.processUrl = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--process-url') {
      parsed.processUrl = args.shift() || parsed.processUrl;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function validateConfig(rawConfig) {
  const date = isNonEmptyString(rawConfig.date)
    ? rawConfig.date.trim()
    : getTodayDateInTimeZone(rawConfig.timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must be in YYYY-MM-DD format');
  }

  const reasons = rawConfig.reasons.length > 0
    ? rawConfig.reasons
    : [...DEFAULT_REASONS];
  const statuses = rawConfig.statuses.length > 0
    ? rawConfig.statuses
    : [...DEFAULT_STATUSES];

  return {
    ...rawConfig,
    date,
    reasons,
    statuses,
    processUrl: isNonEmptyString(rawConfig.processUrl)
      ? rawConfig.processUrl.trim()
      : DEFAULT_PROCESS_URL
  };
}

function printHelp() {
  process.stdout.write(`
Replay recoverable Tele2 records

Usage:
  node src/scripts/replayRecoverableTele2Records.js [options]

Options:
  --date YYYY-MM-DD         Replay day (default: today in --timezone)
  --timezone <IANA>         Timezone for default date (default: APP_TIMEZONE/Europe/Moscow)
  --reasons <csv>           Error codes (default: ${DEFAULT_REASONS.join(',')})
  --statuses <csv>          tele2_polled_records statuses (default: ${DEFAULT_STATUSES.join(',')})
  --limit <int>             Max records to replay (default: 20)
  --timeout-ms <int>        Poll command timeout
  --process-url <url>       process-call endpoint for replay worker (default: ${DEFAULT_PROCESS_URL})
  --dry-run                 Print candidates only
  --no-dry-run              Execute replay (default)
  --help                    Show this help
`);
}

async function loadReplayCandidates(pool, config) {
  const result = await pool.query(
    `
    SELECT
      record_file_name,
      status,
      attempts,
      COALESCE(last_error_code, '') AS last_error_code,
      COALESCE(last_error_message, '') AS last_error_message,
      last_seen_at
    FROM tele2_polled_records
    WHERE record_file_name LIKE $1
      AND status = ANY($2::text[])
      AND COALESCE(last_error_code, '') = ANY($3::text[])
    ORDER BY last_seen_at DESC
    LIMIT $4
    `,
    [`${config.date}/%`, config.statuses, config.reasons, config.limit]
  );

  return result.rows;
}

function runReplayForRecord(config, recordFileName) {
  const pollScriptPath = path.resolve(__dirname, 'pollTele2RecordsOnce.js');
  const args = [
    pollScriptPath,
    '--record-file-name', recordFileName,
    '--no-dry-run',
    '--retry-failed',
    '--retry-skipped-error-codes', config.reasons.join(','),
    '--timeout-ms', String(config.timeoutMs),
    '--fetch-limit', String(config.fetchLimit),
    '--replay-fetch-limit', String(config.replayFetchLimit),
    '--process-url', config.processUrl,
    '--max-candidates', '1'
  ];

  const run = spawnSync(process.execPath, args, {
    env: process.env,
    encoding: 'utf8'
  });

  return {
    ok: run.status === 0,
    exitCode: Number.isInteger(run.status) ? run.status : 1,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    finishedStats: extractPollFinishedStats(run.stdout || '')
  };
}

function extractPollFinishedStats(rawOutput) {
  if (!isNonEmptyString(rawOutput)) {
    return null;
  }

  const lines = rawOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (parsed?.message === 'tele2_poll_once_finished' && parsed?.stats && typeof parsed.stats === 'object') {
        return parsed.stats;
      }
    } catch (error) {
      // ignore non-json log lines
    }
  }

  return null;
}

async function loadRecordState(pool, recordFileName) {
  const result = await pool.query(
    `
    SELECT
      record_file_name,
      status,
      attempts,
      COALESCE(last_error_code, '') AS last_error_code,
      COALESCE(last_error_message, '') AS last_error_message,
      updated_at
    FROM tele2_polled_records
    WHERE record_file_name = $1
    LIMIT 1
    `,
    [recordFileName]
  );

  return result.rows[0] || null;
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.help) {
    printHelp();
    return;
  }

  const config = validateConfig(raw);
  const appConfig = loadConfig({ validateRuntimeSecrets: false });
  const pool = createPgPool(appConfig.database);

  try {
    const candidates = await loadReplayCandidates(pool, config);
    if (config.dryRun) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        mode: 'dry-run',
        date: config.date,
        reasons: config.reasons,
        statuses: config.statuses,
        candidates
      }, null, 2)}\n`);
      return;
    }

    const results = [];
    for (const candidate of candidates) {
      const replayResult = runReplayForRecord(config, candidate.record_file_name);
      const afterState = await loadRecordState(pool, candidate.record_file_name);
      const failedInRun = Number.isInteger(replayResult.finishedStats?.failed)
        ? replayResult.finishedStats.failed
        : null;
      const unresolvedStatus = afterState?.status === 'failed' || afterState?.status === 'skipped';
      const effectiveOk = replayResult.ok &&
        !(Number.isInteger(failedInRun) && failedInRun > 0) &&
        !unresolvedStatus;
      results.push({
        recordFileName: candidate.record_file_name,
        beforeStatus: candidate.status,
        beforeErrorCode: candidate.last_error_code,
        exitCode: replayResult.exitCode,
        ok: effectiveOk,
        pollStats: replayResult.finishedStats,
        afterStatus: afterState?.status || '',
        afterErrorCode: afterState?.last_error_code || '',
        afterAttempts: Number.isInteger(afterState?.attempts) ? afterState.attempts : null,
        recovered: afterState?.status === 'processed',
        stdoutPreview: replayResult.stdout.slice(0, 800),
        stderrPreview: replayResult.stderr.slice(0, 800)
      });
    }

    const success = results.filter((item) => item.ok).length;
    const failed = results.length - success;

    process.stdout.write(`${JSON.stringify({
      ok: failed === 0,
      mode: 'execute',
      date: config.date,
      reasons: config.reasons,
      statuses: config.statuses,
      attempted: results.length,
      success,
      failed,
      results
    }, null, 2)}\n`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error?.message || 'Unknown error'
  }, null, 2)}\n`);
  process.exit(1);
});
