import { GalleryPage } from "@/components/gallery";
import { getDictionary, isLocale } from "@/lib/i18n";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return {
    title: isLocale(locale) ? getDictionary(locale).galleryTitle : "Gallery",
  };
}

export default function Page() {
  return <GalleryPage />;
}
