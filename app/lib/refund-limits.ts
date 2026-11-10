/** The longest decline message an admin can send, in characters. */
export const MAX_DECLINE_MESSAGE_LENGTH = 1000;

/** Shown to the learner on the refund request form and in the request-received email. */
export const REFUND_PROGRESS_WARNING =
  "If your refund request is approved, you will lose access to this course and your progress in it will be deleted: your lesson progress, quiz attempts and answers, and your rating. This cannot be undone.";

/** Shown instead of the progress warning when the purchase is a team purchase. */
export const REFUND_TEAM_PURCHASE_NOTICE =
  "If your refund request is approved, the seat codes from this purchase that nobody has used yet will stop working. Your own access to the course is not affected.";
