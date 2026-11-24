# BLAZING-WAY Food Delivery Policy

Status: Business policy draft for implementation. This document does not activate Food Delivery or collect money.

## 1. Merchant fee
- Each time a merchant accepts a unique food order, BLAZING-WAY charges the merchant BDT 1.
- The fee is per accepted order, not per customer. One customer placing 10 accepted orders creates 10 separate merchant fees (BDT 10 total).
- The BDT 1 fee is non-refundable if the order is later cancelled.
- A duplicate acceptance event for the same order must never charge the fee twice.

## 2. Delivery rider fee
- Each time a delivery rider accepts a unique delivery assignment, BLAZING-WAY charges that rider BDT 1.
- The fee is per accepted delivery assignment. Ten accepted assignments create ten separate rider fees (BDT 10 total).
- A duplicate acceptance event for the same assignment must never charge the fee twice.

## 3. Delivery charge split
- For a successful delivery, BLAZING-WAY receives 5% of the delivery charge and the rider receives 95%.
- If a rider has accepted the delivery and the order is subsequently cancelled, the rider remains entitled to the delivery charge under the agreed cancellation policy. The exact amount and payer (customer or merchant) must be shown before cancellation is confirmed; do not silently charge a customer.

## 4. Merchant's own rider
- A merchant may use its own registered rider.
- The merchant's own rider does not create a BLAZING-WAY independent-rider delivery commission unless the delivery is assigned to a BLAZING-WAY independent rider.
- Merchant's BDT 1 accepted-order fee still applies.

## 5. Order lifecycle and fraud prevention
- Suggested states: pending, accepted, preparing, ready, rider_assigned, picked_up, delivered, cancellation_requested, cancelled, disputed.
- Merchant and rider may request cancellation with a reason; they cannot unilaterally mark a delivered order as cancelled.
- Customer delivery OTP should be generated for the order and verified before marking delivered.
- Once delivered, the order cannot be changed to cancelled. Corrections require an admin dispute/refund record.
- Keep an immutable audit ledger for each status change and every fee/commission entry, with order ID, actor UID, amount, timestamp, and reason.
- Use server-side transactions and idempotency keys for all fee deductions and settlements. Never trust client-side fee calculations.

## 6. Example: 10 accepted orders by one customer
- Merchant fee: 10 × BDT 1 = BDT 10.
- Rider fee: 10 × BDT 1 = BDT 10, if the same 10 deliveries are accepted by a BLAZING-WAY rider.
- These are separate from the 5% delivery-charge commission on applicable rider deliveries.

## 7. Activation requirements
- The current Firebase Spark plan cannot deploy Firebase Cloud Functions. Secure automatic deductions and OTP verification require trusted server-side code (Cloud Functions or another secured backend).
- Before enabling live transactions, update and test Firestore Security Rules, implement merchant/rider role approval, and decide the cancellation payer/amount display.
- Until that work is complete, this policy is a specification only; no fee should be charged automatically.
