---
name: shape-new-work
description: Shape a genuinely new app, product, or major feature before construction. Use when the user asks for a whole new thing, when the first useful version is not yet agreed, or when audience, device, ownership, or the core job would materially change what gets built. Do not use for a bounded addition or fix to an existing thing. Personal app requests route to create-mini-app instead.
user-invocable: false
---

# Shape New Work

Turn a broad new-build request into one explicit, useful first slice before writing code or scaffolding.

1. First decide whether this is genuinely new. A bounded feature or repair in an existing product proceeds normally. A personal app with its own screen or data belongs to `create-mini-app`; its shaping replaces this playbook.
2. Ask only the two or three questions whose answers change the result: usually the first job it must do, who will use it, and where they will use it. Do not ask the user to choose libraries or setup details.
3. Name one consequential hole they may not have seen, such as data that could be lost, a flow that dead-ends, or a service they would have to maintain. Explain it in terms of their experience, once.
4. Propose the smallest usable first slice in their terms. Trim the slice, not the larger ambition. Features are not "too big" because implementation is difficult; weigh only costs that reach the user, such as accounts, bills, maintenance, privacy, or fragility.
5. Get an explicit go on that slice before construction.

When the slice ships, state any deliberate gap plainly and offer the next useful slice. Do not let an omitted capability become a surprise later.
