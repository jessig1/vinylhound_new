import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/healthz",
  "/api/readyz",
]);

// AUTH_MODE=development (the default) has no Clerk session to check, and
// clerkMiddleware() itself throws without a publishable key, so development
// mode must never construct it at all. requireUserId falls back to
// DEVELOPMENT_USER_ID for every request instead. This mirrors
// packages/config's own development/production split so local dev, CI, and
// integration/e2e tests never need Clerk keys.
const isProductionAuth = process.env.AUTH_MODE === "production";

export default isProductionAuth
  ? clerkMiddleware(async (auth, request) => {
      if (isPublicRoute(request)) return;

      const { userId } = await auth();
      if (userId) return;

      if (request.nextUrl.pathname.startsWith("/api/")) {
        return NextResponse.json(
          {
            error: {
              code: "unauthenticated",
              message: "Sign in is required.",
            },
          },
          { status: 401 },
        );
      }

      const signInUrl = new URL("/sign-in", request.url);
      signInUrl.searchParams.set("redirect_url", request.nextUrl.pathname);
      return NextResponse.redirect(signInUrl);
    })
  : () => NextResponse.next();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js|jsx|ts|tsx|json|png|jpe?g|gif|svg|webp|ico|woff2?)).*)",
    "/api/(.*)",
  ],
};
