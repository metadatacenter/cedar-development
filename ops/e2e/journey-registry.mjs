import { folderUiJourney } from "./folder-ui-journey.mjs";
import { designerAuthoringJourney, designerConflictJourney } from "./designer-authoring-journey.mjs";
import { reusableSourceFailureJourney } from "./reusable-source-failure-journey.mjs";
import { pullVersionJourney, reusablePublicationJourney } from "./pull-version-journey.mjs";
import { sourceAccessJourney, sourceDeletionJourney, reusableChangedDraftJourney } from "./pull-version-gates-journey.mjs";
import { templateSharingJourney, ownershipTransferJourney } from "./template-sharing-journey.mjs";
import { ceePermissionsJourney } from "./cee-permissions-journey.mjs";
import { accessRecheckJourney } from "./access-recheck-journey.mjs";
import { initialLoadJourney } from "./initial-load-journey.mjs";
import { validationRejectionJourney } from "./validation-rejection-journey.mjs";
import { currentTemplateConstraintJourney } from "./current-template-constraint-journey.mjs";
import { scalarRoundtripJourney } from "./scalar-roundtrip-journey.mjs";
import { restoredValidationJourney } from "./restored-validation-journey.mjs";
import { repeatedSchemaJourney } from "./repeated-schema-journey.mjs";
import { configurationDraftJourney } from "./configuration-draft-journey.mjs";
import { accountSwitchJourney } from "./account-switch-journey.mjs";
import { combinedDeleteJourney } from "./combined-delete-journey.mjs";
import { startupRecoveryJourney, tabIsolationJourney } from "./recovery-boundary-journey.mjs";
import { openingPermissionJourney, signInPermissionJourney } from "./opening-permission-journey.mjs";
import { numericConstraintJourney } from "./numeric-constraint-journey.mjs";
import { partialMoveJourney, mixedMoveJourney } from "./partial-move-journey.mjs";
import { workspaceDraftSharingJourney, designerDraftSharingJourney } from "./draft-sharing-journey.mjs";
import { uncertainCreateJourney, uncertainWorkspaceCreateJourney, uncertainVersionJourney } from "./uncertain-create-journey.mjs";
import { partialVersionDefinitionJourney, partialVersionDraftJourney } from "./partial-version-journey.mjs";
import { olderArtifactJourney } from "./older-artifact-journey.mjs";
import { olderKeyRenameJourney } from "./older-key-rename-journey.mjs";
import { designerPendingSaveJourney } from "./designer-pending-save-journey.mjs";
import { saveStatusJourney, confirmedSaveRecoveryJourney } from "./save-status-journey.mjs";
import { recoveryElementEditsJourney } from "./recovery-element-edits-journey.mjs";
import { restoredControlShapesJourney, restoredNewerEditsJourney, unresolvedVersionJourney } from "./recovery-validation-journey.mjs";
import { draftRecoveryJourney, metadataReconciliationJourney } from "./draft-recovery-journey.mjs";
import { contentDeletionJourney } from "./content-deletion-journey.mjs";
import { incompleteMetadataJourney } from "./incomplete-metadata-journey.mjs";
import { uncertainMoveJourney } from "./uncertain-move-journey.mjs";
import { duplicationJourney } from "./duplication-journey.mjs";
import { copyOpenViewJourney } from "./copy-openview-journey.mjs";
import { templateEvolutionJourney } from "./template-evolution-journey.mjs";
import { publicationJourney } from "./publication-journey.mjs";
import { selectionDeleteJourney, partialSelectionDeleteJourney } from "./selection-delete-journey.mjs";
import { largeMetadataJourney, mixedMetadataJourney, keyboardMetadataJourney, keyboardRepeatedMetadataJourney,
  metadataNavigationJourney, metadataRecordSwitchJourney, designerReturnContextJourney, metadataReturnContextJourney } from "./ordinary-editing-journey.mjs";

import { nestedMetadataJourney, clonedElementJourney, boundedRepeatedJourney, duplicateNestedLabelsJourney,
  clearOptionalMetadataJourney, attributeEditingJourney } from "./structured-editing-journey.mjs";

import { designerOrderJourney, largeDesignerJourney, designerKeyboardJourney, designerDefaultJourney,
  nestedDesignerJourney, designerNavigationJourney } from "./designer-editing-journey.mjs";

