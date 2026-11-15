import { Knock } from "@knocklabs/node";

// One Knock Node client factory: 3s timeout, 1 retry, so a slow Knock never
// holds up the request that triggered it.
export function createKnockClient(secretKey: string): Knock {
  return new Knock({ apiKey: secretKey, timeout: 3000, maxRetries: 1 });
}
