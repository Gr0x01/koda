---
name: browser-verify
description: Confirm a web page or app actually WORKS by driving it in a real browser — clicking through it, not just looking at it. Use after building or changing web UI (a page, a form, a flow, a button), or to check a deployed/external URL, when you need to prove the behavior the user asked for happens — especially when they ask "does it work?". Requires the browser tools (mcp__playwright__*) to be available.
user-invocable: false
---

Rendering is not working. A page can look right and still do nothing — the button is dead, the form doesn't submit, the route 404s. When the user cares whether their web work *works*, drive it in a real browser and watch the actual behavior, then fix what you find.

This is the *interaction* check the Preview can't do: Preview shows you a still picture of a page, but it can't click a button, submit a form, or follow a multi-step flow. This skill does — on the project's own pages **or** a deployed/external URL.

This is the web case of the `verify` skill: the cheapest check that exercises a change to a page is to open it and use it.

How:
1. **Get a URL the browser can load.** For the project's own work, that's the Preview / dev-server URL (start or confirm the dev server first — a bare file path won't load a real app). For something already live, use its deployed URL directly.
2. **Navigate to the page** with `mcp__playwright__browser_navigate`.
3. **Do the thing the user asked for** — click the button, fill and submit the form, follow the flow — with the click/type/snapshot tools. Read the page back (the accessibility snapshot) to confirm the expected state actually appeared (the success message, the new row, the navigation).
4. **Check the console** for errors when something doesn't behave — a dead button is usually a thrown error, not a missing element.

Then:
- If it fails, read the error, fix the cause, and run the flow again — don't declare it done because the markup looks correct.
- When it passes, report what you clicked and what you saw happen, in one or two plain lines ("opened the page, clicked Sign in, the dashboard loaded").

The browser is headless and runs a fresh, isolated profile each session — there's no saved login or prior state, so set up whatever the flow needs as part of the check.
