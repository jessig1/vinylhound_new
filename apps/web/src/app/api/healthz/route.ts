import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Deliberately dependency-free: load balancers use this to determine whether
// the web process can accept a request, not whether every provider is healthy.
export function GET() {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store" } },
  );
}
