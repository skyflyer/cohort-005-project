// The one place a Cadence user id becomes a Knock user id.
export function knockUserId(id: number): string {
  return String(id);
}
