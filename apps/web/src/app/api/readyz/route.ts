import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getServerContext } from "@/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Does not expose dependency details: monitoring gets a simple 503 when this
// instance cannot safely serve durable requests.
export async function GET() {
  try {
    const context = getServerContext();
    // P4.2 Task 7 (ADR-0030): both role-scoped connections must be checked --
    // a broken GRANT or a wrong credential on either one should fail
    // readiness, not just a shared pool that happened to still connect.
    await Promise.all([
      context.database.scan.execute(sql`select 1`),
      context.database.core.execute(sql`select 1`),
    ]);
    return NextResponse.json(
      { status: "ready" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
