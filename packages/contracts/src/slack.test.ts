import { describe, expect, it } from 'vitest'
import { externalIntent, externalRequestSchema, externalThreadKey } from './external'
import { slackAppManifest, slackConfigureSchema } from './slack'

describe('external task vocabulary', () => {
  it('reserves exact controls while keeping ordinary task language intact', () => {
    expect(externalIntent(' STATUS ')).toEqual({ kind: 'status' })
    expect(externalIntent('stop')).toEqual({ kind: 'stop' })
    expect(externalIntent('answer use the existing branch')).toEqual({
      kind: 'answer',
      text: 'use the existing branch',
    })
    expect(externalIntent('in Ari: investigate\nthe sidebar')).toEqual({
      kind: 'prompt',
      projectName: 'Ari',
      text: 'investigate\nthe sidebar',
    })
    expect(externalIntent('status of the login tests needs fixing')).toEqual({
      kind: 'prompt',
      text: 'status of the login tests needs fixing',
    })
  })

  it('keeps workspace, connector, channel and root thread in conversation identity', () => {
    const source = {
      platform: 'slack' as const,
      connectorId: 'slack_one',
      requestId: 'event_one',
      workspaceId: 'T123',
      channelId: 'C123',
      threadId: '1.000001',
      senderId: 'U123',
    }
    expect(externalThreadKey(source)).not.toBe(
      externalThreadKey({ ...source, workspaceId: 'T456' }),
    )
    expect(externalThreadKey(source)).not.toBe(externalThreadKey({ ...source, channelId: 'C456' }))
    expect(externalThreadKey(source)).toBe(externalThreadKey({ ...source, requestId: 'event_two' }))
    expect(
      externalRequestSchema.safeParse({ source, text: ' ', permissionMode: 'full' }).success,
    ).toBe(false)
  })
})

describe('Slack setup contract', () => {
  const valid = {
    ownerUserId: 'UOWNER123',
    permissionMode: 'ask' as const,
    botToken: 'xoxb-test-token',
    appToken: 'xapp-test-token',
    routes: [{ channelId: 'CROOM123', projectId: 'project_one' }],
  }

  it('rejects global Aria grants, repeated channels and mismatched token kinds', () => {
    expect(slackConfigureSchema.safeParse(valid).success).toBe(true)
    expect(
      slackConfigureSchema.safeParse({
        ...valid,
        routes: [{ ...valid.routes[0], projectId: 'helm' }],
      }).success,
    ).toBe(false)
    expect(
      slackConfigureSchema.safeParse({ ...valid, routes: [...valid.routes, ...valid.routes] })
        .success,
    ).toBe(false)
    expect(slackConfigureSchema.safeParse({ ...valid, botToken: 'xapp-wrong-kind' }).success).toBe(
      false,
    )
    expect(slackConfigureSchema.safeParse({ ...valid, ownerUserId: '@Aria' }).success).toBe(false)
  })

  it('provides the minimal Socket Mode manifest directly to the settings page', () => {
    expect(slackAppManifest.settings.socket_mode_enabled).toBe(true)
    expect(slackAppManifest.settings.interactivity.is_enabled).toBe(true)
    expect(slackAppManifest.oauth_config.scopes.bot).toEqual(['app_mentions:read', 'chat:write'])
    expect(slackAppManifest.settings.event_subscriptions.bot_events).toEqual(['app_mention'])
  })
})
