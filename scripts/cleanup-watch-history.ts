import { deleteExpiredWatchHistory } from "../app/lib/watch-history-cleanup.server";

const deleted = deleteExpiredWatchHistory();
console.log(`Deleted ${deleted} watch history rows.`);
