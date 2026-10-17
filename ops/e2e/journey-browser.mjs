import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const address = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return value; } };

/** One journey owns every context it opens. Closing them removes routes, storage, listeners and pages together. */
export function journeyBrowser(browser, { directory, capture = async () => {} } = {}) {
  const original = browser.newContext;
  const contexts = [], errors = [], events = [], files = [];
  const note = event => { events.push({ at: new Date().toISOString(), ...event }); if (events.length > 250) events.shift(); };
  mkdirSync(directory, { recursive: true });
  browser.newContext = async function(options) {
    const context = await original.call(browser, options);
    const index = contexts.length + 1;
    const entry = { context, index, traced: false, closed: false };
    contexts.push(entry);
    context.setDefaultTimeout(25000);
    await capture(context);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const stop = async () => {
      if (entry.traced) return;
      entry.traced = true;
      const path = join(directory, `context-${index}.zip`);
      try { await context.tracing.stop({ path }); files.push(path); }
      catch (error) { note({ type: "trace-error", message: error.message }); }
    };
    entry.stop = stop;
    const close = context.close.bind(context);
    context.close = async (...args) => { await stop(); entry.closed = true; return close(...args); };
    context.on("page", page => {
      page.on("pageerror", error => { errors.push(error.message); note({ type: "pageerror", message: error.message }); });
      page.on("requestfailed", request => note({ type: "requestfailed", method: request.method(), url: address(request.url()), error: request.failure()?.errorText }));
      page.on("response", response => { if (response.status() >= 400) note({ type: "http", status: response.status(), url: address(response.url()) }); });
    });
    return context;
  };
  return {
    errors,
    async finish({ failure = null, scenarios = [], cleanupErrors = [] } = {}) {
      try {
        if (failure) {
          for (const { context, index } of contexts) {
            for (const [pageIndex, page] of context.pages().entries()) {
              const prefix = join(directory, `context-${index}-page-${pageIndex + 1}`);
              try { await page.screenshot({ path: prefix + ".png", timeout: 3000 }); files.push(prefix + ".png"); } catch {}
              try { writeFileSync(prefix + ".txt", await page.locator("body").innerText({ timeout: 1000 })); files.push(prefix + ".txt"); } catch {}
              // The editors use shadow roots: body.innerText omits their controls and typed values.
              try { writeFileSync(prefix + ".aria.yml", await page.locator("body").ariaSnapshot({ timeout: 1000 })); files.push(prefix + ".aria.yml"); } catch {}
            }
          }
        }
        for (const entry of contexts) {
          await entry.stop();
          if (!entry.closed) await entry.context.close().catch(error => note({ type: "close-error", message: error.message }));
        }
        if (failure) {
          const path = join(directory, "failure.json");
          writeFileSync(path, JSON.stringify({ failure, scenarios, cleanupErrors, browserErrors: errors, events, files }, null, 2) + "\n");
          return { directory, files: [...files, path] };
        }
        rmSync(directory, { recursive: true, force: true });
        return null;
      } finally { browser.newContext = original; }
    },
  };
}