import { workspaceKeyboardFoldersJourney, workspaceKeyboardSelectionJourney, workspaceTypeFilterJourney,
  workspaceListingPreferencesJourney, workspacePaginationJourney, workspaceSearchReturnJourney,
  workspaceRenamedBreadcrumbJourney } from "./workspace-navigation-journey.mjs";

// JOURNEYS lists every self-contained journey under the key the runners know it by. Each journey
// makes its fixtures in a folder of its own under the folder it is given and reads nothing another
// journey made, so any set of them can run in any process. modern-workspace-smoke.mjs runs all of
// them in this order after its inline chain, and focused-journey-smoke.mjs runs the keys it is given.
//
// `authentication` gives the reason a journey signs in, reauthenticates, or logs out. All such
// journeys belong in the identity lane, including same-user SSO redirects. Their short auth flows
// also share a machine-wide lock with worker setup and the core chain. The runners enforce this
// declaration when a journey invokes a browser authentication helper.
//
// `shares` names state a journey changes that is not its own: something kept per account rather than
// in the journey's folder, which every lane signs in as. No two journeys that share the same state run
// at once, because one putting it back as it found it undoes what the other is checking.
//
// journey-registry.test.mjs fails when a journey file exports a journey that is neither listed here
// nor named in BOUND.
/** The signed-in user's saved Workspace listing preferences, which `keepingListingPreferences` puts back. */
export const LISTING_PREFERENCES = "the signed-in user's saved Workspace listing preferences";

