#!/usr/bin/env node

const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createPgPool } = require('../db/createPgPool');

dotenv.config();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parsePositiveInt(value, fallback) {
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

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    hours: 24,
    source: ''
  };

  while (args.length > 0) {
    const token = args.shift();

    if (token === '--help' || token === '-h') {
      process.stdout.write(
        [
          'Usage:',
          '  node src/scripts/reportAiUsageCost.js [--hours 24] [--source tele2_poll_once]',
          '',
          'Examples:',
          '  node src/scripts/reportAiUsageCost.js',
          '  node src/scripts/reportAiUsageCost.js --hours 72',
          '  node src/scripts/reportAiUsageCost.js --hours 24 --source tele2_poll_once'
        ].join('\n') + '\n'
      );
      process.exit(0);
    }

    if (token.startsWith('--hours=')) {
      parsed.hours = parsePositiveInt(token.split('=').slice(1).join('='), parsed.hours);
      continue;
    }

    if (token === '--hours') {
      parsed.hours = parsePositiveInt(args.shift(), parsed.hours);
      continue;
    }

    if (token.startsWith('--source=')) {
      parsed.source = token.split('=').slice(1).join('=').trim();
      continue;
    }

    if (token === '--source') {
      parsed.source = (args.shift() || '').trim();
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function toPrintable(value, fallback = '-') {
  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value);
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function formatPercent(part, total) {
  const totalNum = toNumber(total, 0);
  if (totalNum <= 0) {
    return '0.00%';
  }

  const partNum = toNumber(part, 0);
  return `${((partNum / totalNum) * 100).toFixed(2)}%`;
}

function buildSourceFilterSql({ hasSourceFilter, sourceParamIndex, expressionSql }) {
  if (!hasSourceFilter) {
    return '';
  }

  return `AND (${expressionSql} = $${sourceParamIndex} OR ($${sourceParamIndex} = 'tele2_poll_once' AND COALESCE(NULLIF(BTRIM(aua.x_request_id), ''), '') LIKE 'tele2-poll-%'))`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ validateRuntimeSecrets: false });
  const pool = createPgPool(config.database);

  const hasSourceFilter = isNonEmptyString(args.source);
  const params = [args.hours];

  if (hasSourceFilter) {
    params.push(args.source.trim());
  }

  const sourceParamIndex = hasSourceFilter ? params.length : null;

  const processedSourceFilterSql = hasSourceFilter
    ? `AND ce.source = $${sourceParamIndex}`
    : '';

  const usageSourceFilterSql = buildSourceFilterSql({
    hasSourceFilter,
    sourceParamIndex,
    expressionSql: `COALESCE(ce.source, source_lookup.source, '')`
  });

  const perCallCte = `
    WITH processed_calls AS (
      SELECT
        ce.id AS call_event_id,
        ce.created_at::date AS day,
        COALESCE(
          NULLIF(BTRIM((
            SELECT aua.x_request_id
            FROM ai_usage_audit aua
            WHERE aua.call_event_id = ce.id
              AND aua.x_request_id IS NOT NULL
              AND BTRIM(aua.x_request_id) <> ''
            ORDER BY aua.id DESC
            LIMIT 1
          )), ''),
          ''
        ) AS x_request_id
      FROM call_events ce
      WHERE ce.status = 'processed'
        AND ce.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
        ${processedSourceFilterSql}
    ),
    ai_rows AS (
      SELECT DISTINCT
        aua.id,
        pc.call_event_id,
        pc.day,
        aua.operation,
        aua.response_status,
        aua.total_tokens,
        aua.estimated_cost_rub
      FROM processed_calls pc
      JOIN ai_usage_audit aua
        ON aua.call_event_id = pc.call_event_id
        OR (
          pc.x_request_id <> ''
          AND aua.x_request_id = pc.x_request_id
        )
    ),
    per_call AS (
      SELECT
        call_event_id,
        day,
        COUNT(*) FILTER (WHERE response_status <> 'skipped') AS ai_invocations_non_skipped,
        COUNT(*) AS ai_invocations_total,
        COALESCE(SUM(total_tokens), 0) AS total_tokens_sum,
        COALESCE(SUM(estimated_cost_rub), 0)::numeric(14, 6) AS total_cost_rub
      FROM ai_rows
      GROUP BY call_event_id, day
    )
  `;

  try {
    const dailyRows = await pool.query(
      `
      ${perCallCte}
      SELECT
        day,
        COUNT(*) AS processed_calls,
        ROUND(AVG(total_cost_rub)::numeric, 6) AS avg_cost_rub,
        ROUND(AVG(total_tokens_sum)::numeric, 2) AS avg_tokens
      FROM per_call
      GROUP BY day
      ORDER BY day DESC
      `,
      params
    );

    const summaryRowResult = await pool.query(
      `
      ${perCallCte}
      SELECT
        COUNT(*) AS processed_calls,
        ROUND(AVG(total_cost_rub)::numeric, 6) AS avg_cost_rub,
        ROUND(AVG(total_tokens_sum)::numeric, 2) AS avg_tokens,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_tokens_sum)::numeric, 2) AS p50_total_tokens,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_tokens_sum)::numeric, 2) AS p95_total_tokens,
        COUNT(*) FILTER (WHERE ai_invocations_non_skipped > 1) AS calls_with_gt1_ai_invocation
      FROM per_call
      `,
      params
    );

    const skipRows = await pool.query(
      `
      WITH scoped AS (
        SELECT
          aua.id,
          COALESCE(NULLIF(BTRIM(aua.skip_reason), ''), 'unknown') AS skip_reason,
          CASE
            WHEN COALESCE(NULLIF(BTRIM(aua.skip_reason), ''), '') LIKE 'skipped_before_transcribe:%' THEN 'skipped_before_transcribe'
            WHEN COALESCE(NULLIF(BTRIM(aua.skip_reason), ''), '') LIKE 'skipped_before_analyze:%' THEN 'skipped_before_analyze'
            ELSE 'skipped_other'
          END AS skip_stage,
          COALESCE(
            NULLIF(BTRIM(aua.x_request_id), ''),
            NULLIF(BTRIM(aua.call_id), ''),
            CASE
              WHEN aua.call_event_id IS NOT NULL THEN CONCAT('call_event:', aua.call_event_id::text)
              ELSE CONCAT('row:', aua.id::text)
            END
          ) AS call_key
        FROM ai_usage_audit aua
        LEFT JOIN call_events ce
          ON ce.id = aua.call_event_id
        LEFT JOIN LATERAL (
          SELECT ce2.source
          FROM ai_usage_audit aua2
          JOIN call_events ce2
            ON ce2.id = aua2.call_event_id
          WHERE aua2.x_request_id = aua.x_request_id
          ORDER BY aua2.id DESC
          LIMIT 1
        ) source_lookup ON TRUE
        WHERE aua.response_status = 'skipped'
          AND aua.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
          ${usageSourceFilterSql}
      )
      SELECT
        skip_stage,
        skip_reason,
        COUNT(DISTINCT call_key) AS skipped_calls
      FROM scoped
      GROUP BY skip_stage, skip_reason
      ORDER BY skipped_calls DESC, skip_reason ASC
      `,
      params
    );

    const pathMixRows = await pool.query(
      `
      WITH scoped AS (
        SELECT
          aua.id,
          COALESCE(
            NULLIF(BTRIM(aua.x_request_id), ''),
            NULLIF(BTRIM(aua.call_id), ''),
            CASE
              WHEN aua.call_event_id IS NOT NULL THEN CONCAT('call_event:', aua.call_event_id::text)
              ELSE CONCAT('row:', aua.id::text)
            END
          ) AS call_key,
          aua.operation,
          aua.response_status,
          COALESCE(NULLIF(BTRIM(aua.skip_reason), ''), '') AS skip_reason
        FROM ai_usage_audit aua
        LEFT JOIN call_events ce
          ON ce.id = aua.call_event_id
        LEFT JOIN LATERAL (
          SELECT ce2.source
          FROM ai_usage_audit aua2
          JOIN call_events ce2
            ON ce2.id = aua2.call_event_id
          WHERE aua2.x_request_id = aua.x_request_id
          ORDER BY aua2.id DESC
          LIMIT 1
        ) source_lookup ON TRUE
        WHERE aua.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
          ${usageSourceFilterSql}
      ),
      per_call AS (
        SELECT
          call_key,
          COUNT(*) FILTER (WHERE response_status IN ('success', 'failed')) AS ai_invocations_non_skipped,
          COUNT(*) FILTER (WHERE operation = 'transcribe' AND response_status IN ('success', 'failed')) AS transcribe_invocations,
          COUNT(*) FILTER (WHERE operation = 'analyze' AND response_status IN ('success', 'failed')) AS analyze_invocations,
          BOOL_OR(skip_reason LIKE 'skipped_before_transcribe:%') AS skipped_before_transcribe,
          BOOL_OR(skip_reason LIKE 'skipped_before_analyze:%') AS skipped_before_analyze
        FROM scoped
        GROUP BY call_key
      )
      SELECT
        COUNT(*) AS observed_calls,
        COUNT(*) FILTER (WHERE skipped_before_transcribe) AS skipped_before_transcribe_calls,
        COUNT(*) FILTER (WHERE skipped_before_analyze) AS skipped_before_analyze_calls,
        COUNT(*) FILTER (WHERE ai_invocations_non_skipped = 0) AS calls_with_zero_ai,
        COUNT(*) FILTER (WHERE transcribe_invocations > 0 AND analyze_invocations = 0) AS calls_with_transcribe_only,
        COUNT(*) FILTER (WHERE transcribe_invocations > 0 AND analyze_invocations > 0) AS calls_with_transcribe_and_analyze,
        COUNT(*) FILTER (WHERE transcribe_invocations = 0 AND analyze_invocations > 0) AS calls_with_analyze_only,
        COUNT(*) FILTER (WHERE ai_invocations_non_skipped > 0) AS calls_with_any_ai
      FROM per_call
      `,
      params
    );

    const costCoverageSummaryRows = await pool.query(
      `
      WITH scoped AS (
        SELECT
          aua.id,
          aua.operation,
          aua.response_status,
          aua.estimated_cost_rub
        FROM ai_usage_audit aua
        LEFT JOIN call_events ce
          ON ce.id = aua.call_event_id
        LEFT JOIN LATERAL (
          SELECT ce2.source
          FROM ai_usage_audit aua2
          JOIN call_events ce2
            ON ce2.id = aua2.call_event_id
          WHERE aua2.x_request_id = aua.x_request_id
          ORDER BY aua2.id DESC
          LIMIT 1
        ) source_lookup ON TRUE
        WHERE aua.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
          ${usageSourceFilterSql}
      )
      SELECT
        COUNT(*) FILTER (WHERE response_status IN ('success', 'failed')) AS invoked_rows,
        COUNT(*) FILTER (WHERE response_status IN ('success', 'failed') AND estimated_cost_rub IS NOT NULL) AS invoked_rows_with_cost,
        COUNT(*) FILTER (WHERE response_status IN ('success', 'failed') AND estimated_cost_rub IS NULL) AS invoked_rows_null_cost,
        COUNT(*) FILTER (
          WHERE operation = 'analyze'
            AND response_status IN ('success', 'failed')
            AND estimated_cost_rub IS NULL
        ) AS analyze_invoked_rows_null_cost,
        COUNT(*) FILTER (
          WHERE operation = 'transcribe'
            AND response_status IN ('success', 'failed')
            AND estimated_cost_rub IS NULL
        ) AS transcribe_invoked_rows_null_cost
      FROM scoped
      `,
      params
    );

    const costByOperationRows = await pool.query(
      `
      WITH scoped AS (
        SELECT
          aua.id,
          aua.operation,
          aua.response_status,
          aua.estimated_cost_rub
        FROM ai_usage_audit aua
        LEFT JOIN call_events ce
          ON ce.id = aua.call_event_id
        LEFT JOIN LATERAL (
          SELECT ce2.source
          FROM ai_usage_audit aua2
          JOIN call_events ce2
            ON ce2.id = aua2.call_event_id
          WHERE aua2.x_request_id = aua.x_request_id
          ORDER BY aua2.id DESC
          LIMIT 1
        ) source_lookup ON TRUE
        WHERE aua.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
          ${usageSourceFilterSql}
      )
      SELECT
        operation,
        response_status,
        COUNT(*) AS rows_count,
        COUNT(*) FILTER (WHERE estimated_cost_rub IS NOT NULL) AS rows_with_cost,
        COUNT(*) FILTER (WHERE estimated_cost_rub IS NULL) AS rows_with_null_cost,
        ROUND(COALESCE(SUM(estimated_cost_rub), 0)::numeric, 6) AS total_estimated_cost_rub,
        ROUND(AVG(estimated_cost_rub)::numeric, 6) AS avg_estimated_cost_rub_non_null
      FROM scoped
      GROUP BY operation, response_status
      ORDER BY operation ASC, response_status ASC
      `,
      params
    );

    const operationRows = await pool.query(
      `
      ${perCallCte}
      SELECT
        operation,
        response_status,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE estimated_cost_rub IS NOT NULL) AS rows_with_cost,
        COUNT(*) FILTER (WHERE estimated_cost_rub IS NULL) AS rows_with_null_cost,
        ROUND(COALESCE(SUM(estimated_cost_rub), 0)::numeric, 6) AS total_estimated_cost_rub,
        ROUND(AVG(estimated_cost_rub)::numeric, 6) AS avg_estimated_cost_rub_non_null
      FROM ai_rows
      GROUP BY operation, response_status
      ORDER BY operation ASC, response_status ASC
      `,
      params
    );

    const summary = summaryRowResult.rows[0] || {};
    const pathMix = pathMixRows.rows[0] || {};
    const costCoverageSummary = costCoverageSummaryRows.rows[0] || {};
    const observedCalls = toNumber(pathMix.observed_calls, 0);
    const invokedRows = toNumber(costCoverageSummary.invoked_rows, 0);

    process.stdout.write(
      [
        'AI usage cost observability report',
        `generated_at: ${new Date().toISOString()}`,
        `window_hours: ${args.hours}`,
        `source_filter: ${hasSourceFilter ? args.source : 'ALL'}`,
        '',
        'Processed-call cost overview:',
        `processed_calls: ${toPrintable(summary.processed_calls, '0')}`,
        `avg_cost_rub_per_processed_call: ${toPrintable(summary.avg_cost_rub, '0')}`,
        `avg_tokens_per_processed_call: ${toPrintable(summary.avg_tokens, '0')}`,
        `p50_total_tokens: ${toPrintable(summary.p50_total_tokens, '0')}`,
        `p95_total_tokens: ${toPrintable(summary.p95_total_tokens, '0')}`,
        `calls_with_gt1_ai_invocation: ${toPrintable(summary.calls_with_gt1_ai_invocation, '0')}`,
        '',
        'Call path mix (ai_usage_audit scope):',
        `observed_calls: ${toPrintable(pathMix.observed_calls, '0')}`,
        `skipped_before_transcribe_calls: ${toPrintable(pathMix.skipped_before_transcribe_calls, '0')}`,
        `skipped_before_analyze_calls: ${toPrintable(pathMix.skipped_before_analyze_calls, '0')}`,
        `calls_with_zero_ai: ${toPrintable(pathMix.calls_with_zero_ai, '0')} (${formatPercent(pathMix.calls_with_zero_ai, observedCalls)})`,
        `calls_with_transcribe_only: ${toPrintable(pathMix.calls_with_transcribe_only, '0')} (${formatPercent(pathMix.calls_with_transcribe_only, observedCalls)})`,
        `calls_with_transcribe_and_analyze: ${toPrintable(pathMix.calls_with_transcribe_and_analyze, '0')} (${formatPercent(pathMix.calls_with_transcribe_and_analyze, observedCalls)})`,
        `calls_with_analyze_only: ${toPrintable(pathMix.calls_with_analyze_only, '0')} (${formatPercent(pathMix.calls_with_analyze_only, observedCalls)})`,
        '',
        'Cost coverage (invoked AI rows):',
        `invoked_rows: ${toPrintable(costCoverageSummary.invoked_rows, '0')}`,
        `invoked_rows_with_cost: ${toPrintable(costCoverageSummary.invoked_rows_with_cost, '0')} (${formatPercent(costCoverageSummary.invoked_rows_with_cost, invokedRows)})`,
        `invoked_rows_with_null_cost: ${toPrintable(costCoverageSummary.invoked_rows_null_cost, '0')} (${formatPercent(costCoverageSummary.invoked_rows_null_cost, invokedRows)})`,
        `analyze_invoked_rows_null_cost: ${toPrintable(costCoverageSummary.analyze_invoked_rows_null_cost, '0')}`,
        `transcribe_invoked_rows_null_cost: ${toPrintable(costCoverageSummary.transcribe_invoked_rows_null_cost, '0')}`,
        '',
        'Daily averages (processed calls):',
        'day\tprocessed_calls\tavg_cost_rub\tavg_tokens'
      ].join('\n') + '\n'
    );

    for (const row of dailyRows.rows || []) {
      process.stdout.write(
        `${toPrintable(row.day)}\t${toPrintable(row.processed_calls, '0')}\t${toPrintable(row.avg_cost_rub, '0')}\t${toPrintable(row.avg_tokens, '0')}\n`
      );
    }

    process.stdout.write('\nSkipped calls by reason:\n');
    process.stdout.write('skip_stage\tskip_reason\tskipped_calls\n');
    for (const row of skipRows.rows || []) {
      process.stdout.write(
        `${toPrintable(row.skip_stage)}\t${toPrintable(row.skip_reason)}\t${toPrintable(row.skipped_calls, '0')}\n`
      );
    }

    process.stdout.write('\nAI invocation breakdown (processed calls correlation scope):\n');
    process.stdout.write(
      'operation\tresponse_status\tcount\trows_with_cost\trows_with_null_cost\ttotal_estimated_cost_rub\tavg_estimated_cost_rub_non_null\n'
    );
    for (const row of operationRows.rows || []) {
      process.stdout.write(
        `${toPrintable(row.operation)}\t${toPrintable(row.response_status)}\t${toPrintable(row.count, '0')}\t${toPrintable(row.rows_with_cost, '0')}\t${toPrintable(row.rows_with_null_cost, '0')}\t${toPrintable(row.total_estimated_cost_rub, '0')}\t${toPrintable(row.avg_estimated_cost_rub_non_null, '0')}\n`
      );
    }

    process.stdout.write('\nEstimated cost by operation (ai_usage_audit scope):\n');
    process.stdout.write(
      'operation\tresponse_status\trows_count\trows_with_cost\trows_with_null_cost\ttotal_estimated_cost_rub\tavg_estimated_cost_rub_non_null\n'
    );
    for (const row of costByOperationRows.rows || []) {
      process.stdout.write(
        `${toPrintable(row.operation)}\t${toPrintable(row.response_status)}\t${toPrintable(row.rows_count, '0')}\t${toPrintable(row.rows_with_cost, '0')}\t${toPrintable(row.rows_with_null_cost, '0')}\t${toPrintable(row.total_estimated_cost_rub, '0')}\t${toPrintable(row.avg_estimated_cost_rub_non_null, '0')}\n`
      );
    }
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
