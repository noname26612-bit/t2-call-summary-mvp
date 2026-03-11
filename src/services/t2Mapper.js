function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function getFirstNonEmptyString(raw, keys) {
  for (const key of keys) {
    if (isNonEmptyString(raw[key])) {
      return raw[key].trim();
    }
  }

  return '';
}

function normalizeIncomingCallPayload(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      isValid: false,
      errors: [
        {
          field: 'payload',
          message: 'payload must be a JSON object'
        }
      ]
    };
  }

  const phone = getFirstNonEmptyString(raw, ['phone', 'caller', 'clientPhone']);
  const callDateTime = getFirstNonEmptyString(raw, [
    'callDateTime',
    'dateTime',
    'createdAt',
    'callStartTime'
  ]);
  const transcript = getFirstNonEmptyString(raw, ['transcript', 'text', 'transcription']);

  if (!isNonEmptyString(phone)) {
    errors.push({
      field: 'phone',
      message: 'phone is required (supported keys: phone, caller, clientPhone)'
    });
  }

  if (!isNonEmptyString(callDateTime)) {
    errors.push({
      field: 'callDateTime',
      message:
        'callDateTime is required (supported keys: callDateTime, dateTime, createdAt, callStartTime)'
    });
  }

  if (!isNonEmptyString(transcript)) {
    errors.push({
      field: 'transcript',
      message: 'transcript is required (supported keys: transcript, text, transcription)'
    });
  }

  if (errors.length > 0) {
    return {
      isValid: false,
      errors
    };
  }

  return {
    isValid: true,
    payload: {
      phone,
      callDateTime,
      transcript
    }
  };
}

module.exports = {
  normalizeIncomingCallPayload
};
