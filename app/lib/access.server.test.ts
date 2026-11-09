import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { requireAdmin } from "./access.server";

// The session cookie is the boundary: stand in for "who is signed in".
vi.mock("~/lib/session", () => ({ getCurrentUserId: vi.fn() }));

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
