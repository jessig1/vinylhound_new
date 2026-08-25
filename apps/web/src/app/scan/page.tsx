"use client";

import type { ChangeEvent } from "react";
import { useEffect, useState } from "react";

import { Icon } from "../ui";

export default function ScanPage() {
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    setFileName(file.name);
  }

  return (
    <main className="content-page scan-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">New scan</p>
          <h1>Let’s identify that record.</h1>
          <p>Start with a clear, straight-on photo of the front cover.</p>
        </div>
      </header>

      <section className="upload-card">
        {preview ? (
          <div className="upload-preview">
            <img alt={`Preview of ${fileName}`} src={preview} />
            <div>
              <span className="status status--success">
                <Icon name="check" size={14} /> Ready to scan
              </span>
              <h2>{fileName}</h2>
              <p>
                We’ll treat the match as a candidate for you to review before
                it’s added to a list.
              </p>
              <div className="button-row">
                <button className="primary-button" type="button">
                  <Icon name="sparkle" size={18} /> Identify album
                </button>
                <label className="secondary-button">
                  Choose another
                  <input accept="image/*" onChange={selectFile} type="file" />
                </label>
              </div>
            </div>
          </div>
        ) : (
          <>
            <span className="upload-card__icon">
              <Icon name="camera" size={28} />
            </span>
            <h2>Add a cover photo</h2>
            <p>Use your camera or select an image from this device.</p>
            <div className="button-row">
              <label className="primary-button">
                <Icon name="camera" size={18} /> Take a photo
                <input
                  accept="image/*"
                  capture="environment"
                  onChange={selectFile}
                  type="file"
                />
              </label>
              <label className="secondary-button">
                <Icon name="upload" size={18} /> Upload image
                <input accept="image/*" onChange={selectFile} type="file" />
              </label>
            </div>
            <small>JPEG, PNG, or WebP · Up to 10 MB</small>
          </>
        )}
      </section>

      <aside className="scan-tip">
        <Icon name="info" size={20} />
        <div>
          <strong>For the best match</strong>
          <p>
            Avoid glare, keep all four corners visible, and include the spine or
            label when the edition matters.
          </p>
        </div>
      </aside>
    </main>
  );
}
