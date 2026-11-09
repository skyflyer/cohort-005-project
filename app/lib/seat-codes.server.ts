import type { coupons } from "~/db/schema";

type SeatCode = Pick<
  typeof coupons.$inferSelect,
  "redeemedByUserId" | "voidedAt"
>;

export type SeatCodeStatus<T extends SeatCode = SeatCode> =
  | { redeemable: true; coupon: T }
  | {
      redeemable: false;
      reason: "not_found" | "voided" | "redeemed";
      message: string;
    };

/**
 * Whether a team seat code can be redeemed right now. A voided code (its
 * purchase was refunded) is reported before a redeemed one.
 */
export function getSeatCodeStatus<T extends SeatCode>(
  coupon: T | null | undefined
): SeatCodeStatus<T> {
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
  return { redeemable: true, coupon };
}
