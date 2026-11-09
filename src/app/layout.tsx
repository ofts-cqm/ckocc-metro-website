import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CKOCC Metro · 可可西里交通",
    template: "%s · CKOCC Metro",
  },
  description:
    "Explore the CKOCC Minecraft metro map, share requests, and help keep the network up to date.",
};
export const dynamic = "force-dynamic";
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requested = (await headers()).get("x-metro-locale");
  const locale =
    requested && ["en-US", "zh-CN", "zh-HK"].includes(requested)
      ? requested
      : "en-US";
  const savedTheme = (await cookies()).get("metro-theme")?.value;
  const theme =
    savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system";
  return (
    <html lang={locale} data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
