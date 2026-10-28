export * from "./catalogs";
import { catalogs, type Locale } from "./catalogs";
/** Returns the page copy for a validated locale during rendering. */
export const getDictionary = (locale: Locale) => catalogs[locale];
