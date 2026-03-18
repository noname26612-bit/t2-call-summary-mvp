#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const dotenv = require('dotenv');
const { createPgPool } = require('../db/createPgPool');
const { normalizeAndValidateAnalysis } = require('../services/analysisNormalizer');
const { formatTelegramCallSummary: formatTelegramCallSummaryNew } = require('../services/telegramMessageFormatter');
const { createOpenAIAnalyzer } = require('../../ai-gateway/src/openaiClient');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.join(ROOT, 'reports');
const MAX_CASES = 15;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function maskPhone(phoneRaw) {
  const digits = String(phoneRaw || '').replace(/\D/g, '');
  if (!digits) {
    return 'unknown';
  }

  const last4 = digits.slice(-4);
  return `***${last4}`;
}

function normalizePriorityToUrgency(priority) {
  const token = isNonEmptyString(priority) ? priority.trim().toLowerCase() : '';
  if (token === 'high') {
    return 'высокая';
  }

  if (token === 'medium') {
    return 'средняя';
  }

  return 'низкая';
}

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(envPath, 'utf8'));
}

function buildDbConfigFromEnv(parsedEnv) {
  return {
    host: parsedEnv.DB_HOST,
    port: Number(parsedEnv.DB_PORT),
    database: parsedEnv.DB_NAME,
    user: parsedEnv.DB_USER,
    password: parsedEnv.DB_PASSWORD,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    application_name: 'manual-acceptance-real-calls'
  };
}

function buildAnalyzerConfig(gatewayEnv) {
  const timeoutCandidate = Number(gatewayEnv.POLZA_TIMEOUT_MS);

  return {
    apiKey: gatewayEnv.POLZA_API_KEY,
    baseUrl: isNonEmptyString(gatewayEnv.POLZA_BASE_URL)
      ? gatewayEnv.POLZA_BASE_URL.trim()
      : undefined,
    model: isNonEmptyString(gatewayEnv.POLZA_MODEL)
      ? gatewayEnv.POLZA_MODEL.trim()
      : 'gpt-4.1-mini',
    transcribeModel: isNonEmptyString(gatewayEnv.POLZA_TRANSCRIBE_MODEL)
      ? gatewayEnv.POLZA_TRANSCRIBE_MODEL.trim()
      : 'openai/gpt-4o-mini-transcribe',
    transcribeCandidateModel: isNonEmptyString(gatewayEnv.POLZA_TRANSCRIBE_MODEL_CANDIDATE)
      ? gatewayEnv.POLZA_TRANSCRIBE_MODEL_CANDIDATE.trim()
      : '',
    timeoutMs: Number.isFinite(timeoutCandidate) && timeoutCandidate > 0 ? timeoutCandidate : 40000
  };
}

function loadOldFormatterFromHead() {
  return loadFormatterFromGitRef('HEAD');
}

