const REQUIRED_RUNTIME_ENV_VARS = [
  'OPENAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID'
];

function validateRuntimeEnv() {
  const missingVars = REQUIRED_RUNTIME_ENV_VARS.filter((name) => {
    const value = process.env[name];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
}

module.exports = {
  validateRuntimeEnv
};
