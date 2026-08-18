---
name: verify
description: Prove a change actually works by running it, not just by reading it. Use after building or changing something runnable (a feature, a fix, a page, a script) and before telling the user it's done — especially when they ask "does it work?" or "is it ready?".
user-invocable: false
---

Don't claim something works because the code looks right. Run the narrowest check that proves the changed behavior. If it exposes a task-owned failure, fix the cause and rerun that check; a repair does not erase unrelated proof or justify restarting the whole verification matrix.

Pick the cheapest check that actually exercises the change:
- **Has tests?** Run the relevant ones (not the whole suite if a subset covers it). A test that doesn't touch your change proves nothing.
- **Builds / compiles / type-checks?** Run that — it catches a whole class of mistakes for free.
- **A page or UI?** Open it (or drive it) and confirm the actual behavior the user asked for happens.
- **A script / command / data job?** Run it on a real (or realistic) input and check the output is what was intended.

Then:
- If it fails, read the error, fix the cause (don't paper over the symptom), and run it again.
- If a failure is unrelated or plausibly flaky, retry it once. If it repeats, report it separately instead of expanding the task or rerunning broader suites until luck changes.
- If you genuinely cannot run it here, say so plainly and tell the user exactly what to click or run to confirm — don't silently call it done.
- When it passes, report what you ran and what it proved, in one or two plain lines.

For web work inside Koda, use the Preview capability to start and render the project's dev server; do not start a long-lived server in Bash and do not hand the user a raw localhost URL. Use `view_preview` for a fresh visual check and the `browser-verify` playbook when the proof requires clicking, typing, navigation, or another interaction. A self-contained static HTML artifact belongs in Koda's file preview.
