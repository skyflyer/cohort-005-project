// PROTOTYPE — throwaway spike for "Does Knock hold up against Cadence?" (#38).
// Lives only on the prototype/knock-spike branch. Not production code.
import { Knock, signUserToken } from "@knocklabs/node";

// React Router dev doesn't load .env into process.env, so do it here.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env — the checks will fail loudly below
}

export const knock = new Knock({ apiKey: process.env.KNOCK_SECRET_API_KEY });

export const KNOCK_PUBLIC_API_KEY = process.env.KNOCK_PUBLIC_API_KEY ?? "";
export const KNOCK_FEED_CHANNEL_ID = process.env.KNOCK_FEED_CHANNEL_ID ?? "";

export const WORKFLOW_DISCUSSION_REPLY = "discussions-reply";
export const WORKFLOW_NEW_ENROLLMENT = "new-enrollment";

export function signTokenFor(userId: number) {
  // Reads KNOCK_SIGNING_KEY (base-64 PEM) from env.
  return signUserToken(String(userId), { expiresInSeconds: 60 * 60 });
}
