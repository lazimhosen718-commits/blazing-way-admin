const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: "asia-south1", maxInstances: 10 });

function requireUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "লগইন করুন।");
  return request.auth.uid;
}
function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpsError("invalid-argument", "অবৈধ টাকার পরিমাণ।");
  return Math.round(n * 100) / 100;
}

/**
 * Passenger requests a short-lived completion OTP.
 * The passenger shares this code with the assigned driver only after the trip.
 */
exports.createRideCompletionOtp = onCall(async (request) => {
  const uid = requireUser(request);
  const rideId = String(request.data?.rideId || "").trim();
  if (!rideId) throw new HttpsError("invalid-argument", "rideId প্রয়োজন।");

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const rideRef = db.collection("rideBookings").doc(rideId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(rideRef);
    if (!snap.exists) throw new HttpsError("not-found", "Ride পাওয়া যায়নি।");
    const ride = snap.data();
    if (ride.passengerId !== uid) throw new HttpsError("permission-denied", "শুধু সংশ্লিষ্ট যাত্রী OTP নিতে পারবেন।");
    if (ride.status !== "accepted" || !ride.driverId) throw new HttpsError("failed-precondition", "চালক Ride গ্রহণ করার পর OTP নেওয়া যাবে।");
    tx.update(rideRef, {
      completionOtpHash: hashOtp(code),
      completionOtpExpiresAt: Date.now() + 10 * 60 * 1000,
      completionOtpCreatedAt: FieldValue.serverTimestamp()
    });
  });

  return { otp: code, expiresInSeconds: 600, message: "OTP চালককে যাত্রা শেষ হওয়ার পর দিন।" };
});

/**
 * Driver completes an assigned ride using the passenger's OTP.
 * Unused distance fare is returned to the passenger wallet.
 * Platform commission is 1% of the actual fare.
 */
