function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNonEmptyString(value) {
  if (isNonEmptyString(value)) {
    return value.trim();
  }

  return '';
}

function getValueByPath(raw, path) {
  if (!isPlainObject(raw) || !isNonEmptyString(path)) {
    return undefined;
  }

  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return undefined;
  }

  let current = raw;
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function uniquePaths(paths) {
  return Array.from(new Set(
    paths
      .filter((item) => isNonEmptyString(item))
      .map((item) => item.trim())
  ));
}

function extractStringField(raw, fallbackPath, configuredPath) {
  const fallbackPaths = Array.isArray(fallbackPath) ? fallbackPath : [fallbackPath];
  const candidatePaths = uniquePaths([configuredPath, ...fallbackPaths]);

  for (const path of candidatePaths) {
    const extracted = toNonEmptyString(getValueByPath(raw, path));
    if (isNonEmptyString(extracted)) {
      return {
        value: extracted,
        resolvedPath: path
      };
    }
  }

  return {
    value: '',
    resolvedPath: '',
    attemptedPaths: candidatePaths
  };
}

function extractOptionalField(raw, fallbackPath, configuredPath) {
  const fallbackPaths = Array.isArray(fallbackPath) ? fallbackPath : [fallbackPath];
  const candidatePaths = uniquePaths([configuredPath, ...fallbackPaths]);

  for (const path of candidatePaths) {
    const extracted = getValueByPath(raw, path);
    if (extracted !== undefined && extracted !== null && extracted !== '') {
      return {
        value: extracted,
        resolvedPath: path
      };
    }
  }

  return {
    value: null,
    resolvedPath: '',
    attemptedPaths: candidatePaths
  };
}

function normalizeDurationSec(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }

  if (!isNonEmptyString(value)) {
    return null;
  }

  const normalized = value.trim().replace(',', '.');
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    const parsed = Number.parseFloat(normalized);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }

  return null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  if (isNonEmptyString(value)) {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'да'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'n', 'нет'].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function buildMissingFieldError({ field, configuredPath, attemptedPaths }) {
  const configured = isNonEmptyString(configuredPath)
    ? `configured path "${configuredPath}"`
    : 'configured path is empty';
  const fallback = attemptedPaths.includes(field) ? `"${field}"` : 'no fallback';

  return {
    field,
    message: `${field} is required; ${configured}; fallback path ${fallback}`
  };
}

