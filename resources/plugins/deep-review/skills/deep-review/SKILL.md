---
name: deep-review
description: Investigate a bounded code change as an independent detective, trace its repository-wide blast radius, challenge candidate findings, score readiness from 1–5, and optionally repair and rescore in a bounded loop. Use when the user explicitly asks for a deep review, Greptile-style review, whole-PR review, cross-model review, an x/5 code rating, or a loop to 5/5.
---

# Deep Review

Review one bounded change more deeply than a normal diff pass. Follow evidence into unchanged code,
try to disprove every suspected issue, and make the score explainable.

## Contract

- Treat an invocation without repair language as **review-only**. Modify code only when the user
  explicitly asks to fix findings or loop toward 5/5.
- Review the requested diff, PR, commit range, or file set. Do not turn it into a repository-wide debt
  audit.
- A bare review is one scored pass. A request to fix findings permits one repair and one rescore. Run
  up to five scored passes only when the user explicitly asks to loop toward 5/5. A pass is one complete
  map, investigation, falsification, verification, and score—not one model message.
- Never push, merge, publish, force Git, or include unrelated changes unless the user separately
  authorizes that action. Follow the repository's own Git and verification instructions.
- A score is review confidence and readiness, not proof that the software is correct.

## 1. Freeze the boundary and disclose independence

Read the repository guidance before reviewing. Resolve the boundary in this order:

1. Use the PR, range, paths, or base the user supplied.
2. Otherwise, in Git, compare the current branch with its merge-base against the default branch and
   include tracked and untracked worktree changes.
3. If neither produces a concrete change, stop and ask for the review target.

Record the base, head, included worktree state, and changed paths. Keep that boundary fixed for the
pass so later searches do not silently broaden the review.

Record reviewer independence without guessing the author:

- **Cross-provider:** a fresh Claude review of Codex-authored work, or vice versa.
- **Different-model:** a fresh model different from the author, within one provider.
- **Same-model fresh:** the same model family in a fresh thread or child context.
- **Self-review:** the authoring context is also judging its own work.
- **Unknown:** authorship cannot be established from the request, conversation, or commit evidence.

Prefer a fresh Koda chat on the other provider. This plugin is available on both engines so the user
can build with one subscription and invoke Deep Review with the other. A fresh subagent is useful,
but never describe it as cross-model unless its actual model differs. Do not block a review when the
other provider is unavailable; continue and disclose the weaker independence. Self-review cannot earn
5/5, even if it finds nothing.

## 2. Build the responsibility map

Read the complete diff and changed files. List every responsibility the change introduces, removes,
or alters, including as applicable:

- user contract and stated intent;
- domain policy, validation, and error behavior;
- data shapes, serialization, migrations, and persistence;
- state ownership and transitions;
- lifecycle, retries, cancellation, concurrency, and cleanup;
- authorization, trust boundaries, secrets, and destructive operations;
- public interfaces, callers, configuration, and compatibility;
- tests and executable evidence.

For each responsibility, name its changed owner and the surrounding code that may depend on it. This
map is the investigation queue and the completion condition.

## 3. Investigate like a detective

Use fresh read-only reviewers when delegation is available. Give each reviewer the frozen boundary,
one or more responsibilities, relevant project rules, and the evidence expected. Do not leak expected
findings. Use only as many reviewers as there are independent lanes and available slots; three is
normally enough.

- On Claude, prefer the plugin's `deep-review:detective` specialist.
- On Codex, assign generic collaboration children the detective role and tell them not to delegate or
  modify the shared tree.
- If delegation is unavailable, run the same lanes sequentially and disclose that limitation.

Choose lanes from the actual change rather than mechanically running every category. Typical lanes are
correctness/data flow, lifecycle/concurrency, security/contracts, and architecture/history.

For every mapped responsibility, recursively trace as far as evidence leads:

