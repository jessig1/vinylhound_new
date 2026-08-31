import { auth } from "@clerk/nextjs/server";

import {
  ensureDevelopmentUser,
  getOrCreateUserIdByClerkId,
} from "@vinylhound/database";

import type { ServerContext } from "./context";
import { HttpError } from "./http";

export async function requireUserId(context: ServerContext): Promise<string> {
  if (context.config.AUTH_MODE === "development") {
    const userId = context.config.DEVELOPMENT_USER_ID;
    await ensureDevelopmentUser(context.database.db, userId);
    return userId;
  }

  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    throw new HttpError(401, "unauthenticated", "Sign in is required.");
  }
  return getOrCreateUserIdByClerkId(context.database.db, clerkUserId);
}
