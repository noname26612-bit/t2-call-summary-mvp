#!/usr/bin/env node

const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createPgPool } = require('../db/createPgPool');
const { normalizePhone } = require('../utils/ignoredPhones');

dotenv.config();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseBoolean(rawValue, fallbackValue) {
  if (!isNonEmptyString(rawValue)) {
    return fallbackValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${rawValue}`);
}

function normalizeRequiredPhone(rawPhone) {
  const normalized = normalizePhone(isNonEmptyString(rawPhone) ? rawPhone.trim() : '');
  if (!isNonEmptyString(normalized)) {
    throw new Error('phone is required and must be normalizable');
  }

  return normalized;
}

function normalizeOptionalText(rawValue) {
  if (!isNonEmptyString(rawValue)) {
    return '';
  }

  return rawValue.trim();
}

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    command: '',
    phone: '',
    name: '',
    title: '',
    notes: '',
    active: true
  };

  while (args.length > 0) {
    const token = args.shift();

    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }

    if (!token.startsWith('--') && !parsed.command) {
      parsed.command = token.trim();
      continue;
    }

    if (token.startsWith('--phone=')) {
      parsed.phone = token.split('=').slice(1).join('=');
      continue;
    }

    if (token === '--phone') {
      parsed.phone = args.shift() || '';
      continue;
    }

    if (token.startsWith('--name=')) {
      parsed.name = token.split('=').slice(1).join('=');
      continue;
    }

    if (token === '--name') {
      parsed.name = args.shift() || '';
      continue;
    }

    if (token.startsWith('--title=')) {
      parsed.title = token.split('=').slice(1).join('=');
      continue;
    }

    if (token === '--title') {
      parsed.title = args.shift() || '';
      continue;
    }

    if (token.startsWith('--notes=')) {
      parsed.notes = token.split('=').slice(1).join('=');
      continue;
    }

    if (token === '--notes') {
      parsed.notes = args.shift() || '';
      continue;
    }

    if (token.startsWith('--active=')) {
      parsed.active = parseBoolean(token.split('=').slice(1).join('='), parsed.active);
      continue;
    }

    if (token === '--active') {
      parsed.active = parseBoolean(args.shift(), parsed.active);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function printHelp() {
  const text = [
    'Usage:',
    '  node src/scripts/adminEmployeeDirectory.js upsert --phone "+79991234567" --name "Имя" --title "роль" [--notes "..."] [--active true|false]',
    '  node src/scripts/adminEmployeeDirectory.js deactivate --phone "+79991234567" [--notes "deactivated"]',
    '  node src/scripts/adminEmployeeDirectory.js lookup --phone "+79991234567"',
    '',
    'Commands:',
    '  upsert      Add or update employee record by normalized phone',
    '  deactivate  Mark record inactive by phone',
    '  lookup      Return ACTIVE lookup result by phone (used by runtime flow)'
  ].join('\n');

  process.stdout.write(`${text}\n`);
}

function normalizeRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number.isSafeInteger(Number(row.id)) ? Number(row.id) : null,
    phoneNormalized: row.phone_normalized,
    employeeName: row.employee_name,
    employeeTitle: row.employee_title,
    isActive: row.is_active === true,
    notes: isNonEmptyString(row.notes) ? row.notes : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function upsertEmployee(pool, options) {
  const phoneNormalized = normalizeRequiredPhone(options.phone);
  const employeeName = normalizeOptionalText(options.name);
  const employeeTitle = normalizeOptionalText(options.title);

  if (!employeeName || !employeeTitle) {
    throw new Error('upsert requires non-empty --name and --title');
  }

  const result = await pool.query(
    `
    INSERT INTO employee_phone_directory (
      phone_normalized,
      employee_name,
      employee_title,
      is_active,
      notes
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone_normalized)
    DO UPDATE SET
      employee_name = EXCLUDED.employee_name,
      employee_title = EXCLUDED.employee_title,
      is_active = EXCLUDED.is_active,
      notes = EXCLUDED.notes,
      updated_at = NOW()
    RETURNING id, phone_normalized, employee_name, employee_title, is_active, notes, created_at, updated_at
    `,
    [phoneNormalized, employeeName, employeeTitle, options.active === true, normalizeOptionalText(options.notes)]
  );

  return normalizeRecord(result.rows[0]);
}

async function deactivateEmployee(pool, options) {
  const phoneNormalized = normalizeRequiredPhone(options.phone);
  const notes = normalizeOptionalText(options.notes);

  const result = await pool.query(
    `
    UPDATE employee_phone_directory
    SET is_active = FALSE,
        notes = CASE WHEN $2 <> '' THEN $2 ELSE notes END,
        updated_at = NOW()
    WHERE phone_normalized = $1
    RETURNING id, phone_normalized, employee_name, employee_title, is_active, notes, created_at, updated_at
    `,
    [phoneNormalized, notes]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return normalizeRecord(result.rows[0]);
}

async function lookupActiveEmployee(pool, options) {
  const phoneNormalized = normalizeRequiredPhone(options.phone);

  const result = await pool.query(
    `
    SELECT id, phone_normalized, employee_name, employee_title, is_active, notes, created_at, updated_at
    FROM employee_phone_directory
    WHERE phone_normalized = $1
      AND is_active = TRUE
    LIMIT 1
    `,
    [phoneNormalized]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return normalizeRecord(result.rows[0]);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help || !parsed.command) {
    printHelp();
    process.exit(parsed.help ? 0 : 1);
  }

  const config = loadConfig({ validateRuntimeSecrets: false });
  const pool = createPgPool(config.database);

  try {
    if (parsed.command === 'upsert') {
      const record = await upsertEmployee(pool, parsed);
      process.stdout.write(`${JSON.stringify({ ok: true, command: 'upsert', record }, null, 2)}\n`);
      return;
    }

    if (parsed.command === 'deactivate') {
      const record = await deactivateEmployee(pool, parsed);
      if (!record) {
        process.stdout.write(`${JSON.stringify({ ok: true, command: 'deactivate', record: null, message: 'not_found' }, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${JSON.stringify({ ok: true, command: 'deactivate', record }, null, 2)}\n`);
      return;
    }

    if (parsed.command === 'lookup') {
      const record = await lookupActiveEmployee(pool, parsed);
      process.stdout.write(`${JSON.stringify({ ok: true, command: 'lookup', record }, null, 2)}\n`);
      return;
    }

    throw new Error(`Unsupported command: ${parsed.command}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
