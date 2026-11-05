import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.CONCOURSE_DEMO_URL ?? "http://127.0.0.1:8082/concourse-campus-kit";
const outputRoot = resolve(root, "docs/screenshots");

const profiles = {
  desktop: { width: 1440, height: 960 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

const shots = [
  { name: "today", path: "/", wait: "text=Campus time" },
  { name: "events", path: "/events", wait: "text=Search events" },
  { name: "event-detail", path: "/events/welcome-concert", wait: "text=Welcome concert" },
  { name: "rooms", path: "/rooms", wait: "text=Search rooms" },
  { name: "room-detail", path: "/rooms/auditorium", wait: "text=Auditorium" },
  { name: "schedule", path: "/schedule/open-rehearsal", wait: "text=Open rehearsal" },
  { name: "settings", path: "/settings", wait: "text=Appearance" },
];

const requested = (process.env.CONCOURSE_SCREENSHOTS || "desktop,mobile").split(",").map((value) => value.trim()).filter(Boolean);

async function capture() {
  const browser = await chromium.launch();
  try {
    for (const profileName of requested) {
      const viewport = profiles[profileName];
      if (!viewport) throw new Error(`Unknown profile: ${profileName}`);
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-US", timezoneId: "Europe/Berlin" });
      const page = await context.newPage();
      const profileDir = join(outputRoot, profileName);
      await mkdir(profileDir, { recursive: true });
      for (const shot of shots) {
        await page.goto(`${baseUrl}${shot.path}`, { waitUntil: "networkidle" });
        await page.waitForSelector(shot.wait, { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(profileDir, `${shot.name}.png`), fullPage: false });
        process.stdout.write(`captured ${profileName}/${shot.name}.png\n`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

await capture();
