import type { ApprovalCancelled, ApprovalRequest, ApprovalResolved, KodaApi } from '@shared/ipc'

type ApprovalBridge = Pick<
  KodaApi,
  'onApprovalRequest' | 'onApprovalResolved' | 'onApprovalCancelled' | 'getPendingApprovals'
>

/** Subscribe to live approval changes, then recover prompts raised before this renderer existed. */
export function connectApprovals(
  bridge: ApprovalBridge,
  actions: {
    add: (req: ApprovalRequest) => void
    resolve: (e: ApprovalResolved) => void
    cancel: (e: ApprovalCancelled) => void
    failed: (err: unknown) => void
  },
): () => void {
  let active = true
  let catchingUp = true
  const resolvedDuringCatchup = new Set<string>()
  const cancelledDuringCatchup = new Set<string>()
  const offReq = bridge.onApprovalRequest((request) => actions.add(request))
  const offResolved = bridge.onApprovalResolved((event) => {
    if (catchingUp) resolvedDuringCatchup.add(event.requestId)
    actions.resolve(event)
  })
  const offCancel = bridge.onApprovalCancelled((event) => {
    if (catchingUp) cancelledDuringCatchup.add(event.sessionId)
    actions.cancel(event)
  })
  bridge
    .getPendingApprovals()
    .then((requests) => {
      if (!active) return
      requests
        .filter(
          (request) =>
            !resolvedDuringCatchup.has(request.requestId) && !cancelledDuringCatchup.has(request.sessionId),
        )
        .forEach((request) => actions.add(request))
    })
    .catch((err) => {
      if (active) actions.failed(err)
    })
    .finally(() => {
      catchingUp = false
    })
  return () => {
    active = false
    offReq()
    offResolved()
    offCancel()
  }
}
