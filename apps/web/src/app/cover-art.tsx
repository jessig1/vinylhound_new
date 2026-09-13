"use client";

import { useEffect, useRef, useState } from "react";

import {
  parseResponse,
  SignedImageReadSchema,
  type LibraryCoverImage,
} from "@vinylhound/contracts";

/**
 * Renders the tone placeholder immediately and layers the real cover over it
 * once its signed URL resolves, so a slow or missing image never shifts layout.
 * Signed reads are requested only when the artwork nears the viewport: a full
 * library page can hold 100 covers, and each one costs its own request.
 */
export function CoverArt({
  image,
  title,
  tone,
}: {
  image: LibraryCoverImage | null;
  title: string;
  tone: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element || !image || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [image, visible]);

  useEffect(() => {
    if (!image || !visible) return;
    let cancelled = false;
    void fetch(
      `/api/v1/scans/${image.scanId}/images/${image.imageId}/thumbnail`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Cover unavailable");
        return parseResponse(SignedImageReadSchema, await response.json());
      })
      .then((read) => {
        if (!cancelled) setUrl(read.url);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [image, visible]);

  return (
    <div
      aria-label={`${title} cover artwork`}
      className={`album-art album-art--${tone}`}
      ref={container}
      role="img"
    >
      <span>{title}</span>
      {url ? (
        <img
          alt=""
          className="album-art__photo"
          onError={() => setUrl(null)}
          src={url}
        />
      ) : null}
    </div>
  );
}
