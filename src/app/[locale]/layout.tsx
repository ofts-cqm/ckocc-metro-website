import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n";
import { SiteShell } from "@/components/ui";

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const savedTheme = (await cookies()).get("metro-theme")?.value;
  const theme =
    savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system";
  return (
    <SiteShell locale={locale} initialTheme={theme}>
      {children}
    </SiteShell>
  );
}
