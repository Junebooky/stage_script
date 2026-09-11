import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cueflow — Realtime Script Following",
  description: "Prepared captions, precisely cued by live performance audio."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#03080b"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

