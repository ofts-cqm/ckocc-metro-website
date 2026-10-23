"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
} from "lucide-react";
import { galleryImage, galleryPhotos } from "@/lib/gallery";
import { localeHref, useLocale, useMessages } from "./ui";

function GalleryImage({
  id,
  title,
  sizes,
}: {
  id: string;
  title: string;
  sizes: string;
}) {
  return (
    <img
      src={galleryImage(id)}
      srcSet={`${galleryImage(id, 640)} 640w, ${galleryImage(id)} 1600w`}
      sizes={sizes}
      width={1600}
      height={865}
      alt={title}
      loading="lazy"
      decoding="async"
    />
  );
}

export function HomeGallery() {
  const m = useMessages();
  const locale = useLocale();
  const [photos, setPhotos] = useState(galleryPhotos);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Shuffle a copy after hydration, keeping the full gallery's order intact.
    const shuffled = [...galleryPhotos];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setPhotos(shuffled);

    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(preference.matches);
    const updateVisibility = () => setHidden(document.hidden);
    updateMotion();
    updateVisibility();
    preference.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      preference.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  const rotating = !paused && !hovered && !focused && !reducedMotion && !hidden;
  useEffect(() => {
    if (!rotating) return;
    const timer = window.setTimeout(() => {
      setIndex((current) => (current + 1) % photos.length);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [rotating, index, photos.length]);

  const photo = photos[index];
  const title = photo.title[locale];
  return (
    <section
      id="gallery"
      className="home-gallery"
      aria-labelledby="gallery-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            <span />
            {m.galleryEyebrow}
          </span>
          <h2 id="gallery-title">{m.galleryTitle}</h2>
          <p>{m.galleryIntro}</p>
        </div>
        <Link className="text-link" href={localeHref(locale, "/gallery")}>
          {m.galleryViewAll}
          <ArrowRight size={16} />
        </Link>
      </div>
      <div
        className="gallery-carousel"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setFocused(false);
        }}
      >
        <Link
          className="gallery-photo-link"
          href={localeHref(locale, "/gallery")}
          aria-label={`${m.galleryViewAll}: ${title}`}
        >
          <GalleryImage
            id={photo.id}
            title={title}
            sizes="(max-width: 700px) 100vw, 1100px"
          />
        </Link>
        <div className="gallery-toolbar">
          <div
            className="gallery-caption"
            aria-live={rotating ? "off" : "polite"}
            aria-atomic="true"
          >
            <span className="gallery-counter">
              {index + 1} / {photos.length}
            </span>
            <span>{title}</span>
          </div>
          <div className="gallery-controls">
            <button
              type="button"
              className="icon-button"
              aria-label={m.galleryPrevious}
              onClick={() =>
                setIndex(
                  (current) => (current - 1 + photos.length) % photos.length,
                )
              }
            >
              <ChevronLeft size={20} />
            </button>
            {!reducedMotion && (
              <button
                type="button"
                className="icon-button"
                aria-label={paused ? m.galleryPlay : m.galleryPause}
                onClick={() => setPaused((value) => !value)}
              >
                {paused ? <Play size={17} /> : <Pause size={17} />}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={m.galleryNext}
              onClick={() =>
                setIndex((current) => (current + 1) % photos.length)
              }
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function GalleryPage() {
  const m = useMessages();
  const locale = useLocale();
  return (
    <div className="container gallery-page">
      <Link className="back-link" href={localeHref(locale, "#gallery")}>
        <ArrowLeft size={14} />
        {m.home}
      </Link>
      <div className="page-intro">
        <span className="eyebrow">
          <span />
          {m.galleryEyebrow}
        </span>
        <h1>{m.galleryTitle}</h1>
        <p>{m.galleryIntro}</p>
      </div>
      <div className="gallery-grid">
        {galleryPhotos.map((photo) => (
          <figure className="gallery-item" key={photo.id}>
            <GalleryImage
              id={photo.id}
              title={photo.title[locale]}
              sizes="(max-width: 700px) 100vw, 550px"
            />
            <figcaption>{photo.title[locale]}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
