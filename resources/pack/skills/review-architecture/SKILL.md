---
name: review-architecture
description: "Review a completed feature or multi-file refactor for architectural drift that a normal diff review misses: duplicated behavior or state, competing sources of truth, parallel old and new flows, boundary bypasses, shallow abstractions, and responsibilities in the wrong place. Use after verifying a feature-sized change, when a change adds a model, helper, storage path, lifecycle, or cross-layer flow, or when the user asks whether a completed change duplicated existing work, weakened maintainability, introduced poor architecture, or created sprawl. Skip one-line fixes and repository-wide architecture audits."
---

# Review Architecture

Audit the feature against the code around it, not only against its own diff. Find places where the
change created a second answer to a question the project should answer once. Keep the audit tied to
the finished feature; this is an integration check, not a hunt for every old problem in the repo.
Repository-wide architecture audits are outside this skill.

## Get a fresh view

For a feature-sized change, run the audit in a fresh read-only subagent when delegation is available.
Give it the feature's intent and a fixed diff, base commit, or exact file list. Tell it that it is the
delegated architecture reviewer, to use this skill, and not to delegate again. If the current task
already identifies you as that reviewer, inspect directly. For a small review or when delegation is
unavailable, inspect inline.

The reviewer reports findings only. The builder decides what to change, applies the fixes, and
re-verifies behavior.

## 1. Fix the review boundary

Read the feature brief or request, the completed diff, every changed file, and the project's relevant
architecture notes. Name the responsibilities the change introduced or moved:

- domain behavior or policy
- state and its owner
- data models, schemas, serialization, and write paths
- lifecycle, routing, transport, or cross-layer orchestration
- helpers, constants, configuration, events, and error classification
- public interfaces and the tests that exercise them

This inventory is the audit queue. Do not broaden it with unrelated debt found along the way.

## 2. Search for the other answer

For each changed responsibility, search the surrounding codebase for an existing owner or competing
implementation. Start with `rg` or the repository's equivalent and vary the evidence:

- domain nouns, synonyms, type names, function names, and imports
- event names, routes, config keys, database fields, serialized shapes, and string literals
- repeated conditionals, regular expressions, error mappings, state transitions, and call sequences
- callers, tests, and recent history that reveal which path is canonical

Look for **semantic duplication** first: two places encoding the same decision or invariant. Textual
clones are supporting evidence only. Two similar snippets that have different reasons to change are
not duplication; two differently written snippets that must change together are.

Use an existing clone, dependency, or cycle checker only when the project already has one. Do not add
a dependency for this review.

## 3. Test the shape

Judge only the architecture the feature introduced, extended, or made harder to change:

1. **One owner** — each fact, policy, state transition, and serialized shape has one authoritative
   home. Callers reuse it instead of recreating it.
2. **One live path** — a replacement removes or deliberately routes through the old flow. UI, API,
   background, retry, and migration paths do not implement the same lifecycle separately.
3. **Clean seam** — callers use the existing public interface rather than reaching into internals or
   duplicating orchestration on their side.
4. **Earned abstraction** — a new wrapper hides a real decision or cluster of complexity. Apply the
   deletion test: if removing it merely erases indirection without spreading complexity back across
   callers, it is shallow.
5. **Local change** — a future fix to this responsibility lands in one place. Tests assert behavior
   through the owner rather than copying production logic.
6. **Focused ownership** — the changed file or module still has one coherent job; the feature did not
   bolt an unrelated responsibility onto the nearest convenient file.

Prefer the smallest consolidation into an existing owner. Do not prescribe a framework, new layer,
or generic abstraction when moving or deleting a few lines resolves the split.

## 4. Demand proof

Keep a finding only when all of these are present:

- the changed side and the competing side, both with file and line references
- the shared responsibility or invariant they encode
- a concrete drift mode: a fix must be made twice, two paths can disagree, or a caller can bypass the
  owner
- the smallest credible correction and which place should own the behavior

Score confidence from 0 to 100 and drop findings below 80. Also drop style preferences, resemblance
without a shared reason to change, pre-existing debt the feature did not worsen, speculative scale
concerns, linter findings, and redesigns whose payoff cannot be stated concretely.

Stop when every item in the audit queue is accounted for as one of: reused an existing owner, created
a justified new owner, or produced a supported finding. That is the completion condition.

## Report

Lead with one verdict: **clean at the feature boundary** or **fix before calling it done**. Then list
findings in impact order. For each finding give:

- what is duplicated, split, or misplaced, in plain language
- both locations
- what will drift or become harder for the user
- the smallest fix and the correct owner

End with one short coverage line naming the changed responsibilities that were checked. If there are
no supported findings, say so plainly and stop; do not invent an improvement to justify the pass.
