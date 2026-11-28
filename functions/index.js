const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("node:crypto");
const { calculateRideCommissionSplit } = require("./ride-settlement");

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
 * RIDE COMMISSION SETTINGS: only Super Admin can change the Bike and Car rates.
 * Rates are stored as fractions (1% = 0.01); the server reads them at settlement.
 */
exports.updateRideCommissionRates = onCall(async (request) => {
  const actorUid = requireSuperAdmin(request);
  const bike = Number(request.data?.bike);
  const car = Number(request.data?.car);
  if (!Number.isFinite(bike) || !Number.isFinite(car) || bike < 0.05 || car < 0.05 || bike > 0.5 || car > 0.5) {
    throw new HttpsError("invalid-argument", "Bike ও Car কমিশন ৫% থেকে ৫০%-এর মধ্যে দিন।");
  }
  const rates = { bike: Math.round(bike * 10000) / 10000, car: Math.round(car * 10000) / 10000 };
  await db.collection("platformSettings").doc("rideCommission").set({
    ...rates, updatedBy: actorUid, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await db.collection("adminAuditLogs").add({
    actorUid, action: "ride_commission_rates_updated", rates,
    createdAt: FieldValue.serverTimestamp()
  });
  return { success: true, ...rates };
});

/**
 * RIDE OPERATIONS SETTINGS: Super Admin only.
 * These values are centrally stored for the ride-pricing/dispatch rollout.
 * Existing production flows must be migrated to consume each field before
 * the corresponding operational feature is considered live.
 */
exports.updateRideOperationsSettings = onCall(async (request) => {
  const actorUid = requireSuperAdmin(request);
  const input = request.data || {};
  const numeric = (key, min, max) => {
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new HttpsError("invalid-argument", key + " এর মান " + min + " থেকে " + max + " এর মধ্যে দিন।");
    }
    return value;
  };
  const settings = {
    bikeBaseFare: money(numeric("bikeBaseFare", 0.01, 10000)),
    bikePerKm: money(numeric("bikePerKm", 0.01, 1000)),
    carBaseFare: money(numeric("carBaseFare", 0.01, 20000)),
    carPerKm: money(numeric("carPerKm", 0.01, 2000)),
    minimumFare: money(numeric("minimumFare", 0, 10000)),
    requestTimeoutSeconds: Math.round(numeric("requestTimeoutSeconds", 10, 180)),
    driverSearchRadiusKm: Number(numeric("driverSearchRadiusKm", 1, 50).toFixed(1)),
    surgeEnabled: input.surgeEnabled === true,
    surgeMultiplier: Number(numeric("surgeMultiplier", 1, 5).toFixed(2)),
    liveGpsEnabled: input.liveGpsEnabled === true,
    sosEnabled: input.sosEnabled === true,
    updatedBy: actorUid,
    updatedAt: FieldValue.serverTimestamp()
  };
  const ref = db.collection("platformSettings").doc("rideOperations");
  const previousSnap = await ref.get();
  const previous = previousSnap.exists ? previousSnap.data() : null;
  await ref.set(settings, { merge: true });
  await db.collection("adminAuditLogs").add({
    actorUid,
    action: "ride_operations_settings_updated",
    previous: previous ? {
      bikeBaseFare: previous.bikeBaseFare ?? null,
      bikePerKm: previous.bikePerKm ?? null,
      carBaseFare: previous.carBaseFare ?? null,
      carPerKm: previous.carPerKm ?? null,
      minimumFare: previous.minimumFare ?? null,
      requestTimeoutSeconds: previous.requestTimeoutSeconds ?? null,
      driverSearchRadiusKm: previous.driverSearchRadiusKm ?? null,
      surgeEnabled: previous.surgeEnabled ?? null,
      surgeMultiplier: previous.surgeMultiplier ?? null,
      liveGpsEnabled: previous.liveGpsEnabled ?? null,
      sosEnabled: previous.sosEnabled ?? null
    } : null,
    values: settings,
    createdAt: FieldValue.serverTimestamp()
  });
  return { success: true, settings };
});

/**
 * Broadcast a newly created ride to online, approved drivers of matching vehicle type.
 * The first driver to accept wins through a Firestore transaction.
 */

function rideDistanceKm(aLat,aLng,bLat,bLng) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

exports.dispatchRideRequest = onCall(async (request) => {
  const passengerId = requireUser(request);
  const rideId = String(request.data?.rideId || "").trim();
  if (!rideId) throw new HttpsError("invalid-argument", "Ride ID প্রয়োজন।");
  const rideRef = db.collection("rideBookings").doc(rideId);
  const [rideSnap, settingsSnap] = await Promise.all([
    rideRef.get(),
    db.collection("platformSettings").doc("rideOperations").get()
  ]);
  if (!rideSnap.exists) throw new HttpsError("not-found", "Ride পাওয়া যায়নি।");
  const ride = rideSnap.data();
  if (ride.passengerId !== passengerId) throw new HttpsError("permission-denied", "এটি আপনার Ride নয়।");
  if (ride.status !== "pending" || ride.driverId) throw new HttpsError("failed-precondition", "Ride আর Dispatch করা যাবে না।");

  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const radiusKm = Math.max(1, Math.min(50, Number(settings.driverSearchRadiusKm ?? 5)));
  const hasPickupGps = Number.isFinite(ride.pickupLat) && Number.isFinite(ride.pickupLng);
  const presenceSnap = await db.collection("driverPresence").where("online", "==", true).get();
  const eligible = [];
  for (const presence of presenceSnap.docs) {
    const driverId = presence.id;
    const p = presence.data();
    if (driverId === passengerId || typeof p.lat !== "number" || typeof p.lng !== "number") continue;
    const updatedMs = p.updatedAt?.toMillis ? p.updatedAt.toMillis() : 0;
    if (!updatedMs || Date.now() - updatedMs > 120000) continue;
    const profileSnap = await db.collection("driverApplications").doc(driverId).get();
    if (!profileSnap.exists) continue;
    const profile = profileSnap.data();
    if (profile.status !== "approved" || profile.vehicleType !== ride.vehicleType) continue;
    const distanceKm = hasPickupGps
      ? rideDistanceKm(ride.pickupLat, ride.pickupLng, p.lat, p.lng)
      : null;
    if (hasPickupGps && distanceKm > radiusKm) continue;
    eligible.push({ driverId, driverName: profile.fullName || "Driver", distanceKm });
  }
  eligible.sort((a,b) => {
    if (a.distanceKm === null) return 0;
    if (b.distanceKm === null) return 0;
    return a.distanceKm - b.distanceKm;
  });
  const selected = eligible.slice(0, 5);
  if (!selected.length) return {
    success: true, offersSent: 0,
    message: hasPickupGps
      ? "নির্ধারিত Search Radius-এর মধ্যে কোনো সক্রিয় উপযুক্ত Driver পাওয়া যায়নি।"
      : "সাম্প্রতিক GPS-সহ কোনো উপযুক্ত Online Driver পাওয়া যায়নি।"
  };

  const batch = db.batch();
  for (const driver of selected) {
    const offerRef = db.collection("rideOffers").doc(rideId + "_" + driver.driverId);
    batch.set(offerRef, {
      rideId, driverId: driver.driverId, passengerId,
      vehicleType: ride.vehicleType, pickup: ride.pickup,
      destination: ride.destination, distanceKm: ride.distanceKm,
      estimatedFare: ride.estimatedFare,
      driverDistanceKm: driver.distanceKm,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });
  }
  batch.update(rideRef, {
    dispatchStartedAt: FieldValue.serverTimestamp(),
    dispatchOfferCount: selected.length,
    dispatchRadiusKm: radiusKm,
    dispatchMode: hasPickupGps ? "nearest_gps" : "gps_unavailable_fallback"
  });
  await batch.commit();
  return {
    success: true, offersSent: selected.length,
    dispatchMode: hasPickupGps ? "nearest_gps" : "gps_unavailable_fallback",
    message: hasPickupGps
      ? "নিকটতম উপযুক্ত Driver-দের কাছে Request পাঠানো হয়েছে।"
      : "Pickup GPS না থাকায় নিকটতম অনুযায়ী সাজানো সম্ভব হয়নি।"
  };
});


/**
 * Every minute, escalate pending rides whose current driver-offer wave timed out.
 * Sends the next five nearest eligible drivers, excluding drivers already offered.
 * Cloud Scheduler is provisioned automatically by Firebase on deployment.
 */
exports.escalateTimedOutRideRequests = onSchedule("every 1 minutes", async () => {
  const pendingSnap = await db.collection("rideBookings")
    .where("status", "==", "pending")
    .limit(50)
    .get();

  for (const rideDoc of pendingSnap.docs) {
    const ride = rideDoc.data();
    if (ride.driverId || !ride.dispatchStartedAt?.toMillis) continue;

    const settingsSnap = await db.collection("platformSettings").doc("rideOperations").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const timeoutSeconds = Math.max(30, Math.min(180, Number(settings.requestTimeoutSeconds ?? 30)));
    const startedAt = ride.dispatchStartedAt.toMillis();
    if (Date.now() - startedAt < timeoutSeconds * 1000) continue;

    const rideRef = rideDoc.ref;
    const claim = await db.runTransaction(async tx => {
      const fresh = await tx.get(rideRef);
      if (!fresh.exists) return false;
      const current = fresh.data();
      if (current.status !== "pending" || current.driverId
          || !current.dispatchStartedAt?.toMillis
          || current.dispatchStartedAt.toMillis() !== startedAt
          || current.dispatchExhausted === true) return false;
      tx.update(rideRef, {
        dispatchStartedAt: FieldValue.serverTimestamp(),
        dispatchWave: Number(current.dispatchWave || 1) + 1
      });
      return true;
    });
    if (!claim) continue;

    const oldOffersSnap = await db.collection("rideOffers").where("rideId", "==", rideDoc.id).get();
    const alreadyOffered = new Set(oldOffersSnap.docs.map(doc => doc.data().driverId));
    const radiusKm = Math.max(1, Math.min(50, Number(settings.driverSearchRadiusKm ?? 5)));
    const hasPickupGps = Number.isFinite(ride.pickupLat) && Number.isFinite(ride.pickupLng);
    const presenceSnap = await db.collection("driverPresence").where("online", "==", true).get();
    const candidates = [];

    for (const presence of presenceSnap.docs) {
      const driverId = presence.id;
      const p = presence.data();
      if (alreadyOffered.has(driverId) || driverId === ride.passengerId
          || typeof p.lat !== "number" || typeof p.lng !== "number") continue;
      const updatedMs = p.updatedAt?.toMillis ? p.updatedAt.toMillis() : 0;
      if (!updatedMs || Date.now() - updatedMs > 120000) continue;
      const profileSnap = await db.collection("driverApplications").doc(driverId).get();
      if (!profileSnap.exists) continue;
      const profile = profileSnap.data();
      if (profile.status !== "approved" || profile.vehicleType !== ride.vehicleType) continue;
      const distanceKm = hasPickupGps
        ? rideDistanceKm(ride.pickupLat, ride.pickupLng, p.lat, p.lng)
        : null;
      if (hasPickupGps && distanceKm > radiusKm) continue;
      candidates.push({driverId, distanceKm});
    }

    candidates.sort((a,b) => {
      if (a.distanceKm === null) return 0;
      if (b.distanceKm === null) return 0;
      return a.distanceKm - b.distanceKm;
    });
    const nextWave = candidates.slice(0, 5);

    if (!nextWave.length) {
      await rideRef.update({
        dispatchExhausted: true,
        dispatchExhaustedAt: FieldValue.serverTimestamp()
      });
      continue;
    }

    const batch = db.batch();
    for (const driver of nextWave) {
      const offerRef = db.collection("rideOffers").doc(rideDoc.id + "_" + driver.driverId);
      batch.set(offerRef, {
        rideId: rideDoc.id,
        driverId: driver.driverId,
        passengerId: ride.passengerId,
        vehicleType: ride.vehicleType,
        pickup: ride.pickup,
        destination: ride.destination,
        distanceKm: ride.distanceKm,
        estimatedFare: ride.estimatedFare,
        driverDistanceKm: driver.distanceKm,
        dispatchWave: Number(ride.dispatchWave || 1) + 1,
        status: "pending",
        createdAt: FieldValue.serverTimestamp()
      });
    }
    batch.update(rideRef, {
      dispatchOfferCount: FieldValue.increment(nextWave.length),
      dispatchLastEscalatedAt: FieldValue.serverTimestamp()
    });
    await batch.commit();
  }
});

exports.acceptRideOffer = onCall(async (request) => {
  const driverId = requireUser(request);
  const rideId = String(request.data?.rideId || "").trim();
  if (!rideId) throw new HttpsError("invalid-argument", "Ride ID প্রয়োজন।");
  const driverSnap = await db.collection("driverApplications").doc(driverId).get();
  if (!driverSnap.exists || driverSnap.data().status !== "approved") throw new HttpsError("permission-denied", "অনুমোদিত Driver হতে হবে।");
  const rideRef = db.collection("rideBookings").doc(rideId);
  const offerRef = db.collection("rideOffers").doc(rideId + "_" + driverId);
  await db.runTransaction(async tx => {
    const [rideSnap, offerSnap] = await Promise.all([tx.get(rideRef), tx.get(offerRef)]);
    if (!rideSnap.exists || !offerSnap.exists || offerSnap.data().status !== "pending") throw new HttpsError("not-found", "Ride Offer আর পাওয়া যাচ্ছে না।");
    const ride = rideSnap.data();
    if (ride.status !== "pending" || ride.driverId) throw new HttpsError("already-exists", "অন্য Driver ইতিমধ্যে Ride গ্রহণ করেছেন।");
    tx.update(rideRef, {
      driverId, driverName: driverSnap.data().fullName || "Driver",
      driverPhone: driverSnap.data().phone || "",
      status: "accepted", assignedAt: FieldValue.serverTimestamp(),
      acceptedAt: FieldValue.serverTimestamp(), driverResponse: "accepted"
    });
    tx.update(offerRef, { status: "accepted", acceptedAt: FieldValue.serverTimestamp() });
  });
  return { success: true, message: "Ride আপনার নামে Assign হয়েছে।" };
});

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
 * Platform commission is 5% of the actual fare; half is driver incentive and half is platform net income.
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
    const settingsRef = db.collection("platformSettings").doc("rideCommission");
    const operationsRef = db.collection("platformSettings").doc("rideOperations");
    const [snap, settingsSnap, operationsSnap] = await Promise.all([
      tx.get(rideRef), tx.get(settingsRef), tx.get(operationsRef)
    ]);
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
    const operations = operationsSnap.exists ? operationsSnap.data() : {};
    const baseFare = vehicle === "bike"
      ? Number(operations.bikeBaseFare ?? 0)
      : vehicle === "car" ? Number(operations.carBaseFare ?? 0) : null;
    const perKm = vehicle === "bike"
      ? Number(operations.bikePerKm ?? 0)
      : vehicle === "car" ? Number(operations.carPerKm ?? 0) : null;
    if (baseFare === null || !Number.isFinite(baseFare) || baseFare <= 0 || !Number.isFinite(perKm) || perKm <= 0) {
      throw new HttpsError("failed-precondition", "Ride ভাড়ার সেটিংস সঠিক নয়।");
    }
    const minimumFare = Number(operations.minimumFare ?? 0);
    const surgeMultiplier = operations.surgeEnabled === true ? Number(operations.surgeMultiplier ?? 1) : 1;
    if (!Number.isFinite(minimumFare) || minimumFare < 0 || !Number.isFinite(surgeMultiplier) || surgeMultiplier < 1 || surgeMultiplier > 5) {
      throw new HttpsError("failed-precondition", "Minimum Fare বা Surge সেটিংস সঠিক নয়।");
    }
    const calculatedActualFare = Math.max(minimumFare, baseFare + completedDistanceKm * perKm) * surgeMultiplier;
    const actualFare = money(Math.min(estimatedFare, calculatedActualFare));
    const passengerRefund = money(Math.max(0, estimatedFare - actualFare));
    const configuredRates = settingsSnap.exists ? settingsSnap.data() : {};
    const savedCommissionRate = Number(configuredRates[vehicle] ?? 0.05);
    let split;
    try {
      split = calculateRideCommissionSplit(actualFare, savedCommissionRate);
    } catch (error) {
      throw new HttpsError("failed-precondition", "Ride কমিশন সেটিংস সঠিক নয়।");
    }
    const {
      commissionRate, commission, driverIncentive,
      customerDiscountReport, platformNetIncome, driverNet
    } = split;

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
      platformCommissionRate: commissionRate,
      customerDiscountReport,
      customerDiscountReportRate: commissionRate * 0.5,
      driverIncentive,
      driverIncentiveRate: commissionRate * 0.5,
      platformNetIncome,
      commissionPolicyVersion: "commission-split-v1",
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
      platformCommissionRate: commissionRate,
      customerDiscountReport,
      customerDiscountReportRate: commissionRate * 0.5,
      driverIncentive,
      driverIncentiveRate: commissionRate * 0.5,
      platformNetIncome,
      commissionPolicyVersion: "commission-split-v1",
      driverEarnings: driverNet,
      createdAt: FieldValue.serverTimestamp()
    });

    outcome = {
      actualFare, passengerRefund, commission, customerDiscountReport,
      driverIncentive, platformNetIncome, driverEarnings: driverNet
    };
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


