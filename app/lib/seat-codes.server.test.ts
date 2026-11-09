import { describe, it, expect } from "vitest";
import { getSeatCodeStatus } from "./seat-codes.server";

describe("getSeatCodeStatus", () => {
  it("accepts a code nobody has redeemed or voided", () => {
    expect(
      getSeatCodeStatus({ redeemedByUserId: null, voidedAt: null })
    ).toEqual({ redeemable: true });
  });

  it("refuses a missing code", () => {
    expect(getSeatCodeStatus(undefined)).toMatchObject({
      redeemable: false,
      reason: "not_found",
    });
  });

  it("refuses a redeemed code", () => {
    expect(
      getSeatCodeStatus({ redeemedByUserId: 5, voidedAt: null })
    ).toMatchObject({ redeemable: false, reason: "redeemed" });
  });

  it("refuses a voided code and says the purchase was refunded", () => {
    const status = getSeatCodeStatus({
      redeemedByUserId: null,
      voidedAt: "2026-11-05T10:00:00.000Z",
    });

    expect(status).toMatchObject({ redeemable: false, reason: "voided" });
    expect(status.redeemable === false && status.message).toMatch(/refunded/);
  });
});
