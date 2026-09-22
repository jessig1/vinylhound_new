import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { z } from "zod";

import {
  ensureDevelopmentUser,
  getOrCreateUserIdByClerkId,
} from "@vinylhound/database";

import type { ServerContext } from "./context";
import { HttpError } from "./http";

// Bench-only: lets a local load-test script address many distinct synthetic
// users in AUTH_MODE=development, where every request otherwise resolves to
// the same fixed DEVELOPMENT_USER_ID (see packages/config's
// DEVELOPMENT_BENCH_USER_HEADER_ENABLED, default off). Never consulted in
// production, which authenticates through Clerk below instead.
const BENCH_USER_ID_HEADER = "x-vinylhound-bench-user-id";

async function resolveDevelopmentUserId(
  context: ServerContext,
): Promise<string> {
  if (!context.config.DEVELOPMENT_BENCH_USER_HEADER_ENABLED) {
    return context.config.DEVELOPMENT_USER_ID;
  }
  const headerValue = (await headers()).get(BENCH_USER_ID_HEADER);
  const parsed = z.string().uuid().safeParse(headerValue);
  return parsed.success ? parsed.data : context.config.DEVELOPMENT_USER_ID;
}

export async function requireUserId(context: ServerContext): Promise<string> {
  if (context.config.AUTH_MODE === "development") {
    const userId = await resolveDevelopmentUserId(context);
    await ensureDevelopmentUser(context.database.core, userId);
    return userId;
  }

  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    throw new HttpError(401, "unauthenticated", "Sign in is required.");
  }
  return getOrCreateUserIdByClerkId(context.database.core, clerkUserId);
}
