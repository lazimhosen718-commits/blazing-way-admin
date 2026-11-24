# BLAZING-WAY Food Delivery Policy

Status: Business policy specification. This document does not by itself activate Food Delivery or collect money.

## 1. Merchant acceptance fee
- For every unique food order accepted by a merchant, BLAZING-WAY earns BDT 1 from that merchant.
- The fee applies once per accepted order.
- The fee is non-refundable if the order is later cancelled.
- Duplicate acceptance events for the same order must never create a second fee.

## 2. Rider acceptance fee
- For every unique delivery order accepted by a rider, BLAZING-WAY earns BDT 1 from that rider.
- This fee applies regardless of who owns or employs the rider. A merchant's own rider is also charged BDT 1 when accepting the delivery.
- The fee applies once per accepted delivery assignment and is non-refundable if the order is later cancelled.
- Duplicate acceptance events for the same assignment must never create a second fee.

## 3. BLAZING-WAY acceptance-fee income
- Each order accepted by a merchant and a rider creates BDT 2 in fixed BLAZING-WAY acceptance-fee income: BDT 1 merchant fee + BDT 1 rider fee.
- If an order has not been accepted by a rider, the rider fee has not yet arisen.
- No separate per-order Admin approval is required. Admin approves merchant and rider accounts once; approved merchants and riders can accept eligible orders themselves.

## 4. Customer service charge
- The customer service charge is collected only if the customer actually pays it. If the customer does not pay, no service charge is collected and no unpaid debt is created or forced.
- When the customer pays the service charge, the previously agreed split applies: 5% to BLAZING-WAY and 95% to the rider.
- The fixed BDT 1 merchant and BDT 1 rider acceptance fees are separate from the customer service charge.

## 5. Cancelled orders
- BLAZING-WAY takes no 5% commission from a delivery charge or cancellation charge for a cancelled order.
- The merchant and rider settle any delivery/cancellation charge between themselves directly, if applicable. BLAZING-WAY does not monitor, verify, collect, or control that settlement.
- If the customer does not pay, no service/delivery charge is collected.
- Any BDT 1 merchant and BDT 1 rider acceptance fees already charged remain non-refundable.

## 6. Order lifecycle and audit
- Suggested states: pending, accepted, preparing, ready, rider_assigned, picked_up, delivered, cancellation_requested, cancelled, disputed.
- Merchant and rider may request cancellation with a reason; they cannot unilaterally change a delivered order to cancelled.
- Customer delivery OTP should be generated and verified before marking delivered.
- Once delivered, an order cannot be changed to cancelled. Corrections require an Admin dispute/refund record.
- Keep an immutable audit ledger for every status change and fee entry, including order ID, actor UID, amount, timestamp, and reason.
- Use trusted server-side transactions and idempotency keys for all fee deductions. Never trust client-side fee calculations.

## 7. Account approval
- Admin reviews and approves each merchant account once.
- Admin reviews and approves each rider account once.
- After approval, merchants can accept orders and riders can accept delivery assignments without per-order Admin approval.

## 8. Activation and security
- Before live transactions, update and test Firestore Security Rules, implement merchant/rider registration and approval, and build order, payment, and audit flows to match this policy.
- Secure automatic fee deductions require trusted server-side code. Do not enable automatic fee collection through client-side code alone.
