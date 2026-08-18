/**
 * The waiting-device rows Settings will act on.
 *
 * The gate's list is not a list of questions: it carries decided requests too, and keeps them until
 * they expire. Rendering one is a dead end in both directions. A refused device reads as "wants to
 * join" with a live Allow, and the gate will not overturn a refusal, so the tap can only fail with a
 * sentence about a request the user thought they were still deciding. This is the rule that stops it,
 * and it is exported rather than inlined in the fetch handler so it can be checked here.
 */
import { describe, it, expect } from 'vitest'
import type { ConnectEnrollmentRequest, ConnectState } from '@shared/ipc'
import {
  actionableEnrollments,
  connectLifecycleChanged,
  pendingResetRecoveryVisible,
} from './RemoteSection'

const request = (over: Partial<ConnectEnrollmentRequest>): ConnectEnrollmentRequest => ({
  requestId: '11111111-2222-4333-8444-555555555555',
  deviceName: 'koda-iphone',
  platform: 'ios',
  requestedAt: Date.now(),
  expiresAt: Date.now() + 30 * 60_000,
  status: 'pending',
  ...over,
})

describe('the enrolment rows Settings offers a decision on', () => {
  it('keeps a request nobody has decided yet', () => {
    const pending = request({})
    expect(actionableEnrollments([pending])).toEqual([pending])
  })

  it('drops a refused request, which the gate would refuse to re-decide anyway', () => {
    const denied = request({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'denied' })
    expect(actionableEnrollments([denied]), 'a refused device was rendered as one still asking').toEqual([])
  })

  it('drops an approved request that has not been collected yet', () => {
    const approved = request({ requestId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', status: 'approved' })
    expect(actionableEnrollments([approved])).toEqual([])
  })

  it('shows only the undecided ones when the gate returns a mixture', () => {
    const pending = request({})
    const denied = request({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'denied' })
    const approved = request({ requestId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', status: 'approved' })

    expect(actionableEnrollments([denied, pending, approved])).toEqual([pending])
  })
})

describe('Connect activity refreshes', () => {
  const connected: ConnectState = {
    available: true,
    enabled: true,
    state: 'connected',
    nodeName: 'rbs-mac.koda.net',
    path: 'relayed',
  }

  it('ignores peer-path chatter and repeated snapshots', () => {
    expect(connectLifecycleChanged(connected, { ...connected })).toBe(false)
    expect(connectLifecycleChanged(connected, { ...connected, path: 'direct' })).toBe(false)
  })

  it('refreshes on the initial snapshot and real lifecycle changes', () => {
    expect(connectLifecycleChanged(null, connected)).toBe(true)
    expect(connectLifecycleChanged(connected, { ...connected, state: 'reconnecting' })).toBe(true)
    expect(connectLifecycleChanged(connected, { ...connected, reason: 'helper-failed' })).toBe(true)
    expect(connectLifecycleChanged(connected, { ...connected, enabled: false })).toBe(true)
    expect(connectLifecycleChanged(connected, { ...connected, available: false })).toBe(true)
  })
})

describe('unfinished remote resets', () => {
  const pending = { nodeId: 'n2', requestId: '3f6a9e2c-9d3b-4b8b-8a9a-6e6f2b6a9d10' }

  it('keeps a durable reset reachable, including while its retry is running', () => {
    expect(pendingResetRecoveryVisible(pending, '', false)).toBe(true)
    expect(pendingResetRecoveryVisible(pending, 'n2', false)).toBe(true)
  })

  it('hides only a fresh reset during its first in-flight attempt', () => {
    expect(pendingResetRecoveryVisible(pending, 'n2', true)).toBe(false)
    expect(pendingResetRecoveryVisible(null, '', false)).toBe(false)
  })
})
