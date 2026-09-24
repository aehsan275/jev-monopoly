import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UW Monopoly · Play the JEV Agents",
  description:
    "Play a rules-driven Waterloo-themed property trading game against the experimental JEV Champion and specialist agents.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
