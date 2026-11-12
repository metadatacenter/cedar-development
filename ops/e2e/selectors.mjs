// Selectors for the CEDAR AngularJS UI, kept in one place.
//
// These are the brittle part of any UI test here. The gestures around them are
// stable — open a menu, click a row, confirm a dialog — but the strings change
// whenever the template editor's markup moves, and a change that used to mean
// hunting through several files now means editing this one.
//
// Each entry says how it was established, because several are not obvious and were
// arrived at by inspecting the running app rather than by reading the templates.
// Where a selector looks over-specific, it usually is deliberately: CEDAR's markup
// repeats class names across panels, so anchoring on an `ng-click` handler name is
// often the only stable discriminator.
//
// The `ng-click` selectors match on handler name rather than on structure. That is
// on purpose: handler names survive re-styling and re-nesting, whereas class names
// and DOM position do not.

// ── Keycloak login form ────────────────────────────────────────────────────────
// Comma-separated alternatives because the realm's login theme has changed before;
// each list covers the themed and unthemed markup.
export const KC_USERNAME = '#username, input[name="username"]';
export const KC_PASSWORD = '#password, input[name="password"]';
export const KC_SUBMIT = '#kc-login, button[type="submit"], input[type="submit"]';

// ── Dashboard (folder and artifact listing) ────────────────────────────────────
// A row is a div.resource-instance; its visible title is the first line of its text.
export const ROW = 'div.resource-instance';
// The per-row overflow ("⋮") menu.
export const ROW_MENU_BUTTON = 'button.more-button';
// Row-menu move action and its destination picker. The picker lists folders as
// `.box-row` entries; callers select the exact named destination before confirming.
export const MENU_MOVE = 'a.move';
export const MOVE_MODAL = '#move-modal';
export const MOVE_DESTINATION_ROW = '#moveModalContent .box-row';
export const MOVE_CONFIRM = '#move-modal .modal-footer button.confirm';
// Accessible button name, not a CSS selector: used with getByRole('button', {name}).
// The dialog is SweetAlert, whose confirm button acts only once the dialog carries the
// class `visible`. confirmDelete in login-smoke-test.mjs explains why that matters.
export const DELETE_CONFIRM_NAME = 'Yes, delete it!';

// ── OpenView (publish an artifact to the public OpenView site) ──────────────────
// Row ⋮ menu items, discriminated by their stable class — the same handler-name
// stability the ng-click selectors rely on. The visible labels come from i18n
// (makeopen = "Enable OpenView", makenotopen = "Disable OpenView"); the class is the
// language-independent anchor. Both are gated by window.makeOpenEnabled, which the
// local build sets true. Enable is a plain success flash with no confirm dialog; a
// disabled item carries link-disabled.
export const MENU_ENABLE_OPENVIEW = 'a.makeopen';
export const MENU_DISABLE_OPENVIEW = 'a.makenotopen';

// ── Metadata editor ───────────────────────────────────────────────────────────
// The metadata's own name, on the host page above the embedded editor. Prefilled with the
// generated "<template name> metadata"; whatever it holds at save time is the stored name.
export const INSTANCE_NAME_INPUT = '#instance-name';

// ── Template designer ─────────────────────────────────────────────────────────
// The text-field palette entry is identified by its icon; the palette has no stable
// text label or test id.
export const PALETTE_TEXT_FIELD = 'a:has(i.fa-font)';