export const JOURNEYS = [
  { key: "folder-ui", run: folderUiJourney },
  { key: "designer-authoring", run: designerAuthoringJourney },
  { key: "reusable-source-failure", run: reusableSourceFailureJourney },
  { key: "pull-versions", run: pullVersionJourney },
  { key: "reusable-publication", run: reusablePublicationJourney },
  { key: "version-source-access", run: sourceAccessJourney },
  { key: "version-source-deletion", run: sourceDeletionJourney },
  { key: "reusable-changed-draft", run: reusableChangedDraftJourney },
  { key: "designer-conflict", run: designerConflictJourney },
  { key: "template-sharing", run: templateSharingJourney, authentication: "signs in as another user" },
  { key: "ownership-transfer", run: ownershipTransferJourney, authentication: "signs in as another user" },
  { key: "cee-permissions", run: ceePermissionsJourney, authentication: "signs in as another user" },
  { key: "access-recheck", run: accessRecheckJourney, authentication: "signs in as another user" },
  { key: "initial-load", run: initialLoadJourney },
  { key: "validation-rejection", run: validationRejectionJourney },
  { key: "current-template-constraint", run: currentTemplateConstraintJourney },
  { key: "scalar-roundtrip", run: scalarRoundtripJourney },
  { key: "restored-validation", run: restoredValidationJourney },
  { key: "repeated-schema", run: repeatedSchemaJourney },
  { key: "configuration-draft", run: configurationDraftJourney },
  { key: "account-switch", run: accountSwitchJourney, authentication: "logs out and switches accounts" },
  { key: "combined-delete", run: combinedDeleteJourney },
  { key: "startup-recovery", run: startupRecoveryJourney },
  { key: "tab-isolation", run: tabIsolationJourney, authentication: "signs in as another user" },
  { key: "opening-permissions", run: openingPermissionJourney, authentication: "signs in as another user" },
  { key: "signin-permissions", run: signInPermissionJourney, authentication: "signs in as another user" },
  { key: "numeric-constraint", run: numericConstraintJourney },
  { key: "mixed-move", run: mixedMoveJourney },
  { key: "draft-sharing-workspace", run: workspaceDraftSharingJourney, authentication: "signs in as another user" },
  { key: "draft-sharing-designer", run: designerDraftSharingJourney, authentication: "signs in as another user" },
  { key: "uncertain-create", run: uncertainCreateJourney, authentication: "reauthenticates the first user" },
  { key: "uncertain-workspace-create", run: uncertainWorkspaceCreateJourney },
  { key: "uncertain-version", run: uncertainVersionJourney },
  { key: "partial-version-definition", run: partialVersionDefinitionJourney },
  { key: "partial-version-draft", run: partialVersionDraftJourney },
  { key: "older-artifacts", run: olderArtifactJourney },
  { key: "older-key-rename", run: olderKeyRenameJourney },
  { key: "designer-pending-save", run: designerPendingSaveJourney },
  { key: "save-status", run: saveStatusJourney },
  { key: "confirmed-save-recovery", run: confirmedSaveRecoveryJourney },
  { key: "recovery-element-edits", run: recoveryElementEditsJourney },
  { key: "restored-control-shapes", run: restoredControlShapesJourney },
  { key: "restored-newer-edits", run: restoredNewerEditsJourney },
  { key: "unresolved-version", run: unresolvedVersionJourney },
  { key: "draft-recovery", run: draftRecoveryJourney, authentication: "reauthenticates the first user" },
  { key: "metadata-reconciliation", run: metadataReconciliationJourney },
  { key: "content-deletion", run: contentDeletionJourney },
  { key: "incomplete-metadata", run: incompleteMetadataJourney },
  { key: "uncertain-move", run: uncertainMoveJourney },
  { key: "partial-move", run: partialMoveJourney },
  { key: "duplication", run: duplicationJourney },
  { key: "copy-openview", run: copyOpenViewJourney },
  { key: "template-evolution", run: templateEvolutionJourney },
  { key: "publication", run: publicationJourney },
  { key: "selection-delete", run: selectionDeleteJourney },
  { key: "partial-selection-delete", run: partialSelectionDeleteJourney },
  { key: "large-metadata", run: largeMetadataJourney },
  { key: "mixed-metadata", run: mixedMetadataJourney },
  { key: "keyboard-metadata", run: keyboardMetadataJourney },
  { key: "keyboard-repeated-metadata", run: keyboardRepeatedMetadataJourney },
  { key: "metadata-navigation", run: metadataNavigationJourney },
  { key: "metadata-record-switch", run: metadataRecordSwitchJourney },
  { key: "designer-return-context", run: designerReturnContextJourney },
  { key: "metadata-return-context", run: metadataReturnContextJourney, shares: LISTING_PREFERENCES },
  { key: "nested-metadata", run: nestedMetadataJourney },
  { key: "cloned-element", run: clonedElementJourney },
  { key: "bounded-repeated", run: boundedRepeatedJourney },
  { key: "duplicate-nested-labels", run: duplicateNestedLabelsJourney },
  { key: "clear-optional-metadata", run: clearOptionalMetadataJourney },
  { key: "attribute-editing", run: attributeEditingJourney },
  { key: "designer-order", run: designerOrderJourney },
  { key: "large-designer", run: largeDesignerJourney },
  { key: "designer-keyboard", run: designerKeyboardJourney },
  { key: "designer-default", run: designerDefaultJourney },
  { key: "nested-designer", run: nestedDesignerJourney },
  { key: "designer-navigation", run: designerNavigationJourney },
  { key: "workspace-keyboard-folders", run: workspaceKeyboardFoldersJourney, shares: LISTING_PREFERENCES },
  { key: "workspace-keyboard-selection", run: workspaceKeyboardSelectionJourney },
  { key: "workspace-type-filter", run: workspaceTypeFilterJourney, shares: LISTING_PREFERENCES },
  { key: "workspace-listing-preferences", run: workspaceListingPreferencesJourney, shares: LISTING_PREFERENCES },
  { key: "workspace-pagination", run: workspacePaginationJourney },
  { key: "workspace-search-return", run: workspaceSearchReturnJourney },
  { key: "workspace-renamed-breadcrumb", run: workspaceRenamedBreadcrumbJourney },
].map(entry => Object.freeze({ authentication: null, ...entry }));

// BOUND names the journeys that have no key, because they work on fixtures another runner hands them.
// The inline chain of modern-workspace-smoke.mjs calls the first three on its own template and record,
// and access-recheck calls the group-access journey on the fixtures it provisions.
export const BOUND = Object.freeze([
  "sharedTemplateJourney",
  "designerTerminologyFailureJourney",
  "editorTerminologyFailureJourney",
  "groupAccessJourney",
]);

const byKey = new Map(JOURNEYS.map(entry => [entry.key, entry]));

/** The registry entry for a key, or undefined when no journey has that key. */
export const journey = key => byKey.get(key);
