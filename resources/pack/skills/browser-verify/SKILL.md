---
name: browser-verify
description: Confirm a web page or app actually WORKS by driving it in a real browser, clicking through it instead of only looking at it. Use after building or changing web UI (a page, a form, a flow, a button), or to check a deployed/external URL, when you need to prove the behavior the user asked for happens, especially when they ask "does it work?". Requires the browser tools (mcp__playwright__*) to be available.
user-invocable: false
---

Rendering is not working. A page can look right and still do nothing: the button is dead, the form never submits, the route 404s. When the user cares whether their web work *works*, drive it in a real browser, watch what actually happens, and fix what you find.

This is the *interaction* check Preview cannot do. Preview shows a still picture of a page, so it cannot click a button, submit a form, or follow a multi-step flow. This skill can, on the project's own pages **or** a deployed/external URL. It is the web case of the `verify` skill: the cheapest check that exercises a change to a page is to open the page and use it.

## Drive the browser Koda gives you

The `mcp__playwright__*` tools are the browser for this check, from the first navigation through the last thing you confirm. They run a Koda-managed Chromium through the approval gate, on the same machine and the same URLs the user sees.

Several things within reach look like a browser and are something else. Do not switch to:

- `npx playwright`, `playwright test`, or a Node script that requires `playwright` or `puppeteer` from Bash
- a system Chrome, a downloaded Chromium, or a headless shell binary driven from Bash
- `curl`, `wget`, or a plain fetch of the URL, which shows that the server answered and shows nothing about the flow
- a screenshot from `view_preview` offered as the proof, which is the still picture this check exists to get past
- the source, the diff, or a passing unit test read as evidence that the click works

Hold that line through a bad start. A closed Preview, a dev server that is not listening yet, a page still compiling, one navigation timeout, an empty first snapshot, and a selector that misses are all ordinary opening conditions of a browser check. Start the dev server through the preview capability, wait, and call the tool again. A first failure means call the tool again.

## The only three ways out

Each exit is spoken out loud in the reply, and there are three.

1. **The browser tools are not attached.** Say browser testing is off, point at Settings → Toolkit → Browser testing, and offer the Preview screenshot as the weaker check the user can accept in the meantime.
2. **No URL can exist.** The project has no page and no dev server that will start, or an external URL is genuinely unreachable. Report what you tried and what failed, then stop.
3. **The flow needs something only the user holds**, such as real credentials, a paid account, a device, or a code sent to them. Drive everything up to that step, then name the exact step they finish by hand.

Anything else that goes wrong is a defect in the work or in your approach. Fix it and run the flow again.

## The check itself

1. **Get a URL the browser can load.** For the project's own work that is the Preview or dev-server URL, so start or confirm the dev server first; a bare file path will not load a real app. For something already live, use its deployed URL directly.
2. **Navigate to the page** with `mcp__playwright__browser_navigate`.
3. **Do the thing the user asked for.** Click the button, fill and submit the form, follow the flow, using the click, type, and snapshot tools. Read the page back with the accessibility snapshot and confirm the expected state actually appeared: the success message, the new row, the navigation.
4. **Check the console** when something misbehaves. A dead button usually traces back to a thrown error, so read the console before you go hunting for a missing element.
5. **Fix and rerun.** On a failure, read the error, fix the cause, and drive the same flow again. Markup that looks correct is not a pass.
6. **Report what happened** in one or two plain lines: what you clicked and what you saw ("opened the page, clicked Sign in, the dashboard loaded").

The browser is headless and starts a fresh, isolated profile every session, so there is no saved login and no prior state. Set up whatever the flow needs as part of the check.
