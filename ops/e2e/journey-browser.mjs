import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const address = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return value; } };

/** One journey owns every context it opens. Closing them removes routes, storage, listeners and pages together. */
export function journeyBrowser(browser, { directory, capture = async () => {} } = {}) {
  const original = browser.newContext;
  const contexts = [], errors = [], teardownErrors = [], events = [], files = [];
  const captured = new Set();
  const note = event => { events.push({ at: new Date().toISOString(), ...event }); if (events.length > 250) events.shift(); };
  const teardownFailure = (entry, type, error) => {
    const message = `context-${entry.index} ${type}: ${error.message ?? error}`;
    teardownErrors.push(message);
    note({ type, context: entry.index, message });
  };
  const snapshot = async ({ context, index }) => {
    for (const [pageIndex, page] of context.pages().entries()) {
      if (captured.has(page)) continue;
      captured.add(page);
      const prefix = join(directory, `context-${index}-page-${pageIndex + 1}`);
      try { await page.screenshot({ path: prefix + ".png", timeout: 3000 }); files.push(prefix + ".png"); } catch {}
      try { writeFileSync(prefix + ".txt", await page.locator("body").innerText({ timeout: 1000 })); files.push(prefix + ".txt"); } catch {}
      // The editors use shadow roots: body.innerText omits their controls and typed values.
      try { writeFileSync(prefix + ".aria.yml", await page.locator("body").ariaSnapshot({ timeout: 1000 })); files.push(prefix + ".aria.yml"); } catch {}
    }
  };
  mkdirSync(directory, { recursive: true });
  browser.newContext = async function(options) {
    const context = await original.call(browser, options);
    const index = contexts.length + 1;
    const entry = { context, index, traceStarted: false, traced: false, closed: false };
    contexts.push(entry);
    context.setDefaultTimeout(25000);
    const stop = async () => {
      if (!entry.traceStarted || entry.traced) return;
      entry.traced = true;
      const path = join(directory, `context-${index}.zip`);
      try { await context.tracing.stop({ path }); files.push(path); }
      catch (error) { teardownFailure(entry, "trace-error", error); await snapshot(entry); }
    };
    entry.stop = stop;
    const close = context.close.bind(context);
    context.close = async (...args) => {
      await stop();
      try { await close(...args); entry.closed = true; }
      catch (error) {
        teardownFailure(entry, "close-error", error);
        await snapshot(entry);
        throw error;
      }
    };
    context.on("close", () => { entry.closed = true; });
    context.on("page", page => {
      page.on("pageerror", error => { errors.push(error.message); note({ type: "pageerror", message: error.message }); });
      page.on("requestfailed", request => note({ type: "requestfailed", method: request.method(), url: address(request.url()), error: request.failure()?.errorText }));
      page.on("response", response => { if (response.status() >= 400) note({ type: "http", status: response.status(), url: address(response.url()) }); });
    });
    // Install cleanup before initialization: capture/tracing can fail after the context exists.
    await capture(context);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    entry.traceStarted = true;
    return context;
  };
  return {
    errors,
    async finish({ failure = null, scenarios = [], cleanupErrors = [] } = {}) {
      const initialFailure = failure;
      try {
        if (failure || errors.length || teardownErrors.length)
          for (const entry of contexts) await snapshot(entry);
        for (const entry of contexts) {
          await entry.stop();
          // close() records its failure and captures the still-open page. Continue with other contexts.
          if (!entry.closed) await entry.context.close().catch(() => {});
        }
        const browserFailure = teardownErrors.length ? "Browser teardown failed: " + teardownErrors.join("; ") :
          errors.length ? "Uncaught browser errors: " + errors.join("; ") : null;
        failure ??= browserFailure;
        if (failure) {
          const path = join(directory, "failure.json");
          writeFileSync(path, JSON.stringify({ failure, scenarios, cleanupErrors, teardownErrors, browserErrors: errors, events, files }, null, 2) + "\n");
          const evidence = { directory, files: [...files, path] };
          // Throw so an otherwise-passing caller cannot silently ignore failed cleanup. Keep the
          // original assertion in failure.json, even if a journey caught an earlier close rejection.
          if (teardownErrors.length || (!initialFailure && browserFailure))
            throw Object.assign(new Error(browserFailure), { evidence, teardownErrors: [...teardownErrors] });
          return evidence;
        }
        rmSync(directory, { recursive: true, force: true });
        return null;
      } finally { browser.newContext = original; }
    },
  };
}
