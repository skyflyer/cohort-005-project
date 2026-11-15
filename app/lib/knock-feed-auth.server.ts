import { signUserToken } from "@knocklabs/node";

import "~/lib/env.server";
import { knockUserId } from "~/lib/knock-user-id";

export type FeedAuth = {
  token: string;
  publicKey: string;
  channelId: string;
};

// Knock's enhanced security mode is on, so every feed request carries a
// per-user RS256 token signed here. Returns null when Knock isn't configured
// or signing fails; the Feed then shows its error state and nothing else breaks.
export async function signFeedAuth(userId: number): Promise<FeedAuth | null> {
  const publicKey = process.env.KNOCK_PUBLIC_API_KEY;
  const channelId = process.env.KNOCK_FEED_CHANNEL_ID;
  if (!publicKey || !channelId || !process.env.KNOCK_SIGNING_KEY) return null;
  try {
    // Reads KNOCK_SIGNING_KEY (base-64 PEM) from env.
    const token = await signUserToken(knockUserId(userId), {
      expiresInSeconds: 60 * 60,
    });
    return { token, publicKey, channelId };
  } catch (error) {
    console.error("Failed to sign Knock feed token", error);
    return null;
  }
}
