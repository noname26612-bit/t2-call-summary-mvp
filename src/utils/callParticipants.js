function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function pickFirstNonEmptyString(values) {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  return '';
}

function normalizeCallType(callType) {
  const normalized = isNonEmptyString(callType) ? callType.trim().toUpperCase() : '';

  if (normalized === 'INCOMING' || normalized === 'INBOUND' || normalized === 'SINGLE_CHANNEL') {
    return 'INCOMING';
  }

  if (normalized === 'OUTGOING' || normalized === 'OUTBOUND') {
    return 'OUTGOING';
  }

  return '';
}

function resolveClientPhoneFromCallMeta({
  callType,
  phone,
  callerNumber,
  calleeNumber,
  destinationNumber
} = {}) {
  const normalizedCallType = normalizeCallType(callType);

  if (normalizedCallType === 'OUTGOING') {
    return pickFirstNonEmptyString([
      destinationNumber,
      calleeNumber,
      callerNumber,
      phone
    ]);
  }

  if (normalizedCallType === 'INCOMING') {
    return pickFirstNonEmptyString([
      callerNumber,
      destinationNumber,
      calleeNumber,
      phone
    ]);
  }

  return pickFirstNonEmptyString([
    phone,
    callerNumber,
    destinationNumber,
    calleeNumber
  ]);
}

function resolveEmployeePhoneFromCallMeta({
  callType,
  callerNumber,
  calleeNumber,
  destinationNumber
} = {}) {
  const normalizedCallType = normalizeCallType(callType);

  if (normalizedCallType === 'OUTGOING') {
    return pickFirstNonEmptyString([
      callerNumber,
      destinationNumber,
      calleeNumber
    ]);
  }

  if (normalizedCallType === 'INCOMING') {
    return pickFirstNonEmptyString([
      destinationNumber,
      calleeNumber,
      callerNumber
    ]);
  }

  return pickFirstNonEmptyString([
    destinationNumber,
    calleeNumber,
    callerNumber
  ]);
}

module.exports = {
  isNonEmptyString,
  pickFirstNonEmptyString,
  normalizeCallType,
  resolveClientPhoneFromCallMeta,
  resolveEmployeePhoneFromCallMeta
};
