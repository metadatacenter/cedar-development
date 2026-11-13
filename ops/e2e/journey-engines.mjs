import assert from "node:assert/strict";
import { journey } from "./journey-registry.mjs";

export const ENGINES = Object.freeze(["chromium", "firefox", "webkit"]);
// These exercise browser storage, authentication, tabs, focus and native keyboard behavior.
// Backend-only permutations remain in the full Chromium inventory.
export const CROSS_BROWSER_JOURNEYS = Object.freeze([
  "account-switch", "tab-isolation", "signin-permissions", "draft-recovery",
  "metadata-navigation", "designer-navigation", "keyboard-metadata",
  "keyboard-repeated-metadata", "designer-keyboard", "workspace-keyboard-folders",
  "workspace-keyboard-selection", "metadata-return-context",
]);

export function execution(name, defaultEngine = "chromium") {
  const [key, engine = defaultEngine, extra] = name.split("@");
  assert.ok(!extra && ENGINES.includes(engine), `Unknown browser in ${name}: ${engine}`);
  const entry = journey(key);
  assert.ok(entry, `Unknown journey: ${key}`);
  return { entry, engine, name: engine === "chromium" ? key : `${key}@${engine}` };
}

export function expandedJourneys(journeys) {
  return journeys.flatMap(entry => [
    { ...entry, name: entry.key, browser: "chromium" },
    ...(CROSS_BROWSER_JOURNEYS.includes(entry.key) ? ENGINES.slice(1).map(browser =>
      ({ ...entry, name: `${entry.key}@${browser}`, browser })) : []),
  ]);
}
