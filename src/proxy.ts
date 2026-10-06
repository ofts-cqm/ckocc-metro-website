import { NextRequest, NextResponse } from "next/server";

const languages = {
  "en-us": "en-US",
  "zh-cn": "zh-CN",
  "zh-hk": "zh-HK",
} as const;
type LanguagePath = keyof typeof languages;

function resolveLanguage(value: string): LanguagePath | null {
  const language = value.toLowerCase();
  if (language.startsWith("en")) return "en-us";
  if (/^zh(?:-(?:hant|hk|mo|tw))(?:-|$)/.test(language)) return "zh-hk";
  if (language === "zh" || /^zh(?:-(?:hans|cn|sg))(?:-|$)/.test(language))
    return "zh-cn";
  return null;
}
function preferredLanguage(request: NextRequest): LanguagePath {
  const saved = resolveLanguage(
    request.cookies.get("metro-locale")?.value ?? "",
  );
  if (saved) return saved;
  const offered = (request.headers.get("accept-language") ?? "")
    .split(",")
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters.find((p) => p.trim().startsWith("q="));
      const q = quality ? Number(quality.trim().slice(2)) : 1;
      return { tag, q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((item) => item.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const item of offered) {
    const found = resolveLanguage(item.tag);
    if (found) return found;
  }
  return "en-us";
}
export function proxy(request: NextRequest) {
  const segment = request.nextUrl.pathname.split("/")[1];
  const normalized = segment?.toLowerCase() as LanguagePath;
  if (!(normalized in languages)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${preferredLanguage(request)}${url.pathname === "/" ? "" : url.pathname}`;
    return NextResponse.redirect(url);
  }
  if (segment !== normalized) {
    const url = request.nextUrl.clone();
    url.pathname = request.nextUrl.pathname.replace(
      `/${segment}`,
      `/${normalized}`,
    );
    return NextResponse.redirect(url);
  }
  const headers = new Headers(request.headers);
  headers.set("x-metro-locale", languages[normalized]);
  return NextResponse.next({ request: { headers } });
}
export const config = { matcher: ["/((?!api|_next|\\.well-known|.*\\..*).*)"] };
