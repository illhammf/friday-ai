# WhatsApp Puppeteer Duplicate Page Binding — Hotfix Investigation

## Root Cause Report (written before source changes)

### Finding

The root mechanism is confirmed in the installed dependency. Friday does not call `client.initialize()` twice through its normal application lifecycle. Instead, `whatsapp-web.js@1.34.7` can enter its private `Client.inject()` more than once on the same `Client`/Puppeteer `Page` as page/frame navigation events arrive.

The dependency's `Client.initialize()` first awaits `this.inject()`, then attaches a `framenavigated` handler. That handler invokes `this.inject()` for every frame navigation. It has no main-frame filter and no guard/serialization for overlapping calls. Each `inject()` calls `exposeFunctionIfAbsent()` for page bindings such as `onQRChangedEvent`.

The installed helper at `node_modules/whatsapp-web.js/src/util/Puppeteer.js` performs two separate operations:

1. `page.evaluate(() => !!window[name])`
2. If false, `page.exposeFunction(name, fn)`

The check and registration are not atomic. Two injection flows can both observe no window function before either registration has completed. Puppeteer `24.38.0` / `puppeteer-core@24.38.0` maintains page-local binding registration state and throws when `exposeFunction()` receives a name already registered on that same Page. This produces the reported `onQRChangedEvent ... already exists` error. It is a dependency race in `whatsapp-web.js` injection handling, not a Node 24 defect and not evidence of two Friday application instances.

### Relevant Friday call path

- `src/index.js` calls exported `startFriday()` once when run as the entry point.
- `src/friday-runtime.js` creates one module-level `application`; `startFriday()` calls `application.start()`.
- `src/application/application-lifecycle.js` memoizes `startPromise` while state is `starting`, and returns existing resources when state is `running`.
- Friday's `createClient()` creates one client per successful startup. `configureClient()` registers Friday's client listeners and queued message handler once, then `initializeClient()` calls that client's `initialize()` once.
- `whatsapp-web.js` installs one `framenavigated` listener in its `initialize()`, which can invoke `inject()` repeatedly and concurrently on its existing `pupPage`.

Therefore normal Friday startup concurrency and repeated calls are already guarded. Friday's event registration functions are called once per client initialization. The duplicate Puppeteer binding is inside the dependency's later page injection path.

### Same page, concurrency, navigation, and logout

The error is thrown by Puppeteer's Page-level binding registry, so the colliding registrations target the same Puppeteer Page instance. The dependency's unfiltered `framenavigated` callbacks provide a concrete same-page path to overlapping `inject()` calls. The reported `disconnected: LOGOUT` can be emitted by dependency logout/navigation handling; it does not establish that Friday initialized twice or that authentication data is corrupt.

The installed source proves the race window and call path, but no live instrumentation was run against the owner's browser. Thus the code-level cause is confirmed; the exact navigation/frame timing of this particular occurrence is inferred from the reported stack and installed implementation, not claimed as live-observed.

### Versions inspected

- `whatsapp-web.js`: `1.34.7`
- `puppeteer`: `24.38.0`
- `puppeteer-core`: `24.38.0`
- Runtime supplied for this investigation: Node `v24.22.1`

The dependency failure originates in `whatsapp-web.js`'s non-atomic exposed-function helper and unguarded reinjection lifecycle. Puppeteer correctly rejects a duplicate page binding; Friday's application lifecycle does not cause that duplicate call.

## Implemented Correction

The dependency correction is stored in `patches/whatsapp-web.js+1.34.7.patch` and applied through `patch-package` during `postinstall`; no installed file was edited by hand. `package.json` pins `whatsapp-web.js` to `1.34.7` so the patch cannot silently target an unreviewed release.

The patch makes the dependency's `framenavigated` handler ignore subframes and coalesce overlapping main-frame reinjections on the same client/page. In `exposeFunctionIfAbsent`, it catches only Puppeteer's exact duplicate-binding error and waits up to five seconds for the existing binding to become available in the document. Other errors are rethrown unchanged. This does not patch Puppeteer internals or create a second client.

Regression coverage exercises the actual installed, patched `Client` with a fake Puppeteer page/browser, verifies subframes are ignored, overlapping injection calls are coalesced, later navigation can reinject, and only one navigation listener is registered. Additional tests verify the precise duplicate error path and that unrelated failures remain failures. Lifecycle tests verify concurrent/repeated application startup creates/configures/initializes one client and adds its listeners once.

## Verification and Limits

- Node.js: `v24.22.1`; npm: `11.19.1`.
- `npm run check`: passed.
- `npm test`: 335 passed, 0 failed, 0 skipped, 0 cancelled. This includes four new test cases across the startup lifecycle and WhatsApp patch tests.
- `git diff --check`: passed.
- Patch application was verified with the package's `postinstall` script.
- No real WhatsApp account, browser session, QR code, authentication data, Gemini service, or production database was used. Thus the dependency race and corrective code path are confirmed by installed-source inspection and fake-page regression tests; recovery of the owner's live WhatsApp session is not verified. The exact frame timing behind the reported incident remains inferred, not live-observed.
- No source runtime flow, database schema, WhatsApp authentication data, or tool-execution boundary was changed. Production tool execution remains disabled. A development dependency (`patch-package`) and lockfile changes are required to make the version-pinned patch reproducible.

Changed files:

- `package.json`
- `package-lock.json`
- `test/application-lifecycle.test.js`
- `test/whatsapp-client-initialization.test.js`
- `patches/whatsapp-web.js+1.34.7.patch`
- `docs/architecture/WHATSAPP-PUPPETEER-DUPLICATE-BINDING-HOTFIX.md`

**Verdict:** the root mechanism is confirmed and the narrow dependency correction is verified in automated fake-browser tests. Live WhatsApp recovery remains unverified and must be confirmed by the owner during a supervised startup.
