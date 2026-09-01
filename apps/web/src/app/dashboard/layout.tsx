import type { ReactNode } from "react";

import { countLibraryItemsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { DashboardShell } from "../dashboard-shell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const context = getServerContext();
  const userId = await requireUserId(context);
  const [collectionCount, wishlistCount] = await Promise.all([
    countLibraryItemsForUser(context.database.db, {
      userId,
      list: "collection",
    }),
    countLibraryItemsForUser(context.database.db, {
      userId,
      list: "wishlist",
    }),
  ]);
  return (
    <DashboardShell
      collectionCount={collectionCount}
      wishlistCount={wishlistCount}
    >
      {children}
    </DashboardShell>
  );
}
