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
  const candidatePaths = uniquePaths([configuredPath, fallbackPath]);

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
      : ''
  };

  const phoneField = extractStringField(raw, 'phone', configuredPaths.phone);
  const callDateTimeField = extractStringField(raw, 'callDateTime', configuredPaths.callDateTime);
  const transcriptField = extractStringField(raw, 'transcript', configuredPaths.transcript);
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
      transcript: transcriptField.resolvedPath || ''
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

  return {
    isValid: true,
    payload: {
      phone: phoneField.value,
      callDateTime: callDateTimeField.value,
      transcript: transcriptField.value
    },
    adapterMeta
  };
}

module.exports = {
  normalizeIncomingCallPayload
};
