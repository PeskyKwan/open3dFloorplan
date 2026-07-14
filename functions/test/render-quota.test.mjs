import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateQuotaReservation,
  creditsForQuality,
  getQuotaPeriodKeys,
  RenderQuotaError,
} from '../lib/render-quota.js';

test('uses Hong Kong calendar periods and quality credits', () => {
  assert.deepEqual(
    getQuotaPeriodKeys(new Date('2026-07-14T16:30:00.000Z')),
    { daily: '2026-07-15', monthly: '2026-07' },
  );
  assert.equal(creditsForQuality('low'), 1);
  assert.equal(creditsForQuality('high'), 2);
});

test('reserves within daily and monthly hard limits', () => {
  assert.deepEqual(calculateQuotaReservation({
    dailyCredits: 8,
    monthlyCredits: 57,
    cost: 2,
  }), {
    dailyCredits: 10,
    monthlyCredits: 59,
    dailyRemaining: 0,
    monthlyRemaining: 1,
  });
});

test('rejects reservations over either hard limit', () => {
  assert.throws(
    () => calculateQuotaReservation({ dailyCredits: 9, monthlyCredits: 20, cost: 2 }),
    RenderQuotaError,
  );
  assert.throws(
    () => calculateQuotaReservation({ dailyCredits: 1, monthlyCredits: 59, cost: 2 }),
    RenderQuotaError,
  );
});
