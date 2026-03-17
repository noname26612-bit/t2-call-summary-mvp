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

function normalizeCallType(rawValue) {
  const normalized = isNonEmptyString(rawValue) ? rawValue.trim().toUpperCase() : '';
  if (normalized === 'INCOMING' || normalized === 'INBOUND' || normalized === 'SINGLE_CHANNEL') {
    return 'INCOMING';
  }

  if (normalized === 'OUTGOING' || normalized === 'OUTBOUND') {
    return 'OUTGOING';
  }

  return '';
}

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    hours: 24,
    limit: 200,
    source: ''
  };

  while (args.length > 0) {
    const token = args.shift();

    if (token === '--help' || token === '-h') {
      process.stdout.write(
        [
          'Usage:',
          '  node src/scripts/reportCallMetaCoverage.js [--hours 24] [--limit 200] [--source tele2_poll_once]',
          '',
          'Examples:',
          '  node src/scripts/reportCallMetaCoverage.js',
          '  node src/scripts/reportCallMetaCoverage.js --hours 6 --limit 500',
          '  node src/scripts/reportCallMetaCoverage.js --hours 24 --source tele2_poll_once'
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

    if (token.startsWith('--limit=')) {
      parsed.limit = parsePositiveInt(token.split('=').slice(1).join('='), parsed.limit);
      continue;
    }

    if (token === '--limit') {
      parsed.limit = parsePositiveInt(args.shift(), parsed.limit);
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

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ validateRuntimeSecrets: false });
  const pool = createPgPool(config.database);

  try {
    const hasSourceFilter = isNonEmptyString(args.source);
    const params = [args.hours, args.limit];
    let sourceFilterSql = '';

    if (hasSourceFilter) {
      params.push(args.source.trim());
      sourceFilterSql = `AND ce.source = $${params.length}`;
    }

    const query = `
      SELECT
        ae.created_at AS audit_created_at,
        ce.id AS call_event_id,
        ce.source AS call_source,
        ce.status AS call_status,
        NULLIF(BTRIM(ae.payload->>'callType'), '') AS call_type_raw,
        NULLIF(BTRIM(ae.payload->>'employeePhone'), '') AS employee_phone,
        NULLIF(BTRIM(ae.payload->>'employeeId'), '') AS employee_id
      FROM audit_events ae
      JOIN call_events ce
        ON ce.id = ae.call_event_id
      WHERE ae.event_type = 'call_received'
        AND ae.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
        ${sourceFilterSql}
      ORDER BY ae.created_at DESC
      LIMIT $2::int
    `;

    const rowsResult = await pool.query(query, params);
    const rows = rowsResult.rows || [];

    const counters = {
      total: rows.length,
      withCallType: 0,
      withEmployeePhone: 0,
      withEmployeeId: 0,
      incoming: 0,
      outgoing: 0,
      unknownCallType: 0
    };

    for (const row of rows) {
      const callType = normalizeCallType(row.call_type_raw);
      const hasCallType = callType !== '';
      const hasEmployeePhone = isNonEmptyString(row.employee_phone);
      const hasEmployeeId = isNonEmptyString(row.employee_id);

      if (hasCallType) {
        counters.withCallType += 1;
      }

      if (hasEmployeePhone) {
        counters.withEmployeePhone += 1;
      }

      if (hasEmployeeId) {
        counters.withEmployeeId += 1;
      }

      if (callType === 'INCOMING') {
        counters.incoming += 1;
      } else if (callType === 'OUTGOING') {
        counters.outgoing += 1;
      } else {
        counters.unknownCallType += 1;
      }
    }

    const toPercent = (part) => {
      if (counters.total === 0) {
        return '0.0%';
      }

      return `${((part / counters.total) * 100).toFixed(1)}%`;
    };

    process.stdout.write(
      [
        'Call meta coverage report',
        `generated_at: ${new Date().toISOString()}`,
        `window_hours: ${args.hours}`,
        `limit: ${args.limit}`,
        `source_filter: ${hasSourceFilter ? args.source : 'ALL'}`,
        `total_events: ${counters.total}`,
        `with_call_type: ${counters.withCallType} (${toPercent(counters.withCallType)})`,
        `with_employee_phone: ${counters.withEmployeePhone} (${toPercent(counters.withEmployeePhone)})`,
        `with_employee_id: ${counters.withEmployeeId} (${toPercent(counters.withEmployeeId)})`,
        `call_type_incoming: ${counters.incoming} (${toPercent(counters.incoming)})`,
        `call_type_outgoing: ${counters.outgoing} (${toPercent(counters.outgoing)})`,
        `call_type_unknown: ${counters.unknownCallType} (${toPercent(counters.unknownCallType)})`,
        '',
        'Recent events (latest first):',
        '#\taudit_created_at\tcall_event_id\tsource\tstatus\tcall_type_raw\temployee_phone\temployee_id'
      ].join('\n') + '\n'
    );

    rows.slice(0, 30).forEach((row, index) => {
      process.stdout.write(
        `${index + 1}\t${row.audit_created_at?.toISOString?.() || row.audit_created_at || ''}\t${row.call_event_id}\t${row.call_source || ''}\t${row.call_status || ''}\t${row.call_type_raw || '-'}\t${row.employee_phone || '-'}\t${row.employee_id || '-'}\n`
      );
    });
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

