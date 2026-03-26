#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  buildWarnings,
  buildDeliveryModel,
  classifySkippedRecord,
  classifyFailedRecord
} = require('./reportDailyFunnelOps');

function mapStatuses(entries) {
  return entries.map(([status, count]) => ({ status, count }));
}

function runMixedDatasetCheck() {
  const source = {
    available: true,
    reason: '',
    count: 10
  };

  const dbStats = {
    polledTotal: 8,
    polledByStatus: mapStatuses([
      ['processed', 3],
      ['ignored', 1],
      ['skipped', 2],
      ['failed', 1],
      ['duplicate', 1]
    ]),
    telegramCall: {
      sent: 3
    },
    recoverableFailures: [
      { reason_code: 'POLZA_EMPTY_TRANSCRIPTION', count: 1 }
    ],
    skippedRecords: [
      {
        record_file_name: '2026-03-26/skip-missed',
        last_error_code: 'MISSED_CALL',
        last_error_message: 'Call marked as missed by field "status"'
      },
      {
        record_file_name: '2026-03-26/skip-empty',
        last_error_code: 'POLZA_EMPTY_TRANSCRIPTION',
        last_error_message: 'class=upstream_empty_after_retries; attempts=2'
      }
    ],
    failedRecords: [
      {
        record_file_name: '2026-03-26/failed-transcribe',
        last_error_code: 'POLZA_TRANSCRIBE_FAILED',
        last_error_message: 'Polza upstream server error'
      }
    ]
  };

  const statusMap = new Map(dbStats.polledByStatus.map((item) => [item.status, item.count]));
  const delivery = buildDeliveryModel({ source, dbStats, statusMap });

  assert.equal(delivery.expectedSendable, 5);
  assert.equal(delivery.actualSent, 3);
  assert.equal(delivery.unexpectedLoss, 2);
  assert.equal(delivery.skippedExpectedNonSendable, 1);
  assert.equal(delivery.skippedActionable, 1);
  assert.equal(delivery.failedActionable, 1);

  const warnings = buildWarnings({ source, dbStats });
  const lowSentWarning = warnings.find((item) => item.code === 'LOW_SENT_VS_SOURCE');
  assert.ok(lowSentWarning, 'Expected LOW_SENT_VS_SOURCE warning for actionable loss');
  assert.equal(lowSentWarning.details.expectedSendable, 5);
  assert.equal(lowSentWarning.details.unexpectedLoss, 2);
}

function runLegitimateSkipNoNoiseCheck() {
  const source = {
    available: true,
    reason: '',
    count: 5
  };

  const dbStats = {
    polledTotal: 5,
    polledByStatus: mapStatuses([
      ['processed', 3],
      ['ignored', 1],
      ['skipped', 1],
      ['failed', 0],
      ['duplicate', 0]
    ]),
    telegramCall: {
      sent: 3
    },
    recoverableFailures: [],
    skippedRecords: [
      {
        record_file_name: '2026-03-26/skip-policy',
        last_error_code: 'MISSED_CALL',
        last_error_message: 'Call marked as missed by field "status"'
      }
    ],
    failedRecords: []
  };

  const warnings = buildWarnings({ source, dbStats });
  const lowSentWarning = warnings.find((item) => item.code === 'LOW_SENT_VS_SOURCE');
  assert.equal(lowSentWarning, undefined, 'No low-sent warning expected for legitimate non-sendable skip');
}

function runClassificationCheck() {
  const skippedRecoverable = classifySkippedRecord({
    record_file_name: '2026-03-26/recoverable',
    last_error_code: 'AI_GATEWAY_EMPTY_TRANSCRIPT',
    last_error_message: 'empty'
  });
  assert.equal(skippedRecoverable.classification, 'recoverable_skipped_loss');
  assert.equal(skippedRecoverable.expectedToSend, true);

  const skippedPolicy = classifySkippedRecord({
    record_file_name: '2026-03-26/policy',
    last_error_code: 'MISSED_CALL',
    last_error_message: 'missed'
  });
  assert.equal(skippedPolicy.classification, 'policy_non_sendable');
  assert.equal(skippedPolicy.expectedToSend, false);

  const failedRecoverable = classifyFailedRecord({
    record_file_name: '2026-03-26/failed',
    last_error_code: 'POLZA_TRANSCRIBE_FAILED',
    last_error_message: 'upstream error'
  });
  assert.equal(failedRecoverable.classification, 'recoverable_failed_loss');
  assert.equal(failedRecoverable.expectedToSend, true);
}

function main() {
  runMixedDatasetCheck();
  runLegitimateSkipNoNoiseCheck();
  runClassificationCheck();
  process.stdout.write('Smoke daily funnel anomaly model: OK\n');
}

main();
