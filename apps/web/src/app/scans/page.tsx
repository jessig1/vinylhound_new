import Link from "next/link";

import { recentScans } from "../data";
import { Art, Icon } from "../ui";

export default function ScansPage() {
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
      <section className="scan-list scan-list--page">
        {recentScans.map((scan) => (
          <article className="scan-row" id={scan.id} key={scan.id}>
            <Art title={scan.title} tone={scan.tone} />
            <div className="scan-row__title">
              <h2>{scan.title}</h2>
              <p>
                {scan.artist} · {scan.year}
              </p>
            </div>
            <span
              className={`status status--${
                scan.status === "Matched" ? "success" : "review"
              }`}
            >
              {scan.status}
            </span>
            <time>{scan.time}</time>
          </article>
        ))}
      </section>
    </main>
  );
}