function loadFormatterFromGitRef(gitRef) {
  const formatterPath = path.resolve(__dirname, '../services/telegramMessageFormatter.js');
  const headCode = require('child_process')
    .execSync(`git show ${gitRef}:src/services/telegramMessageFormatter.js`, {
      cwd: ROOT,
      encoding: 'utf8'
    });

  const module = { exports: {} };
  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${headCode}\n})`;
  const script = new vm.Script(wrapped, { filename: 'telegramMessageFormatter.head.js' });
  const fn = script.runInThisContext();
  const localRequire = require('module').createRequire(formatterPath);
  fn(module.exports, localRequire, module, formatterPath, path.dirname(formatterPath));

  if (typeof module.exports.formatTelegramCallSummary !== 'function') {
    throw new Error('Cannot load old formatter from HEAD');
  }

  return module.exports.formatTelegramCallSummary;
}

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    baselineRef: process.env.ACCEPTANCE_BASELINE_REF || 'origin/main'
  };

  while (args.length > 0) {
    const token = args.shift();

    if (token.startsWith('--baseline-ref=')) {
      parsed.baselineRef = token.split('=').slice(1).join('=').trim() || parsed.baselineRef;
      continue;
    }

    if (token === '--baseline-ref') {
      const nextToken = args.shift();
      if (isNonEmptyString(nextToken)) {
        parsed.baselineRef = nextToken.trim();
      }
      continue;
    }

    if (token === '--help' || token === '-h') {
      process.stdout.write(
        'Usage: node src/scripts/manualAcceptanceRealCalls.js [--baseline-ref origin/main]\n'
      );
      process.exit(0);
    }
  }

  return parsed;
}

function scoreSummaryPair({ oldMessage, newMessage, analysis }) {
  const oldText = String(oldMessage || '');
  const newText = String(newMessage || '');
  const oldFeatures = [
    'Суть запроса:',
    'Ответ сотрудника:',
    'Итог:',
    'Дальше:',
    'Прозвучал ответ:',
    'По разговору запрос:'
  ].filter((token) => oldText.includes(token)).length;
  const newFeatures = [
    'Суть запроса:',
    'Ответ сотрудника:',
    'Итог:',
    'Дальше:',
    'Прозвучал ответ:',
    'По разговору запрос:'
  ].filter((token) => newText.includes(token)).length;
  const lowConfidence = typeof analysis?.speakerRoleConfidence === 'number' && analysis.speakerRoleConfidence < 0.55;
  const cautiousInLowConfidence = !lowConfidence || !newText.includes('Итог по фактам: Клиент:');

  let verdict = 'same';
  if (newFeatures > oldFeatures) {
    verdict = 'improved';
  }

  if (!cautiousInLowConfidence) {
    verdict = 'risk';
  }

  return {
    verdict,
    oldFeatures,
    newFeatures,
    lowConfidence,
    cautiousInLowConfidence
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const dbEnvPath = path.join(ROOT, '.env.save');
  const gatewayEnvPath = path.join(ROOT, 'ai-gateway/.env');
  const dbEnv = loadEnvFile(dbEnvPath);
  const gatewayEnv = loadEnvFile(gatewayEnvPath);

  if (!isNonEmptyString(dbEnv.DB_HOST) || !isNonEmptyString(dbEnv.DB_NAME)) {
    throw new Error('Missing DB settings in .env.save; cannot run real-call acceptance batch');
  }

  if (!isNonEmptyString(gatewayEnv.POLZA_API_KEY)) {
    throw new Error('Missing POLZA_API_KEY in ai-gateway/.env; cannot run AI acceptance batch');
  }

  const pool = createPgPool(buildDbConfigFromEnv(dbEnv));
  const analyzeCall = createOpenAIAnalyzer(buildAnalyzerConfig(gatewayEnv), createNoopLogger());
  const formatTelegramCallSummaryOld = loadFormatterFromGitRef(args.baselineRef);

  const rowsResult = await pool.query(
    `
    SELECT
      ce.id,
      ce.status,
      ce.phone_raw,
      ce.call_datetime_raw,
      COALESCE(NULLIF(BTRIM(ce.transcript_text), ''), NULLIF(BTRIM(ce.transcript_preview), '')) AS transcript_source
    FROM call_events ce
    WHERE COALESCE(NULLIF(BTRIM(ce.transcript_text), ''), NULLIF(BTRIM(ce.transcript_preview), '')) IS NOT NULL
    ORDER BY ce.created_at DESC
    LIMIT $1
    `,
    [MAX_CASES]
  );

  await pool.end();

  const rows = rowsResult.rows;
  if (rows.length === 0) {
    throw new Error('No call rows with transcript/transcript_preview found for acceptance batch');
  }

  const cases = [];
  const failedCases = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const transcript = String(row.transcript_source || '').trim();
    if (!transcript) {
      continue;
    }

    try {
      const gatewayAnalysis = await analyzeCall({
        requestId: `manual-acceptance-${row.id}-${index + 1}`,
        phone: isNonEmptyString(row.phone_raw) ? row.phone_raw.trim() : '',
        callDateTime: isNonEmptyString(row.call_datetime_raw) ? row.call_datetime_raw.trim() : '',
        transcript
      });

      const normalizedMainAnalysis = normalizeAndValidateAnalysis({
        ...gatewayAnalysis,
        result: gatewayAnalysis.outcome,
        urgency: normalizePriorityToUrgency(gatewayAnalysis.priority)
      }, { transcript });

      const oldMessage = formatTelegramCallSummaryOld({
        phone: row.phone_raw,
        callDateTime: row.call_datetime_raw,
        analysis: normalizedMainAnalysis,
        timeZone: 'Europe/Moscow'
      });

      const newMessage = formatTelegramCallSummaryNew({
        phone: row.phone_raw,
        callDateTime: row.call_datetime_raw,
        analysis: normalizedMainAnalysis,
        timeZone: 'Europe/Moscow'
      });

      const score = scoreSummaryPair({
        oldMessage,
        newMessage,
        analysis: normalizedMainAnalysis
      });

      cases.push({
        index: index + 1,
        callEventId: row.id,
        status: row.status,
        phoneMasked: maskPhone(row.phone_raw),
        callDateTime: row.call_datetime_raw,
        transcript,
        analysis: {
          speakerRoleConfidence: normalizedMainAnalysis.speakerRoleConfidence,
          analysisWarnings: normalizedMainAnalysis.analysisWarnings || []
        },
        score,
        oldMessage,
        newMessage
      });
    } catch (error) {
      failedCases.push({
        index: index + 1,
        callEventId: row.id,
        status: row.status,
        phoneMasked: maskPhone(row.phone_raw),
        callDateTime: row.call_datetime_raw,
        error: error?.message || 'unknown_error'
      });
    }
  }

  const improved = cases.filter((item) => item.score.verdict === 'improved').length;
  const same = cases.filter((item) => item.score.verdict === 'same').length;
  const risk = cases.filter((item) => item.score.verdict === 'risk').length;

  await fsp.mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `manual-acceptance-real-calls-${new Date().toISOString().slice(0, 10)}.md`);

  const lines = [];
  lines.push('# Manual Acceptance (Old vs New Telegram Summary)');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Baseline ref: ${args.baselineRef}`);
  lines.push(`Cases analyzed: ${cases.length}`);
  lines.push(`Cases failed: ${failedCases.length}`);
  lines.push(`Verdict counters: improved=${improved}, same=${same}, risk=${risk}`);
  lines.push('');
  if (failedCases.length > 0) {
    lines.push('## Failed Cases');
    lines.push('');
    lines.push('| # | call_event_id | status | phone | error |');
    lines.push('|---|---:|---|---|---|');
    for (const item of failedCases) {
      lines.push(
        `| ${item.index} | ${item.callEventId} | ${item.status} | ${item.phoneMasked} | ${item.error.replaceAll('|', '/')} |`
      );
    }
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| # | call_event_id | status | phone | verdict | low_confidence | cautious_low_confidence |');
  lines.push('|---|---:|---|---|---|---|---|');
  for (const item of cases) {
    lines.push(
      `| ${item.index} | ${item.callEventId} | ${item.status} | ${item.phoneMasked} | ${item.score.verdict} | ${item.score.lowConfidence ? 'yes' : 'no'} | ${item.score.cautiousInLowConfidence ? 'yes' : 'no'} |`
    );
  }

  lines.push('');
  lines.push('## Details');
  for (const item of cases) {
    lines.push('');
    lines.push(`### Case ${item.index} (call_event_id=${item.callEventId}, status=${item.status})`);
    lines.push(`- phone: ${item.phoneMasked}`);
    lines.push(`- callDateTime: ${item.callDateTime}`);
    lines.push(`- speakerRoleConfidence: ${typeof item.analysis.speakerRoleConfidence === 'number' ? item.analysis.speakerRoleConfidence : 'n/a'}`);
    lines.push(`- warnings: ${item.analysis.analysisWarnings.length > 0 ? item.analysis.analysisWarnings.join('; ') : 'none'}`);
    lines.push(`- verdict: ${item.score.verdict}`);
    lines.push('');
    lines.push('Transcript input:');
    lines.push('```text');
    lines.push(item.transcript);
    lines.push('```');
    lines.push('Old summary:');
    lines.push('```text');
    lines.push(item.oldMessage);
    lines.push('```');
    lines.push('New summary:');
    lines.push('```text');
    lines.push(item.newMessage);
    lines.push('```');
  }

  await fsp.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');

  process.stdout.write(`Manual acceptance report created: ${reportPath}\n`);
  process.stdout.write(`Cases=${cases.length}; failed=${failedCases.length}; improved=${improved}; same=${same}; risk=${risk}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
