import Link from "next/link";

import { USAGE_SUMMARY_WINDOW_DAYS } from "@vinylhound/contracts";
import { getUsageSummaryForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { Icon } from "../../ui";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const context = getServerContext();
  const userId = await requireUserId(context);
  const since = new Date(
    Date.now() - USAGE_SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  );
  const summary = await getUsageSummaryForUser(context.database.db, {
    userId,
    since,
  });

  return (
    <main className="content-page account-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Account</p>
          <h1>Usage and cost</h1>
          <p>
            Scans and estimated provider spend over the last{" "}
            {USAGE_SUMMARY_WINDOW_DAYS} days.
          </p>
        </div>
      </header>

      <div className="account-grid">
        <section className="settings-card">
          <div className="settings-card__heading">
            <span>
              <Icon name="camera" />
            </span>
            <div>
              <h2>Scans</h2>
              <p>{summary.scanCount} total in this window</p>
            </div>
          </div>
          <StatRow label="Matched" value={summary.outcomes.identified} />
          <StatRow label="Needs review" value={summary.outcomes.needsReview} />
          <StatRow label="No match" value={summary.outcomes.unresolved} />
          <StatRow label="Failed" value={summary.outcomes.failed} />
          <StatRow label="Canceled" value={summary.outcomes.canceled} />
          <StatRow label="In progress" value={summary.outcomes.inProgress} />
        </section>

        <section className="settings-card">
          <div className="settings-card__heading">
            <span>
              <Icon name="sparkle" />
            </span>
            <div>
              <h2>Provider cost</h2>
              <p>Estimated from recorded token usage</p>
            </div>
          </div>
          <StatRow
            label="Estimated spend"
            value={formatCost(summary.cost.estimatedCostUsd)}
          />
          <StatRow
            label="Total tokens"
            value={summary.cost.totalTokens.toLocaleString()}
          />
          <StatRow
            label="Input tokens"
            value={summary.cost.totalInputTokens.toLocaleString()}
          />
          <StatRow
            label="Output tokens"
            value={summary.cost.totalOutputTokens.toLocaleString()}
          />
          <StatRow
            label="Provider attempts"
            value={summary.cost.attemptCount}
          />
          <StatRow
            label="Average duration"
            value={formatDuration(summary.cost.averageDurationMs)}
          />
        </section>
      </div>

      <Link className="text-button" href="/account">
        <Icon name="arrowLeft" size={18} /> Back to account
      </Link>
    </main>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="toggle-row">
      <span>
        <strong>{label}</strong>
      </span>
      <span>{value}</span>
    </div>
  );
}

function formatCost(estimatedCostUsd: number | null) {
  if (estimatedCostUsd === null) return "Unavailable";
  if (estimatedCostUsd < 0.01) return "<$0.01";
  return `$${estimatedCostUsd.toFixed(2)}`;
}

function formatDuration(averageDurationMs: number | null) {
  if (averageDurationMs === null) return "Unavailable";
  return `${(averageDurationMs / 1_000).toFixed(1)}s`;
}
