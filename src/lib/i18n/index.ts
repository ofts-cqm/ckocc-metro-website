export * from "./catalogs";
import { catalogs, type Locale } from "./catalogs";
export const getDictionary = (locale: Locale) => catalogs[locale];
