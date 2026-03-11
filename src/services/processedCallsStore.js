const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR_PATH = path.resolve(__dirname, '../../data');
const STORE_FILE_PATH = path.resolve(DATA_DIR_PATH, 'processed-calls.json');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function buildCallFingerprint({ phone, callDateTime, transcript }) {
  const normalizedPhone = isNonEmptyString(phone) ? phone.trim() : '';
  const normalizedCallDateTime = isNonEmptyString(callDateTime) ? callDateTime.trim() : '';
  const normalizedTranscript = isNonEmptyString(transcript) ? transcript.trim() : '';
  const fingerprintSource = `${normalizedPhone}|${normalizedCallDateTime}|${normalizedTranscript}`;

  return crypto.createHash('sha256').update(fingerprintSource, 'utf8').digest('hex');
}

async function ensureStoreFile() {
  await fs.mkdir(DATA_DIR_PATH, { recursive: true });

  try {
    await fs.access(STORE_FILE_PATH);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      await fs.writeFile(STORE_FILE_PATH, '[]\n', 'utf8');
      return;
    }

    throw error;
  }
}

async function readStore() {
  await ensureStoreFile();
  const raw = await fs.readFile(STORE_FILE_PATH, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Processed calls store has invalid JSON: ${STORE_FILE_PATH}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Processed calls store must contain a JSON array: ${STORE_FILE_PATH}`);
  }

  return parsed;
}

async function hasProcessedCall({ phone, callDateTime, transcript }) {
  const fingerprint = buildCallFingerprint({ phone, callDateTime, transcript });
  const records = await readStore();

  return records.some((record) => record && record.fingerprint === fingerprint);
}

async function saveProcessedCall({ phone, callDateTime, transcript }) {
  const normalizedPhone = isNonEmptyString(phone) ? phone.trim() : '';
  const normalizedCallDateTime = isNonEmptyString(callDateTime) ? callDateTime.trim() : '';
  const fingerprint = buildCallFingerprint({
    phone: normalizedPhone,
    callDateTime: normalizedCallDateTime,
    transcript
  });
  const records = await readStore();

  if (records.some((record) => record && record.fingerprint === fingerprint)) {
    return false;
  }

  records.push({
    fingerprint,
    phone: normalizedPhone,
    callDateTime: normalizedCallDateTime,
    createdAt: new Date().toISOString()
  });

  await fs.writeFile(STORE_FILE_PATH, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  return true;
}

module.exports = {
  isNonEmptyString,
  buildCallFingerprint,
  ensureStoreFile,
  readStore,
  hasProcessedCall,
  saveProcessedCall
};