1. changed definition and its assumptions;
2. direct and indirect callers and callees;
3. shared state, types, schemas, events, and configuration;
4. parallel implementations and established repository patterns;
5. tests, fixtures, and missing executable paths;
6. Git history or blame when current code does not settle intent.

Use repository search, language tooling, and read-only Git commands. Do not stop at the first related
file. Stop a trace when the contract is established, the impact is disproved, or the remaining question
requires product intent or external evidence.

Write each candidate finding as an evidence chain:

- claim and severity;
- changed location plus affected unchanged location when applicable;
- reachable trigger scenario;
- concrete user or system impact;
- supporting code, test, history, or contract evidence;
- the strongest attempted disproof;
- confidence from 0–100.

## 4. Falsify before reporting

Give candidate findings to a fresh reviewer that did not originate them. On Claude, prefer
`deep-review:finding-judge`; on Codex, use a fresh generic read-only child. Provide the frozen diff and
raw evidence, not the desired verdict.

The judge must try to reject each candidate by checking reachability, caller guarantees, type and
schema constraints, tests, documented intent, historical behavior, and whether the issue predates the
change. Keep a finding only when the evidence survives and confidence is at least 80.

Drop style preferences, linter findings, unrelated debt, hypothetical scale concerns, and issues with
no reachable failure. Classify surviving items as:

- valid and actionable;
- already fixed in the current boundary;
- informational;
- false positive;
- product or architecture decision;
- needs human or external evidence.

## 5. Verify and score

Run the narrowest relevant checks, then widen in proportion to the risk. Reading and static analysis
alone cannot prove runtime behavior. Never claim a check passed unless it ran successfully.

Assign one readiness score:

- **1/5 — Unsafe:** intent is not established, or a critical security, data-loss, or fundamental
  correctness failure remains.
- **2/5 — Major repair:** a high-impact supported bug remains, or a critical responsibility has no
  credible evidence.
- **3/5 — Material work:** one or more supported correctness issues remain, or risky responsibilities
  are only partly traced or verified.
- **4/5 — Nearly ready:** no blocker remains, but a bounded actionable issue, verification gap, or
  coverage gap remains.
- **5/5 — Ready by this review:** no supported findings remain, every mapped responsibility reached a
  conclusion, relevant checks are green, and at least one reviewer context was distinct from the
  builder.

A later pass may lower the score when new evidence warrants it. Never preserve a score for appearances.

## 6. Repair only when authorized

For review-only requests, report the score and stop. For an explicit fix request, make at most one
repair batch and one rescore. Continue beyond that only when the user explicitly requested a 5/5 loop:

1. Return product decisions and required human evidence to the user; do not code around them.
2. Batch valid in-scope fixes while preserving unrelated work.
3. Use the repository's code, Git, and verification procedures, but do not recursively invoke its
   ordinary review or finishing review step. The next scored pass is the review of these fixes.
4. Start the next pass with fresh reviewers against the complete current boundary, including fixes.
5. For an ordinary fix request, stop after that rescore. For an explicit 5/5 loop, stop at 5/5, after
   five scored passes, when a product decision or human proof is required, when no safe in-scope fix
   remains, or when the score fails to improve after a repair pass.

## Report

Lead with:

`Deep Review: X/5 — <ready | fixes needed | decision needed | evidence needed>`

Then report:

- **Independence:** author evidence, reviewer engine/model if known, independence class, and whether the
  review ran in a fresh context.
- **Boundary:** base/head or paths, worktree state included, and pass number.
- **Findings:** supported findings in impact order, each with locations, trigger, impact, evidence,
  attempted disproof, confidence, and smallest fix. Say `None` when clean.
- **Coverage:** every mapped responsibility and where its trace ended.
- **Checks:** exact commands or artifacts and results.
- **Loop:** fixes made this pass and why the workflow stopped or what blocks the next pass.

Keep the report concise enough to act on. Preserve the evidence needed to reproduce every finding.
