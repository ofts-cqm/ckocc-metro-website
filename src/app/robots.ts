import type { MetadataRoute } from "next";
/** Gives crawlers the current site-wide indexing rule.
 * Next.js invokes it when serving the generated robots.txt endpoint. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
