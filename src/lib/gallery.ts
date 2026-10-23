import type { Locale } from "./i18n";

// Display order and captions for the static collection in public/gallery.
export const galleryPhotos: { id: string; title: Record<Locale, string> }[] = [
  {
    id: "ministry-station-exterior",
    title: {
      "en-us": "Ministry of Railways station · exterior",
      "zh-cn": "铁道部站 · 外观",
      "zh-hk": "鐵道部站 · 外觀",
    },
  },
  {
    id: "ministry-station-platforms",
    title: {
      "en-us": "Ministry of Railways station · platforms",
      "zh-cn": "铁道部站 · 站台",
      "zh-hk": "鐵道部站 · 月台",
    },
  },
  {
    id: "spawn-point-station-1",
    title: {
      "en-us": "Spawn Point station · view 1",
      "zh-cn": "出生点站 · 视角一",
      "zh-hk": "出生點站 · 視角一",
    },
  },
  {
    id: "spawn-point-station-2",
    title: {
      "en-us": "Spawn Point station · view 2",
      "zh-cn": "出生点站 · 视角二",
      "zh-hk": "出生點站 · 視角二",
    },
  },
  {
    id: "space-station-1",
    title: {
      "en-us": "Space Station · view 1",
      "zh-cn": "空间站站 · 视角一",
      "zh-hk": "空間站站 · 視角一",
    },
  },
  {
    id: "space-station-2",
    title: {
      "en-us": "Space Station · view 2",
      "zh-cn": "空间站站 · 视角二",
      "zh-hk": "空間站站 · 視角二",
    },
  },
  {
    id: "tower-station",
    title: {
      "en-us": "Tower station",
      "zh-cn": "塔站",
      "zh-hk": "塔站",
    },
  },
  {
    id: "union-station",
    title: {
      "en-us": "Union station",
      "zh-cn": "联合站",
      "zh-hk": "聯合站",
    },
  },
  {
    id: "zhuxi-station-upper",
    title: {
      "en-us": "Zhuxi station · upper level",
      "zh-cn": "竹西站 · 上层",
      "zh-hk": "竹西站 · 上層",
    },
  },
  {
    id: "zhuxi-station-lower",
    title: {
      "en-us": "Zhuxi station · lower level",
      "zh-cn": "竹西站 · 下层",
      "zh-hk": "竹西站 · 下層",
    },
  },
  {
    id: "zhuxi-station-blue-ice",
    title: {
      "en-us": "Zhuxi station · blue ice level",
      "zh-cn": "竹西站 · 蓝冰层",
      "zh-hk": "竹西站 · 藍冰層",
    },
  },
  {
    id: "line-1",
    title: {
      "en-us": "Line 1",
      "zh-cn": "1 号线",
      "zh-hk": "1 號綫",
    },
  },
  {
    id: "line-2",
    title: {
      "en-us": "Line 2",
      "zh-cn": "2 号线",
      "zh-hk": "2 號綫",
    },
  },
  {
    id: "line-0f2",
    title: {
      "en-us": "Line 0F2",
      "zh-cn": "0F2 线",
      "zh-hk": "0F2 綫",
    },
  },
  {
    id: "lines-of1-of4",
    title: {
      "en-us": "Lines OF1 and OF4",
      "zh-cn": "OF1 及 OF4 线",
      "zh-hk": "OF1 及 OF4 綫",
    },
  },
  {
    id: "line-of7",
    title: {
      "en-us": "Line OF7",
      "zh-cn": "OF7 线",
      "zh-hk": "OF7 綫",
    },
  },
  {
    id: "lines-d8-dk",
    title: {
      "en-us": "Lines D8 and DK",
      "zh-cn": "D8 及 DK 线",
      "zh-hk": "D8 及 DK 綫",
    },
  },
];

export function galleryImage(id: string, width: 640 | 1600 = 1600) {
  return `/gallery/${id}-${width}.webp`;
}
