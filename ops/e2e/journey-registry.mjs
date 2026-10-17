import { folderUiJourney } from "./folder-ui-journey.mjs";
import { designerAuthoringJourney, designerConflictJourney } from "./designer-authoring-journey.mjs";
import { reusableSourceFailureJourney } from "./reusable-source-failure-journey.mjs";
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

// JOURNEYS lists every self-contained journey under the key the runners know it by. Each journey
// makes its fixtures in a folder of its own under the folder it is given and reads nothing another
// journey made, so any set of them can run in any process. modern-workspace-smoke.mjs runs all of
// them in this order after its inline chain, and focused-journey-smoke.mjs runs the keys it is given.
//
// `signsInAsAnotherUser` is true when the journey's own file says that it signs the second test user
// in to a browser context of its own. The split tier runs every such journey in its identity lane,
// one after another, because sign-ins contend in Keycloak and in the graph writes each one triggers,
// and a logout ends the single sign-on session of its context.
//
// journey-registry.test.mjs fails when a journey file exports a journey that is neither listed here
// nor named in BOUND.
export const JOURNEYS = [
  { key: "folder-ui", run: folderUiJourney },
  { key: "designer-authoring", run: designerAuthoringJourney },
  { key: "reusable-source-failure", run: reusableSourceFailureJourney },
  { key: "designer-conflict", run: designerConflictJourney },
  { key: "template-sharing", run: templateSharingJourney, signsInAsAnotherUser: true },
  { key: "ownership-transfer", run: ownershipTransferJourney, signsInAsAnotherUser: true },
  { key: "cee-permissions", run: ceePermissionsJourney, signsInAsAnotherUser: true },
  { key: "access-recheck", run: accessRecheckJourney, signsInAsAnotherUser: true },
  { key: "initial-load", run: initialLoadJourney },
  { key: "validation-rejection", run: validationRejectionJourney },
  { key: "current-template-constraint", run: currentTemplateConstraintJourney },
  { key: "scalar-roundtrip", run: scalarRoundtripJourney },
  { key: "restored-validation", run: restoredValidationJourney },
  { key: "repeated-schema", run: repeatedSchemaJourney },
  { key: "configuration-draft", run: configurationDraftJourney },
  { key: "account-switch", run: accountSwitchJourney, signsInAsAnotherUser: true },
  { key: "combined-delete", run: combinedDeleteJourney },
  { key: "startup-recovery", run: startupRecoveryJourney },
  { key: "tab-isolation", run: tabIsolationJourney, signsInAsAnotherUser: true },
  { key: "opening-permissions", run: openingPermissionJourney, signsInAsAnotherUser: true },
  { key: "signin-permissions", run: signInPermissionJourney, signsInAsAnotherUser: true },
  { key: "numeric-constraint", run: numericConstraintJourney },
  { key: "mixed-move", run: mixedMoveJourney },
  { key: "draft-sharing-workspace", run: workspaceDraftSharingJourney, signsInAsAnotherUser: true },
  { key: "draft-sharing-designer", run: designerDraftSharingJourney, signsInAsAnotherUser: true },
  { key: "uncertain-create", run: uncertainCreateJourney },
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
  { key: "draft-recovery", run: draftRecoveryJourney },
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
  { key: "metadata-return-context", run: metadataReturnContextJourney },
  { key: "nested-metadata", run: nestedMetadataJourney },
  { key: "cloned-element", run: clonedElementJourney },
  { key: "bounded-repeated", run: boundedRepeatedJourney },
  { key: "duplicate-nested-labels", run: duplicateNestedLabelsJourney },
  { key: "clear-optional-metadata", run: clearOptionalMetadataJourney },
  { key: "attribute-editing", run: attributeEditingJourney },
].map(entry => Object.freeze({ signsInAsAnotherUser: false, ...entry }));

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