/**
 * FOOD DELIVERY: Merchant accepts a pending order.
 * A fixed BDT 1 fee is deducted once, atomically with the order update.
 */
exports.acceptFoodOrder = onCall(async (request) => {
  const uid = requireUser(request);
  const orderId = String(request.data?.orderId || "").trim();
  if (!orderId || orderId.includes("/")) {
    throw new HttpsError("invalid-argument", "সঠিক orderId দিন।");
  }

  const orderRef = db.collection("foodOrders").doc(orderId);
  const profileRef = db.collection("merchantProfiles").doc(uid);
  const walletRef = db.collection("merchantWallets").doc(uid);
  const feeId = crypto.createHash("sha256").update("merchant_accept:" + orderId).digest("hex");
  const feeRef = db.collection("foodWalletTransactions").doc(feeId);
  let result;

  await db.runTransaction(async (tx) => {
    const [orderSnap, profileSnap, walletSnap, feeSnap] = await Promise.all([
      tx.get(orderRef), tx.get(profileRef), tx.get(walletRef), tx.get(feeRef)
    ]);
    if (!orderSnap.exists) throw new HttpsError("not-found", "অর্ডার পাওয়া যায়নি।");
    if (!profileSnap.exists || profileSnap.data().role !== "merchant" || profileSnap.data().status !== "approved") {
      throw new HttpsError("permission-denied", "অনুমোদিত Merchant অ্যাকাউন্ট প্রয়োজন।");
    }
    const order = orderSnap.data();
    if (order.merchantId !== uid) throw new HttpsError("permission-denied", "এই অর্ডার আপনার Merchant অ্যাকাউন্টের নয়।");

    if (order.merchantAcceptedAt || feeSnap.exists) {
      result = { success: true, alreadyAccepted: true, fee: 1 };
      return;
    }
    if (order.status !== "pending") {
      throw new HttpsError("failed-precondition", "শুধু pending অর্ডার গ্রহণ করা যাবে।");
    }
    if (!walletSnap.exists) throw new HttpsError("failed-precondition", "Merchant Wallet পাওয়া যায়নি।");
    const balance = Number(walletSnap.data().balance);
    if (!Number.isFinite(balance) || balance < 1) {
      throw new HttpsError("failed-precondition", "অর্ডার গ্রহণের জন্য Wallet-এ কমপক্ষে ৳১ থাকতে হবে।");
    }

    tx.update(walletRef, {
      balance: Math.round((balance - 1) * 100) / 100,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(orderRef, {
      status: "accepted",
      merchantAcceptedAt: FieldValue.serverTimestamp(),
      merchantAcceptedBy: uid,
      merchantAcceptanceFee: 1,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(feeRef, {
      ownerId: uid,
      ownerRole: "merchant",
      orderId,
      type: "merchant_acceptance_fee",
      amount: 1,
      currency: "BDT",
      createdAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("foodOrderEvents").doc(), {
      orderId,
      actorUid: uid,
      actorRole: "merchant",
      event: "merchant_accepted",
      fee: 1,
      createdAt: FieldValue.serverTimestamp()
    });
    result = { success: true, alreadyAccepted: false, fee: 1, balance: Math.round((balance - 1) * 100) / 100 };
  });

  return result;
});

/**
 * FOOD DELIVERY: An approved merchant assigns an approved Food Rider.
 * Assignment itself does not charge the rider; the BDT 1 fee is charged
 * only when that rider accepts the assignment.
 */
exports.assignFoodRider = onCall(async (request) => {
  const uid = requireUser(request);
  const orderId = String(request.data?.orderId || "").trim();
  const riderId = String(request.data?.riderId || "").trim();
  if (!orderId || orderId.includes("/") || !riderId || riderId.includes("/")) {
    throw new HttpsError("invalid-argument", "সঠিক orderId ও riderId দিন।");
  }

  const orderRef = db.collection("foodOrders").doc(orderId);
  const merchantRef = db.collection("merchantProfiles").doc(uid);
  const riderRef = db.collection("foodRiderProfiles").doc(riderId);

  await db.runTransaction(async (tx) => {
    const [orderSnap, merchantSnap, riderSnap] = await Promise.all([
      tx.get(orderRef), tx.get(merchantRef), tx.get(riderRef)
    ]);
    if (!orderSnap.exists) throw new HttpsError("not-found", "অর্ডার পাওয়া যায়নি।");
    if (!merchantSnap.exists || merchantSnap.data().role !== "merchant" || merchantSnap.data().status !== "approved") {
      throw new HttpsError("permission-denied", "অনুমোদিত Merchant অ্যাকাউন্ট প্রয়োজন।");
    }
    if (!riderSnap.exists || riderSnap.data().role !== "food_rider" || riderSnap.data().status !== "approved") {
      throw new HttpsError("failed-precondition", "নির্বাচিত Food Rider অনুমোদিত নন।");
    }
    const order = orderSnap.data();
    if (order.merchantId !== uid) throw new HttpsError("permission-denied", "এই অর্ডার আপনার Merchant অ্যাকাউন্টের নয়।");
    if (!order.merchantAcceptedAt || order.status !== "ready") {
      throw new HttpsError("failed-precondition", "অর্ডার ready হওয়ার পরই Rider বরাদ্দ করা যাবে।");
    }
    if (order.riderAcceptedAt) throw new HttpsError("failed-precondition", "Rider ইতিমধ্যে অর্ডার গ্রহণ করেছেন।");

    tx.update(orderRef, {
      assignedRiderId: riderId,
      riderAssignedAt: FieldValue.serverTimestamp(),
      status: "rider_assigned",
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("foodOrderEvents").doc(), {
      orderId,
      actorUid: uid,
      actorRole: "merchant",
      event: "rider_assigned",
      assignedRiderId: riderId,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true, orderId, assignedRiderId: riderId };
});

/**
 * FOOD DELIVERY: Only the specifically assigned, approved rider can accept.
 * The BDT 1 rider fee is deducted exactly once in the same transaction.
 */
exports.acceptFoodDeliveryAssignment = onCall(async (request) => {
  const uid = requireUser(request);
  const orderId = String(request.data?.orderId || "").trim();
  if (!orderId || orderId.includes("/")) {
    throw new HttpsError("invalid-argument", "সঠিক orderId দিন।");
  }

  const orderRef = db.collection("foodOrders").doc(orderId);
  const profileRef = db.collection("foodRiderProfiles").doc(uid);
  const walletRef = db.collection("foodRiderWallets").doc(uid);
  const feeId = crypto.createHash("sha256").update("rider_accept:" + orderId + ":" + uid).digest("hex");
  const feeRef = db.collection("foodWalletTransactions").doc(feeId);
  let result;

  await db.runTransaction(async (tx) => {
    const [orderSnap, profileSnap, walletSnap, feeSnap] = await Promise.all([
      tx.get(orderRef), tx.get(profileRef), tx.get(walletRef), tx.get(feeRef)
    ]);
    if (!orderSnap.exists) throw new HttpsError("not-found", "অর্ডার পাওয়া যায়নি।");
    if (!profileSnap.exists || profileSnap.data().role !== "food_rider" || profileSnap.data().status !== "approved") {
      throw new HttpsError("permission-denied", "অনুমোদিত Food Rider অ্যাকাউন্ট প্রয়োজন।");
    }
    const order = orderSnap.data();
    if (order.assignedRiderId !== uid) throw new HttpsError("permission-denied", "এই ডেলিভারি আপনার নামে বরাদ্দ নয়।");

    if (order.riderAcceptedAt || feeSnap.exists) {
      result = { success: true, alreadyAccepted: true, fee: 1 };
      return;
    }
    if (!order.merchantAcceptedAt || !["ready", "rider_assigned"].includes(order.status)) {
      throw new HttpsError("failed-precondition", "Merchant-এর প্রস্তুত করা ও বরাদ্দকৃত অর্ডার গ্রহণ করা যাবে।");
    }
    if (!walletSnap.exists) throw new HttpsError("failed-precondition", "Food Rider Wallet পাওয়া যায়নি।");
    const balance = Number(walletSnap.data().balance);
    if (!Number.isFinite(balance) || balance < 1) {
      throw new HttpsError("failed-precondition", "ডেলিভারি গ্রহণের জন্য Wallet-এ কমপক্ষে ৳১ থাকতে হবে।");
    }

    tx.update(walletRef, {
      balance: Math.round((balance - 1) * 100) / 100,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(orderRef, {
      riderId: uid,
      riderAcceptedAt: FieldValue.serverTimestamp(),
      riderAcceptanceFee: 1,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(feeRef, {
      ownerId: uid,
      ownerRole: "food_rider",
      orderId,
      type: "rider_acceptance_fee",
      amount: 1,
      currency: "BDT",
      createdAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("foodOrderEvents").doc(), {
      orderId,
      actorUid: uid,
      actorRole: "food_rider",
      event: "rider_accepted",
      fee: 1,
      createdAt: FieldValue.serverTimestamp()
    });
    result = { success: true, alreadyAccepted: false, fee: 1, balance: Math.round((balance - 1) * 100) / 100 };
  });

  return result;
});


/**
 * FOOD DELIVERY: Merchant advances an accepted order through preparation.
 * Client-side direct order writes remain denied by Firestore Rules.
 */
exports.updateFoodOrderPreparationStatus = onCall(async (request) => {
  const uid = requireUser(request);
  const orderId = String(request.data?.orderId || "").trim();
  const nextStatus = String(request.data?.status || "").trim();
  if (!orderId || orderId.includes("/") || !["preparing", "ready"].includes(nextStatus)) {
    throw new HttpsError("invalid-argument", "সঠিক orderId এবং preparing/ready status দিন।");
  }

  const orderRef = db.collection("foodOrders").doc(orderId);
  const merchantRef = db.collection("merchantProfiles").doc(uid);

  await db.runTransaction(async (tx) => {
    const [orderSnap, merchantSnap] = await Promise.all([tx.get(orderRef), tx.get(merchantRef)]);
    if (!orderSnap.exists) throw new HttpsError("not-found", "অর্ডার পাওয়া যায়নি।");
    if (!merchantSnap.exists || merchantSnap.data().role !== "merchant" || merchantSnap.data().status !== "approved") {
      throw new HttpsError("permission-denied", "অনুমোদিত Merchant অ্যাকাউন্ট প্রয়োজন।");
    }
    const order = orderSnap.data();
    if (order.merchantId !== uid) throw new HttpsError("permission-denied", "এই অর্ডার আপনার Merchant অ্যাকাউন্টের নয়।");
    const allowed = (order.status === "accepted" && nextStatus === "preparing")
      || (order.status === "preparing" && nextStatus === "ready");
    if (!allowed) throw new HttpsError("failed-precondition", "অর্ডারের বর্তমান অবস্থায় এই পরিবর্তন করা যাবে না।");

    tx.update(orderRef, {
      status: nextStatus,
      updatedAt: FieldValue.serverTimestamp(),
      ...(nextStatus === "ready" ? { readyAt: FieldValue.serverTimestamp() } : {})
    });
    tx.create(db.collection("foodOrderEvents").doc(), {
      orderId,
      actorUid: uid,
      actorRole: "merchant",
      event: nextStatus,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true, orderId, status: nextStatus };
});


/**
 * Merchant creates or updates a food menu item.
 * Menu writes are server-only; price and ownership are never trusted from clients.
 */
exports.saveFoodMenuItem = onCall(async (request) => {
  const uid = requireUser(request);
  const itemId = String(request.data?.itemId || "").trim();
  const itemName = String(request.data?.itemName || "").trim();
  const description = String(request.data?.description || "").trim();
  const price = money(request.data?.price);
  const available = request.data?.available !== false;

  if (!itemName || itemName.length > 100 || description.length > 500 || price <= 0 || price > 100000) {
    throw new HttpsError("invalid-argument", "খাবারের নাম, বিবরণ ও মূল্য সঠিকভাবে দিন।");
  }
  if (itemId && (itemId.includes("/") || itemId.length > 100)) {
    throw new HttpsError("invalid-argument", "অবৈধ menu item ID।");
  }

  const profileRef = db.collection("merchantProfiles").doc(uid);
  const menuRef = itemId ? db.collection("foodMenuItems").doc(itemId) : db.collection("foodMenuItems").doc();
  await db.runTransaction(async (tx) => {
    const profileSnap = await tx.get(profileRef);
    if (!profileSnap.exists || profileSnap.data().role !== "merchant" || profileSnap.data().status !== "approved") {
      throw new HttpsError("permission-denied", "অনুমোদিত Merchant অ্যাকাউন্ট প্রয়োজন।");
    }
    if (itemId) {
      const existing = await tx.get(menuRef);
      if (!existing.exists || existing.data().merchantId !== uid) {
        throw new HttpsError("permission-denied", "এই Menu Item আপনার নয়।");
      }
    }
    const profile = profileSnap.data();
    tx.set(menuRef, {
      merchantId: uid,
      merchantName: profile.businessName,
      itemName,
      description,
      price,
      available,
      updatedAt: FieldValue.serverTimestamp(),
      ...(itemId ? {} : { createdAt: FieldValue.serverTimestamp() })
    }, { merge: true });
  });

  return { success: true, itemId: menuRef.id };
});

/**
 * Customer places an order from one merchant's currently available menu.
 * Prices and merchant ownership are read from Firestore in the transaction.
 * The order is pending; no service charge is marked as paid here.
 */
exports.placeFoodOrder = onCall(async (request) => {
  const uid = requireUser(request);
  const merchantId = String(request.data?.merchantId || "").trim();
  const deliveryAddress = String(request.data?.deliveryAddress || "").trim();
  const customerPhone = String(request.data?.customerPhone || "").trim();
  const rawItems = request.data?.items;

  if (!merchantId || merchantId.includes("/") || !deliveryAddress || deliveryAddress.length > 500
      || !/^01[3-9][0-9]{8}$/.test(customerPhone) || !Array.isArray(rawItems)
      || rawItems.length < 1 || rawItems.length > 20) {
    throw new HttpsError("invalid-argument", "ডেলিভারি ঠিকানা, ফোন নম্বর ও খাবারের তালিকা সঠিকভাবে দিন।");
  }

  const normalized = [];
  const seen = new Set();
  for (const item of rawItems) {
    const itemId = String(item?.itemId || "").trim();
    const quantity = Number(item?.quantity);
    if (!itemId || itemId.includes("/") || !Number.isInteger(quantity) || quantity < 1 || quantity > 20 || seen.has(itemId)) {
      throw new HttpsError("invalid-argument", "কার্টে খাবারের তথ্য সঠিক নয়।");
    }
    seen.add(itemId);
    normalized.push({ itemId, quantity });
  }

  const customerRef = db.collection("foodCustomerProfiles").doc(uid);
  const merchantRef = db.collection("merchantProfiles").doc(merchantId);
  const orderRef = db.collection("foodOrders").doc();
  let orderTotal = 0;
  let merchantName = "";
  const lineItems = [];

  await db.runTransaction(async (tx) => {
    const [customerSnap, merchantSnap] = await Promise.all([tx.get(customerRef), tx.get(merchantRef)]);
    if (!customerSnap.exists || customerSnap.data().role !== "food_customer") {
      throw new HttpsError("permission-denied", "Food Customer অ্যাকাউন্ট প্রয়োজন।");
    }
    if (!merchantSnap.exists || merchantSnap.data().role !== "merchant" || merchantSnap.data().status !== "approved") {
      throw new HttpsError("failed-precondition", "এই Merchant বর্তমানে অর্ডার নিতে পারবেন না।");
    }

    const itemRefs = normalized.map(x => db.collection("foodMenuItems").doc(x.itemId));
    const itemSnaps = await Promise.all(itemRefs.map(ref => tx.get(ref)));
    for (let i = 0; i < itemSnaps.length; i++) {
      const snap = itemSnaps[i];
      const requested = normalized[i];
      if (!snap.exists) throw new HttpsError("not-found", "কার্টের একটি খাবার পাওয়া যায়নি।");
      const data = snap.data();
      if (data.merchantId !== merchantId || data.available !== true) {
        throw new HttpsError("failed-precondition", "কার্টের একটি খাবার বর্তমানে পাওয়া যাচ্ছে না।");
      }
      const unitPrice = money(data.price);
      const lineTotal = money(unitPrice * requested.quantity);
      orderTotal = money(orderTotal + lineTotal);
      lineItems.push({
        itemId: requested.itemId,
        itemName: String(data.itemName),
        unitPrice,
        quantity: requested.quantity,
        lineTotal
      });
    }
    merchantName = String(merchantSnap.data().businessName);

    tx.create(orderRef, {
      customerId: uid,
      customerName: String(customerSnap.data().fullName || ""),
      customerPhone,
      merchantId,
      merchantName,
      items: lineItems,
      subtotal: orderTotal,
      serviceChargePaid: false,
      serviceCharge: 0,
      deliveryAddress,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("foodOrderEvents").doc(), {
      orderId: orderRef.id,
      actorUid: uid,
      actorRole: "food_customer",
      event: "order_placed",
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true, orderId: orderRef.id, subtotal: orderTotal, status: "pending" };
});

/**
 * FOOD DELIVERY: Rider updates delivery progress after accepting assignment.
 * Only the assigned rider can move an accepted order to picked_up/delivered.
 */
exports.updateFoodDeliveryStatus = onCall(async (request) => {
  const uid = requireUser(request);
  const orderId = String(request.data?.orderId || "").trim();
  const nextStatus = String(request.data?.status || "").trim();
  if (!orderId || orderId.includes("/") || !["picked_up", "delivered"].includes(nextStatus)) {
    throw new HttpsError("invalid-argument", "সঠিক orderId এবং picked_up/delivered status দিন।");
  }

  const orderRef = db.collection("foodOrders").doc(orderId);
  const profileRef = db.collection("foodRiderProfiles").doc(uid);
  await db.runTransaction(async (tx) => {
    const [orderSnap, profileSnap] = await Promise.all([tx.get(orderRef), tx.get(profileRef)]);
    if (!orderSnap.exists) throw new HttpsError("not-found", "অর্ডার পাওয়া যায়নি।");
    if (!profileSnap.exists || profileSnap.data().role !== "food_rider" || profileSnap.data().status !== "approved") {
      throw new HttpsError("permission-denied", "অনুমোদিত Food Rider অ্যাকাউন্ট প্রয়োজন।");
    }
    const order = orderSnap.data();
    if (order.riderId !== uid || !order.riderAcceptedAt) {
      throw new HttpsError("permission-denied", "এই ডেলিভারি আপনার নামে গ্রহণ করা হয়নি।");
    }
    if (nextStatus === "picked_up" && order.status !== "rider_assigned") {
      throw new HttpsError("failed-precondition", "শুধু গ্রহণ করা অর্ডার Pickup করা যাবে।");
    }
    if (nextStatus === "delivered" && order.status !== "picked_up") {
      throw new HttpsError("failed-precondition", "Pickup সম্পন্ন করার পর Delivered করা যাবে।");
    }
    tx.update(orderRef, {
      status: nextStatus,
      ...(nextStatus === "picked_up" ? { pickedUpAt: FieldValue.serverTimestamp() } : { deliveredAt: FieldValue.serverTimestamp() }),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("foodOrderEvents").doc(), {
      orderId, actorUid: uid, actorRole: "food_rider", event: nextStatus,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { success: true, orderId, status: nextStatus };
});


/**
 * ADMIN CONTROL: Only the existing Super Admin (legacy admin custom claim)
 * may provision or change service-admin accounts. Never expose Admin SDK
 * credentials to the browser.
 */
const ADMIN_ROLES = ["ride", "food", "food_rider", "finance", "support", "system"];

function requireSuperAdmin(request) {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "শুধু Super Admin এই কাজ করতে পারবেন।");
  }
  return request.auth.uid;
}

exports.createServiceAdmin = onCall(async (request) => {
  const actorUid = requireSuperAdmin(request);
  const email = String(request.data?.email || "").trim().toLowerCase();
  const password = String(request.data?.password || "");
  const displayName = String(request.data?.displayName || "").trim();
  const role = String(request.data?.role || "").trim();

  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 ||
      displayName.length < 2 || displayName.length > 100 ||
      !ADMIN_ROLES.includes(role)) {
    throw new HttpsError("invalid-argument", "সঠিক নাম, Email, কমপক্ষে ৮ অক্ষরের Password এবং Admin Role দিন।");
  }

  let user;
  try {
    user = await getAuth().createUser({ email, password, displayName, disabled: false });
    await getAuth().setCustomUserClaims(user.uid, {
      admin: false,
      superAdmin: false,
      adminRoles: [role]
    });
    await db.collection("adminAccounts").doc(user.uid).set({
      uid: user.uid, email, displayName, role, status: "active",
      createdBy: actorUid, createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    await db.collection("adminAuditLogs").add({
      actorUid, targetUid: user.uid, action: "admin_created", role,
      createdAt: FieldValue.serverTimestamp()
    });
    return { success: true, uid: user.uid, email, role };
  } catch (error) {
    if (user?.uid) {
      await getAuth().deleteUser(user.uid).catch(() => {});
    }
    if (error instanceof HttpsError) throw error;
    if (error.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "এই Email দিয়ে আগে থেকেই অ্যাকাউন্ট আছে।");
    }
    console.error("createServiceAdmin:", error);
    throw new HttpsError("internal", "Admin অ্যাকাউন্ট তৈরি করা যায়নি।");
  }
});

exports.changeServiceAdminRole = onCall(async (request) => {
  const actorUid = requireSuperAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  const role = String(request.data?.role || "").trim();
  if (!uid || uid === actorUid || !ADMIN_ROLES.includes(role)) {
    throw new HttpsError("invalid-argument", "সঠিক Admin UID ও Role দিন।");
  }
  const user = await getAuth().getUser(uid);
  if (user.customClaims?.admin === true) {
    throw new HttpsError("failed-precondition", "Super Admin-এর Role এখানে পরিবর্তন করা যাবে না।");
  }
  await getAuth().setCustomUserClaims(uid, {
    ...(user.customClaims || {}), admin: false, superAdmin: false, adminRoles: [role]
  });
  await db.collection("adminAccounts").doc(uid).set({
    uid, email: user.email || "", displayName: user.displayName || "",
    role, status: user.disabled ? "disabled" : "active",
    updatedBy: actorUid, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await db.collection("adminAuditLogs").add({
    actorUid, targetUid: uid, action: "admin_role_changed", role,
    createdAt: FieldValue.serverTimestamp()
  });
  return { success: true, uid, role };
});

exports.disableServiceAdmin = onCall(async (request) => {
  const actorUid = requireSuperAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  if (!uid || uid === actorUid) throw new HttpsError("invalid-argument", "নিজের ID বা ফাঁকা UID নিষ্ক্রিয় করা যাবে না।");
  const user = await getAuth().getUser(uid);
  if (user.customClaims?.admin === true) {
    throw new HttpsError("failed-precondition", "Super Admin ID নিষ্ক্রিয় করা যাবে না।");
  }
  await getAuth().updateUser(uid, { disabled: true });
  await getAuth().setCustomUserClaims(uid, {
    ...(user.customClaims || {}), admin: false, superAdmin: false, adminRoles: []
  });
  await db.collection("adminAccounts").doc(uid).set({
    status: "disabled", updatedBy: actorUid, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await db.collection("adminAuditLogs").add({
    actorUid, targetUid: uid, action: "admin_disabled",
    createdAt: FieldValue.serverTimestamp()
  });
  return { success: true, uid, status: "disabled" };
});
