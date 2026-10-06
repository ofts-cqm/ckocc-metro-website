"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useMessages } from "./ui";

type WidgetApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: WidgetApi;
  }
}
let scriptPromise: Promise<void> | null = null;
function loadScript() {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error("challenge"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function Turnstile({
  onVerify,
  action = "request",
}: {
  onVerify: (token: string) => void;
  action?: "request" | "comment";
}) {
  const m = useMessages();
  const locale = useLocale();
  // Turnstile supports zh-tw for Traditional Chinese, not zh-hk:
  // https://developers.cloudflare.com/turnstile/reference/supported-languages/
  const widgetLanguage = locale === "zh-hk" ? "zh-tw" : locale;
  const node = useRef<HTMLDivElement>(null);
  const callback = useRef(onVerify);
  callback.current = onVerify;
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  useEffect(() => {
    if (!sitekey) return;
    let active = true;
    let widget: string | undefined;
    loadScript()
      .then(() => {
        if (!active || !node.current || !window.turnstile) return;
        widget = window.turnstile.render(node.current, {
          sitekey,
          action,
          theme: "light",
          language: widgetLanguage,
          "response-field": false,
          callback: (token: string) => callback.current(token),
          "expired-callback": () => callback.current(""),
          "error-callback": () => {
            callback.current("");
            setState("failed");
          },
        });
        setState("ready");
      })
      .catch(() => {
        if (active) setState("failed");
      });
    return () => {
      active = false;
      if (widget) window.turnstile?.remove(widget);
      callback.current("");
    };
  }, [sitekey, widgetLanguage, action]);
  return (
    <div className="challenge-area">
      <div ref={node} />
      {!sitekey ? (
        <p>{m.challengeMissing}</p>
      ) : state === "loading" ? (
        <p role="status">{m.challengeLoading}</p>
      ) : state === "failed" ? (
        <p role="alert">{m.challengeFailed}</p>
      ) : null}
    </div>
  );
}
