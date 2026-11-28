"use strict";

/**
 * Pure ride commission split calculation.
 * customerDiscountReport is accounting-only and must never be used as a wallet movement.
 */
function calculateRideCommissionSplit(actualFare, savedCommissionRate = 0.05) {
  const fare = Number(actualFare);
  const configuredRate = Number(savedCommissionRate);
  if (!Number.isFinite(fare) || fare < 0) throw new TypeError("actualFare must be a non-negative number");
  if (!Number.isFinite(configuredRate) || configuredRate < 0 || configuredRate > 0.5) {
    throw new TypeError("commission rate must be between 0% and 50%");
  }
  const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const commissionRate = Math.max(0.05, configuredRate);
  const commission = roundMoney(fare * commissionRate);
  const driverIncentive = roundMoney(commission * 0.5);
  return {
    commissionRate,
    commission,
    driverIncentive,
    customerDiscountReport: driverIncentive,
    platformNetIncome: roundMoney(commission - driverIncentive),
    driverNet: roundMoney(fare - commission + driverIncentive)
  };
}

module.exports = { calculateRideCommissionSplit };