function normalizeIncomingCallPayload(raw, adapterConfig = {}) {
  if (!isPlainObject(raw)) {
    return {
      isValid: false,
      errors: [
        {
          field: 'payload',
          message: 'payload must be a JSON object'
        }
      ],
      adapterMeta: {
        topLevelKeys: []
      }
    };
  }

  const configuredPaths = {
    phone: isNonEmptyString(adapterConfig.phoneFieldPath) ? adapterConfig.phoneFieldPath.trim() : '',
    callDateTime: isNonEmptyString(adapterConfig.callDateTimeFieldPath)
      ? adapterConfig.callDateTimeFieldPath.trim()
      : '',
    transcript: isNonEmptyString(adapterConfig.transcriptFieldPath)
      ? adapterConfig.transcriptFieldPath.trim()
      : '',
    callType: isNonEmptyString(adapterConfig.callTypeFieldPath) ? adapterConfig.callTypeFieldPath.trim() : '',
    callerNumber: isNonEmptyString(adapterConfig.callerNumberFieldPath)
      ? adapterConfig.callerNumberFieldPath.trim()
      : '',
    calleeNumber: isNonEmptyString(adapterConfig.calleeNumberFieldPath)
      ? adapterConfig.calleeNumberFieldPath.trim()
      : '',
    destinationNumber: isNonEmptyString(adapterConfig.destinationNumberFieldPath)
      ? adapterConfig.destinationNumberFieldPath.trim()
      : '',
    durationSec: isNonEmptyString(adapterConfig.durationSecFieldPath)
      ? adapterConfig.durationSecFieldPath.trim()
      : '',
    answered: isNonEmptyString(adapterConfig.answeredFieldPath)
      ? adapterConfig.answeredFieldPath.trim()
      : '',
    noAnswer: isNonEmptyString(adapterConfig.noAnswerFieldPath)
      ? adapterConfig.noAnswerFieldPath.trim()
      : '',
    callId: isNonEmptyString(adapterConfig.callIdFieldPath)
      ? adapterConfig.callIdFieldPath.trim()
      : ''
  };

  const phoneField = extractStringField(raw, 'phone', configuredPaths.phone);
  const callDateTimeField = extractStringField(raw, 'callDateTime', configuredPaths.callDateTime);
  const transcriptField = extractStringField(raw, 'transcript', configuredPaths.transcript);
  const callTypeField = extractStringField(raw, 'callType', configuredPaths.callType);
  const callerNumberField = extractStringField(raw, 'callerNumber', configuredPaths.callerNumber);
  const calleeNumberField = extractStringField(raw, 'calleeNumber', configuredPaths.calleeNumber);
  const destinationNumberField = extractStringField(raw, 'destinationNumber', configuredPaths.destinationNumber);
  const durationSecField = extractOptionalField(
    raw,
    ['durationSec', 'durationSeconds', 'conversationDurationSec', 'conversationDurationSeconds', 'conversationDuration'],
    configuredPaths.durationSec
  );
  const answeredField = extractOptionalField(
    raw,
    ['answered', 'isAnswered', 'is_answered'],
    configuredPaths.answered
  );
  const noAnswerField = extractOptionalField(
    raw,
    ['noAnswer', 'no_answer', 'missed', 'isMissed', 'is_missed'],
    configuredPaths.noAnswer
  );
  const callIdField = extractStringField(
    raw,
    ['callId', 'externalCallId', 'recordFileName', 'recordingId'],
    configuredPaths.callId
  );
  const errors = [];

  if (!isNonEmptyString(phoneField.value)) {
    errors.push(buildMissingFieldError({
      field: 'phone',
      configuredPath: configuredPaths.phone,
      attemptedPaths: phoneField.attemptedPaths || []
    }));
  }

  if (!isNonEmptyString(callDateTimeField.value)) {
    errors.push(buildMissingFieldError({
      field: 'callDateTime',
      configuredPath: configuredPaths.callDateTime,
      attemptedPaths: callDateTimeField.attemptedPaths || []
    }));
  }

  if (!isNonEmptyString(transcriptField.value)) {
    errors.push(buildMissingFieldError({
      field: 'transcript',
      configuredPath: configuredPaths.transcript,
      attemptedPaths: transcriptField.attemptedPaths || []
    }));
  }

  const adapterMeta = {
    configuredPaths,
    resolvedPaths: {
      phone: phoneField.resolvedPath || '',
      callDateTime: callDateTimeField.resolvedPath || '',
      transcript: transcriptField.resolvedPath || '',
      callType: callTypeField.resolvedPath || '',
      callerNumber: callerNumberField.resolvedPath || '',
      calleeNumber: calleeNumberField.resolvedPath || '',
      destinationNumber: destinationNumberField.resolvedPath || '',
      durationSec: durationSecField.resolvedPath || '',
      answered: answeredField.resolvedPath || '',
      noAnswer: noAnswerField.resolvedPath || '',
      callId: callIdField.resolvedPath || ''
    },
    topLevelKeys: Object.keys(raw).sort()
  };

  if (errors.length > 0) {
    return {
      isValid: false,
      errors,
      adapterMeta
    };
  }

  const normalizedDurationSec = normalizeDurationSec(durationSecField.value);
  const normalizedAnswered = normalizeBoolean(answeredField.value);
  const normalizedNoAnswer = normalizeBoolean(noAnswerField.value);

  return {
    isValid: true,
    payload: {
      phone: phoneField.value,
      callDateTime: callDateTimeField.value,
      transcript: transcriptField.value,
      ...(isNonEmptyString(callTypeField.value) ? { callType: callTypeField.value } : {}),
      ...(isNonEmptyString(callerNumberField.value) ? { callerNumber: callerNumberField.value } : {}),
      ...(isNonEmptyString(calleeNumberField.value) ? { calleeNumber: calleeNumberField.value } : {}),
      ...(isNonEmptyString(destinationNumberField.value) ? { destinationNumber: destinationNumberField.value } : {}),
      ...(Number.isInteger(normalizedDurationSec) ? { durationSec: normalizedDurationSec } : {}),
      ...(normalizedAnswered !== null ? { answered: normalizedAnswered } : {}),
      ...(normalizedNoAnswer !== null ? { noAnswer: normalizedNoAnswer } : {}),
      ...(isNonEmptyString(callIdField.value) ? { callId: callIdField.value } : {})
    },
    adapterMeta
  };
}

module.exports = {
  normalizeIncomingCallPayload
};
