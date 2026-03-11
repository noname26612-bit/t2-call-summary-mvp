const fs = require('fs/promises');
const path = require('path');

const DATA_DIR_PATH = path.resolve(__dirname, '../../data');
const HISTORY_FILE_PATH = path.resolve(DATA_DIR_PATH, 'call-history.json');
let appendQueue = Promise.resolve();

async function ensureHistoryFile() {
  await fs.mkdir(DATA_DIR_PATH, { recursive: true });

  try {
    await fs.access(HISTORY_FILE_PATH);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      await fs.writeFile(HISTORY_FILE_PATH, '[]\n', 'utf8');
      return;
    }

    throw error;
  }
}

async function readCallHistory() {
  await ensureHistoryFile();

  const raw = await fs.readFile(HISTORY_FILE_PATH, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Call history store has invalid JSON: ${HISTORY_FILE_PATH}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Call history store must contain a JSON array: ${HISTORY_FILE_PATH}`);
  }

  return parsed;
}

async function appendCallHistory(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('call history record must be a JSON object');
  }

  const appendTask = async () => {
    const history = await readCallHistory();
    history.push(record);
    await fs.writeFile(HISTORY_FILE_PATH, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  };

  const runPromise = appendQueue.then(appendTask);

  // Keep queue alive after failures so next append calls are still serialized.
  appendQueue = runPromise.catch(() => {});

  return runPromise;
}

module.exports = {
  appendCallHistory,
  readCallHistory
};
