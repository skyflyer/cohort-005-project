import type { coupons } from "~/db/schema";

export type SeatCodeStatus =
  | { redeemable: true }
  | {
      redeemable: false;
      reason: "not_found" | "voided" | "redeemed";
      message: string;
    };

/**
 * Whether a team seat code can be redeemed right now. A voided code (its
 * purchase was refunded) is reported before a redeemed one.
 */
export function getSeatCodeStatus(
  coupon:
    | Pick<typeof coupons.$inferSelect, "redeemedByUserId" | "voidedAt">
    | null
    | undefined
): SeatCodeStatus {
  if (!coupon) {
    return {
      redeemable: false,
      reason: "not_found",
      message: "Coupon not found",
    };
  }
  if (coupon.voidedAt !== null) {
    return {
      redeemable: false,
      reason: "voided",
      message:
        "This seat code is no longer valid because the purchase was refunded.",
    };
  }
  if (coupon.redeemedByUserId !== null) {
    return {
      redeemable: false,
      reason: "redeemed",
      message: "Coupon has already been redeemed",
    };
  }
  return { redeemable: true };
}
