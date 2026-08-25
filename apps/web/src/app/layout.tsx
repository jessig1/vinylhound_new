import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "VinylHound",
    template: "%s · VinylHound",
  },
  description: "Identify, collect, and remember the records you want.",
};

export const viewport: Viewport = {
  themeColor: "#20221f",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
