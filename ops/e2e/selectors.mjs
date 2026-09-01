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
// The dialog is sweetalert, which binds its handler as it animates in — see
// confirmDelete in login-smoke-test.mjs for why that matters.
export const DELETE_CONFIRM_NAME = 'Yes, delete it!';
// A generic modal, as a fallback for getByRole('dialog') where the markup predates
// ARIA roles.
export const MODAL = '.modal';

// ── OpenView (publish an artifact to the public OpenView site) ──────────────────
// Row ⋮ menu items, discriminated by their stable class — the same handler-name
// stability the ng-click selectors rely on. The visible labels come from i18n
// (makeopen = "Enable OpenView", makenotopen = "Disable OpenView", openopen =
// "Visit OpenView"); the class is the language-independent anchor. All three are
// gated by window.makeOpenEnabled, which the local build sets true. Enable is a
// plain success flash with no confirm dialog; a disabled item carries link-disabled.
export const MENU_ENABLE_OPENVIEW = 'a.makeopen';
export const MENU_DISABLE_OPENVIEW = 'a.makenotopen';
export const MENU_VISIT_OPENVIEW = 'a.openopen';

// ── Template designer ─────────────────────────────────────────────────────────
// The text-field palette entry is identified by its icon; the palette has no stable
// text label or test id.
export const PALETTE_TEXT_FIELD = 'a:has(i.fa-font)';
// Field editor tabs. Filtered to :visible by callers, because the designer keeps
// one instance of the tab strip per field in the DOM.
export const FIELD_VALUES_TAB = "[ng-click*=\"setTab('values')\"]";
export const ADD_VALUE_CONSTRAINT = "[ng-click*='addValueConstraint']";

// ── Controlled-term picker ────────────────────────────────────────────────────
// Advanced options, revealed by the gear icon.
export const PICKER_ADVANCED_GEAR = 'i.fa-cog';
// Runs the search inside the picker.
export const PICKER_SEARCH = 'i.fa-search';
// Search-scope radios. These are hidden/styled inputs whose AngularJS ng-change
// fires only on a real DOM click: check({force}) and coordinate clicks leave the
// picker in its previous mode. Dispatch a DOM click at the element instead.
//   scope 1 = search for a term, scope 2 = search for an ontology
// Only the ontology scope is used by the smoke today; the term scope is kept for
// the pair it documents, and is therefore unexercised — treat it as unverified
// until something here selects it.
export const SEARCH_SCOPE_TERMS = '#search-scope-1';
export const SEARCH_SCOPE_ONTOLOGIES = '#search-scope-2';
// A node in the class tree, once an ontology is selected.
export const CLASS_TREE_NODE = '[ng-click*="getClassDetailsCallback"]';
// Stages the selected tree node as a BRANCH constraint (as opposed to the whole
// ontology, or individual classes).
export const STAGE_BRANCH = '[ng-click*="stageBranchValueConstraint"]';

// ── Populate (filling an instance) ────────────────────────────────────────────
// A controlled-term field's input, and the suggestion list it opens. The list is
// Angular Material, hence mat-option, while the input is CEDAR's own markup.
export const CONTROLLED_TERM_INPUT = 'input[placeholder="Start typing to filter"]';
export const SUGGESTION_OPTION = 'mat-option';