exports.completeRideWithOtp = onCall(async (request) => {
  const driverId = requireUser(request);
  const rideId = String(request.data?.rideId || "").trim();
  const otp = String(request.data?.otp || "").trim();
  const completedDistanceKm = Number(request.data?.completedDistanceKm);

  if (!rideId || !/^\d{6}$/.test(otp)) throw new HttpsError("invalid-argument", "Ride ID ও ৬ সংখ্যার OTP দিন।");
  if (!Number.isFinite(completedDistanceKm) || completedDistanceKm <= 0) throw new HttpsError("invalid-argument", "সম্পন্ন দূরত্ব সঠিকভাবে দিন।");

  const rideRef = db.collection("rideBookings").doc(rideId);
  let outcome;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(rideRef);
    if (!snap.exists) throw new HttpsError("not-found", "Ride পাওয়া যায়নি।");
    const ride = snap.data();

    if (ride.driverId !== driverId) throw new HttpsError("permission-denied", "এই Ride আপনার নামে বরাদ্দ নয়।");
    if (ride.status !== "accepted") throw new HttpsError("failed-precondition", "শুধু accepted Ride সম্পন্ন করা যাবে।");
    if (!ride.completionOtpHash || ride.completionOtpHash !== hashOtp(otp)) throw new HttpsError("permission-denied", "OTP সঠিক নয়।");
    if (Number(ride.completionOtpExpiresAt || 0) < Date.now()) throw new HttpsError("deadline-exceeded", "OTP-এর মেয়াদ শেষ। নতুন OTP নিন।");

    const plannedKm = Number(ride.distanceKm);
    const estimatedFare = money(ride.estimatedFare);
    if (!Number.isFinite(plannedKm) || plannedKm <= 0 || completedDistanceKm > plannedKm + 0.01) {
      throw new HttpsError("invalid-argument", "সম্পন্ন দূরত্ব বুক করা দূরত্বের চেয়ে বেশি হতে পারবে না।");
    }

    const vehicle = ride.vehicleType;
    const baseFare = vehicle === "bike" ? 30 : vehicle === "car" ? 60 : null;
    const perKm = vehicle === "bike" ? 12 : vehicle === "car" ? 20 : null;
    if (baseFare === null) throw new HttpsError("failed-precondition", "অজানা vehicleType।");

    const actualFare = money(Math.min(estimatedFare, baseFare + completedDistanceKm * perKm));
    const passengerRefund = money(Math.max(0, estimatedFare - actualFare));
    const commission = money(actualFare * 0.01);
    const driverNet = money(actualFare - commission);

    const passengerWalletRef = db.collection("passengerWallets").doc(ride.passengerId);
    const driverWalletRef = db.collection("driverWallets").doc(driverId);
    const passengerWalletSnap = await tx.get(passengerWalletRef);
    const driverWalletSnap = await tx.get(driverWalletRef);

    const passengerBalance = money(passengerWalletSnap.exists ? passengerWalletSnap.data().balance || 0 : 0);
    const driverBalance = money(driverWalletSnap.exists ? driverWalletSnap.data().balance || 0 : 0);

    tx.set(passengerWalletRef, {
      balance: money(passengerBalance + passengerRefund),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(driverWalletRef, {
      balance: money(driverBalance + driverNet),
      totalEarnings: FieldValue.increment(driverNet),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    tx.update(rideRef, {
      status: "completed",
      completedDistanceKm,
      actualFare,
      passengerRefund,
      platformCommission: commission,
      driverEarnings: driverNet,
      completedAt: FieldValue.serverTimestamp(),
      completionOtpHash: FieldValue.delete(),
      completionOtpExpiresAt: FieldValue.delete()
    });

    const ledgerRef = db.collection("walletTransactions").doc();
    tx.set(ledgerRef, {
      passengerId: ride.passengerId,
      driverId,
      rideId,
      type: "ride_settlement",
      fare: actualFare,
      passengerRefund,
      platformCommission: commission,
      driverEarnings: driverNet,
      createdAt: FieldValue.serverTimestamp()
    });

    outcome = { actualFare, passengerRefund, commission, driverEarnings: driverNet };
  });

  return { success: true, ...outcome };
});

/**
 * Creates a withdrawal request. It does not send money automatically:
 * an administrator must review and pay it through the selected provider.
 * The flat 5 BDT fee is reserved together with the requested payout.
 */
exports.requestWalletWithdrawal = onCall(async (request) => {
  const uid = requireUser(request);
  const amount = money(request.data?.amount);
  const method = String(request.data?.method || "").trim().toLowerCase();
  const accountNumber = String(request.data?.accountNumber || "").trim();
  const walletType = String(request.data?.walletType || "passenger").trim();

  const methods = ["bkash", "nagad", "rocket", "bank"];
  if (amount <= 0 || !methods.includes(method) || accountNumber.length < 5 || accountNumber.length > 80) {
    throw new HttpsError("invalid-argument", "টাকার পরিমাণ, পেমেন্ট মাধ্যম ও অ্যাকাউন্ট নম্বর সঠিকভাবে দিন।");
  }
  if (!["passenger", "driver"].includes(walletType)) throw new HttpsError("invalid-argument", "অবৈধ walletType।");

  const walletRef = db.collection(walletType === "driver" ? "driverWallets" : "passengerWallets").doc(uid);
  const requestRef = db.collection("withdrawalRequests").doc();
  const totalDebit = money(amount + 5);

  await db.runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);
    if (!walletSnap.exists) throw new HttpsError("failed-precondition", "Wallet পাওয়া যায়নি।");
    const balance = money(walletSnap.data().balance || 0);
    if (balance < totalDebit) throw new HttpsError("failed-precondition", "উত্তোলনের টাকা ও ৫ টাকা চার্জ দেওয়ার মতো পর্যাপ্ত ব্যালেন্স নেই।");

    tx.update(walletRef, {
      balance: money(balance - totalDebit),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.set(requestRef, {
      userId: uid,
      walletType,
      amount,
      fee: 5,
      totalDebited: totalDebit,
      method,
      accountNumber,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });
    tx.set(db.collection("walletTransactions").doc(), {
      userId: uid,
      type: "withdrawal_requested",
      amount,
      fee: 5,
      totalDebited: totalDebit,
      withdrawalRequestId: requestRef.id,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true, withdrawalRequestId: requestRef.id, amount, fee: 5, totalDebited: totalDebit, status: "pending" };
});
