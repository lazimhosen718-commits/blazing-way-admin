# BLAZING-WAY Driver Payout Policy

## Approved driver payout choices

Drivers will be able to choose one of these payout schedules:

1. **Automatic payout every 24 hours** — eligible available earnings are paid once per 24-hour cycle.
2. **Instant withdrawal** — the driver may request an early payout before the next 24-hour cycle.

Supported payout destinations: bKash, Nagad, Rocket, and Bank.

## Fees

- BLAZING-WAY does not impose a mandatory flat BDT 5 driver-withdrawal fee.
- If a payout provider or bank actually charges a transaction fee, show the exact fee to the driver before confirmation.
- Do not deduct an estimated or undisclosed fee.
- This driver policy does not change the separate passenger withdrawal policy.

## Implementation status and safety

- The callable withdrawal request now sets the driver withdrawal fee to BDT 0.
- The current callable creates a pending request for administrator review; it does **not** transfer money.
- Automatic 24-hour payouts and true instant transfers are **not live** until a supported payout provider/bank API, credentials, reconciliation, failure handling, and scheduled payout worker are integrated and tested.
- Never mark a payout as paid until the provider confirms the transfer.
- Keep an auditable record of payout amount, provider fee, destination, provider reference, status, timestamps, and any failure/reversal.
