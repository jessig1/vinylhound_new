import Link from "next/link";

import { MAX_SCANS_PER_PAGE } from "@vinylhound/contracts";
import { listScansForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { Art, Icon } from "../ui";

export const dynamic = "force-dynamic";

export default async function ScansPage() {
  const context = getServerContext();
  const userId = await requireUserId(context);
  const { summaries } = await listScansForUser(context.database.db, {
    userId,
    limit: MAX_SCANS_PER_PAGE,
  });

  return (
    <main className="content-page library-page">
      <header className="page-heading page-heading--row">
        <div>
          <p className="section-kicker">Scan history</p>
          <h1>Recent scans</h1>
          <p>Review matched albums and anything that still needs your eye.</p>
        </div>
        <Link className="primary-button" href="/scan">
          <Icon name="camera" size={18} /> New scan
        </Link>
      </header>
      {summaries.length ? (
        <section className="scan-list scan-list--page">
          {summaries.map((scan) => {
            const title = scan.topCandidate?.title ?? "Untitled scan";
            const href = scan.batchId
              ? `/scans/batch/${scan.batchId}`
              : `/scans/${scan.scanId}`;
            return (
              <article className="scan-row" id={scan.scanId} key={scan.scanId}>
                <Art title={title} tone={toneFor(scan.scanId)} />
                <div className="scan-row__title">
                  <h2>{title}</h2>
                  <p>{scan.topCandidate?.artist ?? "No candidate yet"}</p>
                </div>
                <span className={`status ${statusTone(scan.status)}`}>
                  {statusLabel(scan.status)}
                </span>
                <time dateTime={scan.createdAt}>
                  {new Date(scan.createdAt).toLocaleDateString()}
                </time>
                <Link aria-label={`Open ${title}`} href={href}>
                  <Icon name="chevronRight" size={16} />
                </Link>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="library-empty">
          <span className="upload-card__icon">
            <Icon name="camera" size={27} />
          </span>
          <h2>No scans yet.</h2>
          <p>Scan a cover to see its match history here.</p>
          <Link className="primary-button" href="/scan">
            <Icon name="camera" size={18} /> Scan a record
          </Link>
        </section>
      )}
    </main>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "awaiting_upload":
      return "Waiting for upload";
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "identified":
      return "Matched";
    case "needs_review":
      return "Needs review";
    case "unresolved":
      return "No match";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

function statusTone(status: string) {
  if (status === "identified") return "status--success";
  if (status === "failed" || status === "canceled") return "status--error";
  return "status--review";
}

const tones = [
  "blue",
  "cream",
  "sun",
  "crosswalk",
  "classroom",
  "chrome",
  "ocean",
  "green",
  "snow",
  "red",
  "rainbow",
  "water",
] as const;

function toneFor(id: string) {
  let value = 0;
  for (const character of id) value = (value + character.charCodeAt(0)) % 997;
  return tones[value % tones.length]!;
}
