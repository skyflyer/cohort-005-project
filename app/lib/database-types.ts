import type { db } from "~/db";

/** The application database, or an in-memory one passed in by a test. */
export type Database = typeof db;

/** Anything that can run a select: the database or a transaction handle. */
export type DatabaseReader = Pick<Database, "select">;

/** The handle a `database.transaction` callback receives. */
export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
