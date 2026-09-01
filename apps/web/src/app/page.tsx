import Link from "next/link";

import { BrandMark, Icon } from "./ui";

export default function LandingPage() {
  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="About VinylHound">
        <div className="auth-story__noise" aria-hidden="true" />
        <Link className="auth-brand" href="/" aria-label="VinylHound home">
          <BrandMark />
          <span>VinylHound</span>
        </Link>

        <div className="auth-story__copy">
          <span className="pill pill--light">For record people</span>
          <h1>Your collection has a story. Keep track of every chapter.</h1>
          <p>
            Scan a cover, identify the release, and keep your shelves and want
            list in one beautifully organized place.
          </p>
        </div>
        <Link className="text-button" href="/privacy">
          Privacy notice
        </Link>

        <div className="record-stack" aria-hidden="true">
          <div className="record-sleeve record-sleeve--back">
            <span>33⅓</span>
          </div>
          <div className="vinyl-disc">
            <div className="vinyl-disc__label">VH</div>
          </div>
          <div className="record-sleeve record-sleeve--front">
            <span className="record-sleeve__eyebrow">The late set</span>
            <strong>
              Blue
              <br />
              Hour
            </strong>
            <small>Sol Mercer Quartet</small>
          </div>
        </div>

        <p className="auth-story__quote">
          “The fastest way I’ve found to remember what I own—and what I’m still
          hunting for.”
        </p>
      </section>

      <section className="auth-panel">
        <div className="auth-panel__inner">
          <div className="auth-mobile-brand">
            <BrandMark />
            <span>VinylHound</span>
          </div>

          <div className="auth-heading">
            <p className="section-kicker">Get started</p>
            <h2>Pick up where you left off.</h2>
            <p>Sign in to see your recent scans and saved records.</p>
          </div>

          <div className="auth-landing-actions">
            <Link className="primary-button auth-submit" href="/sign-in">
              Sign in
              <Icon name="arrowRight" size={19} />
            </Link>
            <Link className="light-button auth-submit" href="/sign-up">
              Create an account
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
