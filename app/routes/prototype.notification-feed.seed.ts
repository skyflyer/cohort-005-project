// PROTOTYPE (#36) — sends one of each catalogue Notification to the current user.
import { data } from "react-router";
import type { Route } from "./+types/prototype.notification-feed.seed";
import { getCurrentUserId } from "~/lib/session";
import { seedCatalogue } from "~/lib/notification-feed-prototype.server";

export async function action({ request }: Route.ActionArgs) {
  const id = await getCurrentUserId(request);
  if (!id) throw data("Select a user from the DevUI panel.", { status: 401 });
  return { sent: await seedCatalogue(id) };
}
