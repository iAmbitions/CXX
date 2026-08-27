#!/usr/bin/env node
// Generate PWA/desktop icon assets from the canonical SVG logo in web/icons/.
// The SVG is kept as the source of truth; PNGs are rasterized for manifest,
// apple-touch-icon, README, and favicon usage.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "icons");
const SVG_NAME = "logo.svg";
const SVG_PATH = join(OUT, SVG_NAME);
const MENUBAR_SVG_NAME = "menubar.svg";
const MENUBAR_SVG_PATH = join(OUT, MENUBAR_SVG_NAME);
const ICNS_NAME = "AppIcon.icns";

const LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">口袋Agent logo</title>
  <desc id="desc">深色背景上的口袋Agent字母 P 与智能星芒标记。</desc>
  <defs>
    <linearGradient id="pocketGradient" x1="142" y1="116" x2="392" y2="400" gradientUnits="userSpaceOnUse">
      <stop stop-color="#B8FFD4"/>
      <stop offset="0.48" stop-color="#42E88B"/>
      <stop offset="1" stop-color="#08B965"/>
    </linearGradient>
    <filter id="glow" x="-35%" y="-35%" width="170%" height="170%">
      <feGaussianBlur stdDeviation="10" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" rx="112" fill="#101822"/>
  <circle cx="258" cy="258" r="176" fill="#1DE481" opacity="0.08"/>
  <path d="M168 390V122H272C344 122 390 167 390 233S344 344 272 344H168" fill="none" stroke="url(#pocketGradient)" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M364 93L375 125L407 136L375 147L364 179L353 147L321 136L353 125Z" fill="#FFFFFF" filter="url(#glow)"/>
</svg>
`;

const MENUBAR_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="108 78 320 336" role="img" aria-labelledby="title desc">
  <title id="title">口袋Agent menu bar logo</title>
  <desc id="desc">透明背景上的绿色 P 与智能星芒标记。</desc>
  <path d="M168 390V122H272C344 122 390 167 390 233S344 344 272 344H168" fill="none" stroke="#20D77A" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M364 93L375 125L407 136L375 147L364 179L353 147L321 136L353 125Z" fill="#20D77A"/>
</svg>
`;

const ICONS = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  { size: 180, name: "apple-touch-icon.png" },
];

const APP_ICONSET = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", ...opts });
}

function findChrome() {
  const env = process.env.CHROME_BIN;
  const candidates = [
    env,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function rasterizeWithSips(svgPath, width, height, outPath) {
  run("sips", ["-s", "format", "png", "-z", String(height), String(width), svgPath, "--out", outPath]);
}

function rasterizeWithChrome(svgPath, width, height, outPath) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("No rasterizer found. Install macOS sips or set CHROME_BIN to Chrome/Chromium.");
  }
  const dir = mkdtempSync(join(tmpdir(), "cxx-icon-render-"));
  const html = join(dir, "render.html");
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}img{display:block;width:${width}px;height:${height}px}</style><img src="${pathToFileURL(svgPath)}">`,
  );
  try {
    run(chrome, [
      "--headless=new",
      "--disable-gpu",
      `--screenshot=${outPath}`,
      `--window-size=${width},${height}`,
      pathToFileURL(html).href,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rasterize(svgPath, width, height, outPath) {
  if (process.platform === "darwin") {
    try {
      rasterizeWithSips(svgPath, width, height, outPath);
      return;
    } catch (error) {
      console.warn(`sips failed for ${width}x${height}, falling back to Chrome: ${error.message}`);
    }
  }
  rasterizeWithChrome(svgPath, width, height, outPath);
}

function generateIcns() {
  if (process.platform !== "darwin") {
    console.warn(`跳过 icons/${ICNS_NAME}: iconutil is macOS-only`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cxx-app-icon-"));
  const iconset = join(dir, "AppIcon.iconset");
  mkdirSync(iconset, { recursive: true });
  try {
    for (const icon of APP_ICONSET) {
      rasterize(SVG_PATH, icon.size, icon.size, join(iconset, icon.name));
    }
    run("iconutil", ["-c", "icns", iconset, "-o", join(OUT, ICNS_NAME)]);
    console.log(`生成 icons/${ICNS_NAME}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(SVG_PATH, LOGO_SVG);
console.log(`生成 icons/${SVG_NAME}`);
writeFileSync(MENUBAR_SVG_PATH, MENUBAR_SVG);
console.log(`生成 icons/${MENUBAR_SVG_NAME}`);

for (const icon of ICONS) {
  rasterize(SVG_PATH, icon.size, icon.size, join(OUT, icon.name));
  console.log(`生成 icons/${icon.name} (${icon.size}x${icon.size})`);
}

rasterize(MENUBAR_SVG_PATH, 96, 64, join(OUT, "menubar.png"));
console.log("生成 icons/menubar.png (96x64)");

generateIcns();
