import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

export const metadata = {
  title: "Mission planner | DJI route editor",
  description: "Draft and review DJI drone routes."
} satisfies Metadata;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
