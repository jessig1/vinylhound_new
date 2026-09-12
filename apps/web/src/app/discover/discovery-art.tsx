"use client";

import { useState } from "react";

import { toneFor } from "./discovery-client";

/**
 * Provider artwork over the existing tone placeholder.
 *
 * Unlike {@link CoverArt}, which resolves a signed URL for a scan image the
 * user owns, these URLs are public and already in hand, so there is no request
 * to defer — but the image can still 404 or be blocked, and the tone beneath
 * keeps the layout from shifting when it does.
 */
export function DiscoveryArt({
  url,
  title,
  id,
  shape = "square",
}: {
  url: string | null;
  title: string;
  id: string;
  shape?: "square" | "circle";
}) {
  const [failed, setFailed] = useState(false);
  const showImage = url !== null && !failed;

  return (
    <div
      className={`discovery-art discovery-art--${shape} album-art--${toneFor(id)}`}
      role="img"
      aria-label={`${title} artwork`}
    >
      {showImage ? (
        <img
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          src={url}
          // Provider artwork is decorative here: the adjacent text already
          // names the record, so the wrapper carries the accessible label and
          // the image itself stays out of the accessibility tree.
          aria-hidden="true"
        />
      ) : (
        <span className="discovery-art__fallback">{title.charAt(0)}</span>
      )}
    </div>
  );
}
