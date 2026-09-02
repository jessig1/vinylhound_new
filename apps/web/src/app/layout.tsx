import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { isProductionAuth } from "./auth-mode";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "VinylHound",
    template: "%s · VinylHound",
  },
  description: "Identify, collect, and remember the records you want.",
};

export const viewport: Viewport = {
  themeColor: "#20221f",
};

// Clerk's browser-visible publishable key is injected by ECS when the
// standalone server starts. Prevent a build-time placeholder from being
// captured in prerendered output.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const body = (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );

  // Bracket access keeps this browser-visible value runtime configurable in
  // the standalone server. CLERK_SECRET_KEY stays server-only.
  const publishableKey =
    process.env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] ?? undefined;

  return isProductionAuth ? (
    <ClerkProvider publishableKey={publishableKey}>{body}</ClerkProvider>
  ) : (
    body
  );
}
