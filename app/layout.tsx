import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UW Monopoly · JEV Arena",
  description:
    "Four JEV strategies enter the same Waterloo-themed game state. One combined champion makes the call.",
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
