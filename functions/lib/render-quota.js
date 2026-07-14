import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

export const DAILY_CREDIT_LIMIT = 10;
export const MONTHLY_CREDIT_LIMIT = 60;
const QUOTA_COLLECTION = '_aiRenderQuota';
const HONG_KONG_TIME_ZONE = 'Asia/Hong_Kong';

export class RenderQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderQuotaError';
    this.status = 429;
  }
}

export function creditsForQuality(quality) {
  return quality === 'high' ? 2 : 1;
}

export function getQuotaPeriodKeys(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HONG_KONG_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  return { daily: date, monthly: date.slice(0, 7) };
}

export function calculateQuotaReservation({
  dailyCredits,
  monthlyCredits,
  cost,
  dailyLimit = DAILY_CREDIT_LIMIT,
  monthlyLimit = MONTHLY_CREDIT_LIMIT,
}) {
  if (dailyCredits + cost > dailyLimit) {
    throw new RenderQuotaError('Daily AI Render limit reached. Please try again tomorrow.');
  }
  if (monthlyCredits + cost > monthlyLimit) {
    throw new RenderQuotaError('Monthly AI Render limit reached. Please try again next month.');
  }
  return {
    dailyCredits: dailyCredits + cost,
    monthlyCredits: monthlyCredits + cost,
    dailyRemaining: dailyLimit - dailyCredits - cost,
    monthlyRemaining: monthlyLimit - monthlyCredits - cost,
  };
}

function defaultFirestore() {
  if (!getApps().length) initializeApp();
  return getFirestore();
}

export async function reserveRenderCredits({
  quality,
  now = new Date(),
  firestore = defaultFirestore(),
}) {
  const cost = creditsForQuality(quality);
  const periods = getQuotaPeriodKeys(now);
  const dailyRef = firestore.collection(QUOTA_COLLECTION).doc(`daily_${periods.daily}`);
  const monthlyRef = firestore.collection(QUOTA_COLLECTION).doc(`monthly_${periods.monthly}`);

  return firestore.runTransaction(async (transaction) => {
    const [dailySnapshot, monthlySnapshot] = await Promise.all([
      transaction.get(dailyRef),
      transaction.get(monthlyRef),
    ]);
    const reservation = calculateQuotaReservation({
      dailyCredits: Number(dailySnapshot.data()?.credits) || 0,
      monthlyCredits: Number(monthlySnapshot.data()?.credits) || 0,
      cost,
    });
    const common = {
      updatedAt: FieldValue.serverTimestamp(),
      timeZone: HONG_KONG_TIME_ZONE,
    };
    transaction.set(dailyRef, {
      ...common,
      period: periods.daily,
      credits: reservation.dailyCredits,
      limit: DAILY_CREDIT_LIMIT,
    });
    transaction.set(monthlyRef, {
      ...common,
      period: periods.monthly,
      credits: reservation.monthlyCredits,
      limit: MONTHLY_CREDIT_LIMIT,
    });
    return {
      cost,
      dailyRemaining: reservation.dailyRemaining,
      monthlyRemaining: reservation.monthlyRemaining,
    };
  });
}
