# BLAZING-WAY Food Delivery Policy

Status: Business policy draft for implementation. This document does not activate Food Delivery or collect money.

## 1. Merchant fee
- Each time a merchant accepts a unique food order, BLAZING-WAY charges the merchant BDT 1.
- The fee is per accepted order, not per customer. One customer placing 10 accepted orders creates 10 separate merchant fees (BDT 10 total).
- The BDT 1 fee is non-refundable if the order is later cancelled.
- A duplicate acceptance event for the same order must never charge the fee twice.

## 2. Delivery rider fee
- Each time a BLAZING-WAY delivery rider accepts a unique delivery assignment, BLAZING-WAY charges that rider BDT 1.
- The fee is per accepted delivery assignment. Ten accepted assignments create ten separate rider fees (BDT 10 total).
- A duplicate acceptance event for the same assignment must never charge the fee twice.
- If the merchant uses its own rider, no BLAZING-WAY independent-rider acceptance fee is charged.

## 3. Customer service/delivery charge
- BLAZING-WAY's platform income is limited to the fixed BDT 1 merchant acceptance fee and BDT 1 BLAZING-WAY rider acceptance fee described above.
- The customer service/delivery charge is payable only if the customer actually pays it. If the customer does not pay, no service/delivery charge is collected; do not create an unpaid debt or force a charge.
- BLAZING-WAY does not take a 5% commission from the customer service/delivery charge. The service/delivery charge is settled by the relevant service provider(s), outside BLAZING-WAY's platform commission.
- The fixed BDT 1 acceptance fees already charged remain non-refundable if the order is later cancelled.

## 4. Cancelled orders
- If an order is cancelled, BLAZING-WAY takes no 5% commission from any delivery charge or cancellation charge.
- The merchant and rider settle any delivery/cancellation charge between themselves directly, if applicable.
- BLAZING-WAY does not monitor, verify, collect, or control that merchant-rider settlement.
- If the service is not provided and the customer does not pay, no service/delivery charge is collected.
- The BDT 1 merchant fee and, where applicable, BDT 1 BLAZING-WAY rider acceptance fee already charged are not refunded.

## 5. Merchant's own rider
- A merchant may use its own rider.
- The merchant's own rider does not create a BLAZING-WAY independent-rider acceptance fee.
- The merchant's BDT 1 accepted-order fee still applies.

## 6. Order lifecycle and fraud prevention
- Suggested states: pending, accepted, preparing, ready, rider_assigned, picked_up, delivered, cancellation_requested, cancelled, disputed.
- Merchant and rider may request cancellation with a reason; they cannot unilaterally mark a delivered order as cancelled.
- Customer delivery OTP should be generated for the order and verified before marking delivered.
- Once delivered, the order cannot be changed to cancelled. Corrections require an admin dispute/refund record.
- Keep an immutable audit ledger for each status change and every fee entry, with order ID, actor UID, amount, timestamp, and reason.
- Use server-side transactions and idempotency keys for all fee deductions. Never trust client-side fee calculations.

## 7. Example: 10 accepted orders by one customer
- Merchant fee: 10 × BDT 1 = BDT 10.
- Rider fee: 10 × BDT 1 = BDT 10, if all 10 deliveries are accepted by BLAZING-WAY riders.
- These fixed acceptance fees are BLAZING-WAY's platform income. No 5% delivery-charge commission is added.

## 8. Activation requirements
- The current Firebase Spark plan cannot deploy Firebase Cloud Functions. Secure automatic deductions and OTP verification require trusted server-side code (Cloud Functions or another secured backend).
- Before enabling live transactions, update and test Firestore Security Rules, implement merchant/rider role approval, and build the order, payment, and audit flows to match this policy.
- Until that work is complete, this policy is a specification only; no fee should be charged automatically.
