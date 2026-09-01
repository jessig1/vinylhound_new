import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="content-page library-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">VinylHound</p>
          <h1>Privacy notice</h1>
          <p>Last updated August 31, 2026.</p>
        </div>
      </header>
      <section className="privacy-notice">
        <h2>What we keep</h2>
        <p>
          We keep your account details, scans, image metadata, identification
          attempts, confirmations, collection, wishlist, and copy details so
          VinylHound can identify and organize your records. Original uploads
          may retain camera metadata; normalized analysis and thumbnail images
          strip EXIF metadata.
        </p>
        <h2>How we use and share it</h2>
        <p>
          A scan sends the image needed for identification to OpenAI through the
          server-side API. We use MusicBrainz only when you choose a catalog
          search; that search sends the artist and title you request, not your
          image. We do not sell collection or scan data.
        </p>
        <h2>Retention and your choices</h2>
        <p>
          Your data is retained while your account exists. From your account
          page, you can export your stored data or permanently delete your
          account. Deletion removes user-owned database records and attempts to
          remove associated image objects; shared catalog records remain because
          they may be used by other people.
        </p>
        <h2>Security</h2>
        <p>
          Uploads use short-lived signed URLs. Credentials and unrestricted
          storage access stay on trusted server and worker processes. We do not
          log raw image bytes, API keys, or complete signed URLs.
        </p>
        <p>
          <Link href="/account">Manage your data</Link>
        </p>
      </section>
    </main>
  );
}
