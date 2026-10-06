"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Expand,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import type { PublishedMap } from "@/lib/contracts";
import { ExternalAnchor, formatDate, useLocale, useMessages } from "./ui";

export function MapViewer({
  map,
  snapshot = false,
}: {
  map: PublishedMap;
  snapshot?: boolean;
}) {
  const m = useMessages();
  const locale = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 480 });
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; distance: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const fit = Math.min((size.w - 38) / map.width, (size.h - 42) / map.height);
  const width = map.width * fit;
  const height = map.height * fit;
  const reset = useCallback(() => setView({ x: 0, y: 0, zoom: 1 }), []);
  const zoom = useCallback(
    (factor: number, anchor = { x: 0, y: 0 }) =>
      setView((v) => {
        const next = Math.min(12, Math.max(0.6, v.zoom * factor));
        const ratio = next / v.zoom;
        return {
          zoom: next,
          x: anchor.x - (anchor.x - v.x) * ratio,
          y: anchor.y - (anchor.y - v.y) * ratio,
        };
      }),
    [],
  );
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ w: box.width, h: box.height });
    });
    observer.observe(element);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = element.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0014), {
        x: e.clientX - box.left - box.width / 2,
        y: e.clientY - box.top - box.height / 2,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
    };
  }, [zoom]);
  function gestureNow() {
    const points = [...pointers.current.values()];
    const first = points[0];
    if (!first) return null;
    const second = points[1];
    return second
      ? {
          x: (first.x + second.x) / 2,
          y: (first.y + second.y) / 2,
          distance: Math.hypot(first.x - second.x, first.y - second.y),
        }
      : { ...first, distance: 0 };
  }
  return (
    <section className="map-card" ref={host} aria-label={m.liveMap}>
      <div className="map-card-header">
        <div>
          <span className="live-dot" />
          <strong>{snapshot ? m.referenceMap : m.liveMap}</strong>
          <span className="map-header-separator">/</span>
          <span className="mono revision-label" title={map.revision}>
            {map.commitSha.slice(0, 7)}
          </span>
        </div>
        <a
          className="map-download"
          href={map.imageUrl}
          target="_blank"
          rel="noreferrer"
          download
        >
          <Download size={15} />
          <span>{m.downloadMap}</span>
        </a>
      </div>
      <div
        className="map-canvas"
        ref={surface}
        tabIndex={0}
        role="region"
        aria-label={m.mapRegion}
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onKeyDown={(e) => {
          const movements: Record<string, [number, number]> = {
            ArrowLeft: [45, 0],
            ArrowRight: [-45, 0],
            ArrowUp: [0, 45],
            ArrowDown: [0, -45],
          };
          if (movements[e.key]) {
            e.preventDefault();
            const [x, y] = movements[e.key];
            setView((v) => ({ ...v, x: v.x + x, y: v.y + y }));
          } else if (["+", "=", "-", "0"].includes(e.key)) {
            e.preventDefault();
            if (e.key === "0") reset();
            else zoom(e.key === "-" ? 0.8 : 1.25);
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          gesture.current = gestureNow();
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const next = gestureNow();
          const previous = gesture.current;
          if (next && previous) {
            setView((v) => ({
              ...v,
              x: v.x + next.x - previous.x,
              y: v.y + next.y - previous.y,
            }));
            if (next.distance && previous.distance) {
              const box = e.currentTarget.getBoundingClientRect();
              zoom(next.distance / previous.distance, {
                x: next.x - box.left - box.width / 2,
                y: next.y - box.top - box.height / 2,
              });
            }
          }
          gesture.current = next;
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          gesture.current = gestureNow();
          setDragging(pointers.current.size > 0);
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          gesture.current = gestureNow();
          setDragging(pointers.current.size > 0);
        }}
        onDoubleClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          zoom(1.6, {
            x: e.clientX - box.left - box.width / 2,
            y: e.clientY - box.top - box.height / 2,
          });
        }}
      >
        {map.overviewUrl ? (
          <div
            className="map-image-layer"
            style={{
              width,
              height,
              transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.zoom})`,
            }}
          >
            {/* This overview avoids decoding the 160-million-pixel original on phones. */}
            <img
              src={map.overviewUrl}
              alt={m.mapAlt}
              width={map.width}
              height={map.height}
              draggable={false}
            />
          </div>
        ) : (
          <div className="map-overview-unavailable">
            <p>{m.mapUnavailable}</p>
            <ExternalAnchor href={map.imageUrl}>{m.fullDetail}</ExternalAnchor>
          </div>
        )}
        <span className="map-corner-label" aria-hidden="true">
          CKOCC / NETWORK
        </span>
      </div>
      <div className="map-controls" aria-label={m.map}>
        <button
          className="icon-button"
          aria-label={m.zoomIn}
          title={m.zoomIn}
          onClick={() => zoom(1.25)}
        >
          <Plus size={19} />
        </button>
        <span className="zoom-number" aria-hidden="true">
          {Math.round(view.zoom * 100)}%
        </span>
        <button
          className="icon-button"
          aria-label={m.zoomOut}
          title={m.zoomOut}
          onClick={() => zoom(0.8)}
        >
          <Minus size={19} />
        </button>
        <span className="control-divider" />
        <button
          className="icon-button"
          aria-label={m.fit}
          title={m.fit}
          onClick={reset}
        >
          <Maximize2 size={17} />
        </button>
        <button
          className="icon-button"
          aria-label={m.resetView}
          title={m.resetView}
          onClick={reset}
        >
          <RotateCcw size={16} />
        </button>
        <button
          className="icon-button"
          aria-label={m.fullscreen}
          title={m.fullscreen}
          onClick={() => {
            if (document.fullscreenElement)
              void document.exitFullscreen().catch(() => {});
            else void host.current?.requestFullscreen?.().catch(() => {});
          }}
        >
          <Expand size={17} />
        </button>
      </div>
      <div className="map-card-footer">
        <span>{m.mapHelp}</span>
        <span>
          {m.published} {formatDate(map.publishedAt, locale)}
        </span>
      </div>
      {view.zoom > 3 && (
        <div className="map-detail-link">
          <ExternalAnchor href={map.imageUrl}>{m.fullDetail}</ExternalAnchor>
        </div>
      )}
    </section>
  );
}
