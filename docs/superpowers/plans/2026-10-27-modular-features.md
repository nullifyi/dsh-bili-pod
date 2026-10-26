# Modular Features Implementation Plan

> **For agentic workers:** Execute inline using executing-plans, task by task. No subagents are required.

**Goal:** Add independently reloadable feature mods with self-declared settings and panels.
**Architecture:** Extend existing PodHost; static package manifests; shared declarative renderer; reuse current config and trusted routes.
**Tech Stack:** Node ESM, existing React ModuleLoader client, node:test.
**Spec:** docs/superpowers/specs/2026-10-27-modular-features-design.md

## Global Constraints
- Preserve current identity, session, diary, approval and sending policy.
- No new background processes; downloads and workspace on F:.
- Legacy .mjs/API v1 remains supported; new package API v2.
- Disable does not import package entry or remove saved settings.
- Real tests must not send messages or modify formal persona.

### Task 1: Typed mod contract and package lifecycle
- [x] Add tests in tests/modules.test.mjs for package discovery, disabled import, targeted reload, settings coercion, failure rollback.
- [x] Run tests red, implement lib/mod-schema.mjs and PodHost package support.
- [x] Interfaces: normalizeField(spec), fieldValue(field,value), host.panelsForClient(), host.reload(id).
- [x] Verify features.test and runtime-contract tests plus new tests.

### Task 2: Working feature packages
- [x] Add fixture-first tests in tests/module-features.test.mjs.
- [x] Add extensions/favorite-picker, watched-library and sharing-controls with manifest plus module entry.
- [x] Interfaces: pod.panel(spec); HTTP handler returns {options} or {items,total}; package fields bind existing config paths explicitly.
- [x] Test no sends, account-specific folder retrieval and actual-history filtering.

### Task 3: Settings integration
- [x] Save extension fields through fieldValue before writeConfig; do not accept undeclared paths.
- [x] Add per-id reload and expose panels through existing trusted API.
- [x] Extend generic controls for labelled select, multi-select, typed list/number and dynamic options; module settings override matching legacy controls while active.
- [x] Add Tab navigation, module cards and generic collection panels. Preserve parent form state and block lifecycle changes while unsaved.
- [x] Verify client render/interaction with real ModuleLoader fixture and actual DSH page.

### Task 4: Delivery
- [x] Run relevant tests then full package test script; inspect diff (311 passed).
- [x] Update version, README and extensions contract with a complete minimal mod package.
- [ ] Merge verified commit into clean installed checkout; reload only this plugin without restarting DSH.
- [ ] Verify actual module status and settings page; preserve config/persona SHA and session model/permissions.
