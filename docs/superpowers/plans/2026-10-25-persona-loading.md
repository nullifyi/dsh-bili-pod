# Persona Loading Implementation Plan

**Goal:** Load the complete persona, choose scene examples, and retain on-demand diary access without the former 3000-character truncation.

**Architecture:** A single local persona document is parsed into fixed instructions and example sections. Workspace mode maintains one managed block in the pod work directory's AGENTS.md, consumed by DSH's native agent-instructions projection. Inline mode supplies the same complete body for older hosts. Both modes reread the source for each delivery. Private persona data stays outside the repository.

**Tech Stack:** Existing Node ESM plugin, filesystem, DSH agent-instructions, existing settings API/UI and bundle format.

**Spec:** User-approved loading order in this conversation, 2026-10-25.

## Constraints

- Preserve the existing session and all 0.8.2 changes.
- Preserve original persona and existing AGENTS content; never truncate silently.
- Local data and backups belong on F:.
- Do not close the entire DSH application without first obtaining user approval after the implementation is ready.
- No automated tests were requested; use static parsing, source review and read-only deployment diagnostics.
- No real model messages, Bilibili messages or comments for deployment checks.

## Steps

- [x] Add lib/persona.mjs: personaPaths, ensurePersonaSource, readPersonaDocument, parsePersonaDocument, syncWorkspacePersona, buildPersonaContext. Enforce the existing 20000-character source limit explicitly. Preserve unmanaged AGENTS text. Select examples using the current trigger and incoming message.
- [x] Connect store.mjs, scheduler.js, defaults.mjs and the existing persona API/UI. Expose the active path/mode/version. Remove the fixed 'reply briefly' instruction and conflicting identity precedence. Keep diary retrieval on demand.
- [x] Keep archive export/import compatible with home/persona.md while using the current local source path. Update README, deployment documentation and changelog; bump to 0.8.3.
- [x] Save F-drive backups, install the approved v4 persona as local source and set selfClaim=我 plus workspace mode. Leave private text out of Git.
- [x] Check JavaScript syntax, whitespace and exact staged file scope. DSH component disable/enable hot reload applied the change; the main process was preserved. Runtime logs identify the new source version and workspace mode.

**Delivery:** Commit and synchronize the generic implementation to the existing GitHub project. Record the actual commit and deployment state in the local deployment report and final response.
