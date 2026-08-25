import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VinylHound",
    short_name: "VinylHound",
    description: "Identify and organize vinyl records from your phone.",
    start_url: "/",
    display: "standalone",
    background_color: "#11100f",
    theme_color: "#11100f",
  };
}
