/**
 * How long a pending sign-in holds one of its network's slots (reserve_auth_state, migrations/105_auth_state_slots.sql:
 * 8 at once, each for 11 minutes), so the longest any refusal at that cap asks a caller to wait. Without runtime imports,
 * so the dashboard never holds a sign-in button longer than the API would (app/src/lib/countdown.ts).
 */
export const AUTH_STATE_SECONDS = 660;
