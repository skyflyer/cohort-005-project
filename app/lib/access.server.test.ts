import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { getAccess, requireAdmin } from "./access.server";
import { getUserEnrolledCourses } from "./enrollments.server";
import { approveRefundRequest } from "./refund-requests.server";

// The session cookie is the boundary: stand in for "who is signed in".
vi.mock("~/lib/session", () => ({ getCurrentUserId: vi.fn() }));

// Where the request comes from is irrelevant here: a full-price course is never country-blocked.
vi.mock("~/lib/country.server", () => ({
  resolveCountry: vi.fn().mockResolvedValue("US"),
}));

const request = new Request("http://localhost/admin/refunds");

function setup() {
  const testDb = createTestDb();
  const makeUser = (role: schema.UserRole) =>
    testDb
      .insert(schema.users)
      .values({ name: role, email: `${role}@example.com`, role })
      .returning()
      .get();
  return {
    testDb,
    admin: makeUser(schema.UserRole.Admin),
    instructor: makeUser(schema.UserRole.Instructor),
    student: makeUser(schema.UserRole.Student),
  };
}

async function statusOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (thrown) {
    return (thrown as { init?: { status?: number } }).init?.status;
  }
  return undefined;
}

describe("requireAdmin", () => {
  beforeEach(() => {
    vi.mocked(getCurrentUserId).mockReset();
  });

  it("returns the admin", async () => {
    const { testDb, admin } = setup();
    vi.mocked(getCurrentUserId).mockResolvedValue(admin.id);

    const result = await requireAdmin(request, testDb);

    expect(result.userId).toBe(admin.id);
  });

  it("throws 403 for a student", async () => {
    const { testDb, student } = setup();
    vi.mocked(getCurrentUserId).mockResolvedValue(student.id);

    expect(await statusOf(requireAdmin(request, testDb))).toBe(403);
  });

  it("throws 403 for an instructor", async () => {
    const { testDb, instructor } = setup();
    vi.mocked(getCurrentUserId).mockResolvedValue(instructor.id);

    expect(await statusOf(requireAdmin(request, testDb))).toBe(403);
  });

  it("throws 401 when nobody is signed in", async () => {
    const { testDb } = setup();
    vi.mocked(getCurrentUserId).mockResolvedValue(null);

    expect(await statusOf(requireAdmin(request, testDb))).toBe(401);
  });
});

describe("after a refund is approved", () => {
  it("the learner is not enrolled, cannot view the content and has no course on their dashboard", async () => {
    const { testDb, admin, student, instructor } = setup();
    const category = testDb
      .insert(schema.categories)
      .values({ name: "Programming", slug: "programming" })
      .returning()
      .get();
    const course = testDb
      .insert(schema.courses)
      .values({
        title: "Refunded Course",
        slug: "refunded-course",
        description: "d",
        salesCopy: "s",
        instructorId: instructor.id,
        categoryId: category.id,
        status: schema.CourseStatus.Published,
        price: 10000,
      })
      .returning()
      .get();
    testDb
      .insert(schema.enrollments)
      .values({ userId: student.id, courseId: course.id })
      .run();
    const purchase = testDb
      .insert(schema.purchases)
      .values({ userId: student.id, courseId: course.id, amountPaid: 10000 })
      .returning()
      .get();
    const refund = testDb
      .insert(schema.refunds)
      .values({ purchaseId: purchase.id, reason: "Not for me" })
      .returning()
      .get();
    vi.mocked(getCurrentUserId).mockResolvedValue(student.id);

    const before = await getAccess(request, course.id, testDb);
    expect(before).toMatchObject({ enrolled: true, canViewContent: true });
    expect(getUserEnrolledCourses(student.id, testDb)).toHaveLength(1);

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    const after = await getAccess(request, course.id, testDb);
    expect(after).toMatchObject({ enrolled: false, canViewContent: false });
    expect(getUserEnrolledCourses(student.id, testDb)).toEqual([]);
  });
});
