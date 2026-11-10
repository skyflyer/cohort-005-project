import { describe, expect, it } from "vitest";
import {
  declineMessageSchema,
  MAX_DECLINE_MESSAGE_LENGTH,
} from "./refund-limits";

describe("declineMessageSchema", () => {
  it("trims the message", () => {
    expect(declineMessageSchema.parse("  Too late  ")).toBe("Too late");
  });

  it("rejects an empty message", () => {
    expect(declineMessageSchema.safeParse("").success).toBe(false);
  });

  it("rejects a whitespace-only message", () => {
    expect(declineMessageSchema.safeParse("  \n\t ").success).toBe(false);
  });

  it("rejects a message over the limit", () => {
    const tooLong = "a".repeat(MAX_DECLINE_MESSAGE_LENGTH + 1);
    expect(declineMessageSchema.safeParse(tooLong).success).toBe(false);
  });
});
