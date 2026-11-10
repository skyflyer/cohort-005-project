import { describe, it, expect } from "vitest";
import { formatDate } from "./utils";

describe("formatDate", () => {
  it("formats as month day, year in en-US", () => {
    expect(formatDate("2026-11-06T10:00:00.000Z")).toBe("Nov 6, 2026");
  });

  it("uses the UTC day, whatever the machine's time zone", () => {
    expect(formatDate("2026-11-06T23:30:00.000Z")).toBe("Nov 6, 2026");
  });
});
