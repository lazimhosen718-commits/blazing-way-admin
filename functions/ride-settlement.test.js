"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateRideCommissionSplit } = require("./ride-settlement");

test("৳200 ride: customer discount is report-only; driver and platform split 5% commission", () => {
  const result = calculateRideCommissionSplit(200, 0.05);
  assert.deepEqual(result, {
    commissionRate: 0.05,
    commission: 10,
    driverIncentive: 5,
    customerDiscountReport: 5,
    platformNetIncome: 5,
    driverNet: 195
  });
  assert.equal(result.driverNet + result.platformNetIncome, 200);
  assert.equal(Object.hasOwn(result, "customerWalletAdjustment"), false);
});

test("legacy commission below 5% is raised to the 5% policy floor", () => {
  const result = calculateRideCommissionSplit(200, 0.01);
  assert.equal(result.commissionRate, 0.05);
  assert.equal(result.commission, 10);
  assert.equal(result.driverNet, 195);
});

test("a configured 10% commission splits equally between incentive and platform", () => {
  const result = calculateRideCommissionSplit(500, 0.10);
  assert.equal(result.commission, 50);
  assert.equal(result.driverIncentive, 25);
  assert.equal(result.customerDiscountReport, 25);
  assert.equal(result.platformNetIncome, 25);
  assert.equal(result.driverNet, 475);
  assert.equal(result.driverNet + result.platformNetIncome, 500);
});

test("money values are rounded to two decimal places", () => {
  const result = calculateRideCommissionSplit(123.45, 0.05);
  assert.equal(result.commission, 6.17);
  assert.equal(result.driverIncentive, 3.09);
  assert.equal(result.platformNetIncome, 3.08);
  assert.equal(result.driverNet, 120.37);
});

test("invalid fares and commission rates are rejected", () => {
  assert.throws(() => calculateRideCommissionSplit(-1, 0.05), /actualFare/);
  assert.throws(() => calculateRideCommissionSplit(100, -0.01), /commission rate/);
  assert.throws(() => calculateRideCommissionSplit(100, 0.51), /commission rate/);
});
