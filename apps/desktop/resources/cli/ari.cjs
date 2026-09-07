#!/usr/bin/env node
'use strict'
/* global Buffer, process, setTimeout, clearTimeout, require, module, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const net = require('node:net')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')

const skillPath = path.join(__dirname, 'ari', 'SKILL.md')
const failure = (code, message) => ({ ok: false, error: { code, message } })

function parse(argv) {
  const positional = []
  const flags = {}
  const boolean = new Set(['json', 'wait', 'patch', 'stat', 'recursive', 'allow-stale'])
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) {
      positional.push(item)
      continue
    }
    const name = item.slice(2)
    if (Object.hasOwn(flags, name)) throw new Error(`Repeated option --${name}`)
    if (boolean.has(name)) flags[name] = true
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--'))
        throw new Error(`Missing value for --${name}`)
      flags[name] = argv[++i]
    }
  }
  const allowed = new Set([
    ...boolean,
    'title',
    'agent',
    'model',
    'effort',
    'permission',
    'workspace',
    'prompt',
    'key',
    'tail',
    'turns',
    'max-chars',
    'timeout',
    'children',
    'snapshot',
  ])
  for (const name of Object.keys(flags))
    if (!allowed.has(name)) throw new Error(`Unknown option --${name}`)
  const key = flags.key || randomUUID()
  const timeoutMs = flags.timeout === undefined ? 60_000 : Number(flags.timeout) * 1000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
    throw new Error('Timeout must be between 0.001 and 3600 seconds')
  const [group, verb, target, ...rest] = positional
  let method
  let params
  if (group === 'env') {
    method = 'runtime.info'
    params = {}
  } else if (group === 'agents' || group === 'providers') {
    method = 'providers.list'
    params = {}
  } else if (group === 'parent' && verb === 'message') {
    method = 'session.message'
    params = {
      targetSessionId: 'parent',
      text: [target, ...rest].filter(Boolean).join(' '),
      idempotencyKey: key,
    }
  } else if (group === 'session') {
    method = `session.${verb}`
    switch (verb) {
      case 'get':
        params = { targetSessionId: target || 'self' }
        break
      case 'children':
        params = { targetSessionId: target || 'self', recursive: Boolean(flags.recursive) }
        break
      case 'spawn':
        params = {
          title: flags.title,
          driverKind: flags.agent,
          idempotencyKey: key,
          ...(flags.model ? { modelId: flags.model } : {}),
          ...(flags.effort ? { effort: flags.effort } : {}),
          ...(flags.permission ? { permissionMode: flags.permission } : {}),
          ...(flags.workspace ? { workspaceMode: flags.workspace } : {}),
          ...(flags.prompt ? { prompt: flags.prompt } : {}),
        }
        break
      case 'prompt':
      case 'message':
        params = { targetSessionId: target, text: rest.join(' '), idempotencyKey: key }
        break
      case 'read':
        params = {
          targetSessionId: target,
          ...(flags.tail ? { tailMessages: Number(flags.tail) } : {}),
          ...(flags.turns ? { tailTurns: Number(flags.turns) } : {}),
          ...(flags['max-chars'] ? { maxChars: Number(flags['max-chars']) } : {}),
        }
        break
      case 'wait':
        params = {
          targetSessionIds: flags.children ? flags.children.split(',') : [target],
          timeoutMs,
        }
        break
      case 'stop':
        params = { targetSessionId: target, idempotencyKey: key }
        break
      case 'destroy':
      case 'delete':
        method = 'session.destroy'
        params = { targetSessionId: target, idempotencyKey: key }
        break
      case 'diff':
        params = { targetSessionId: target, patch: Boolean(flags.patch) }
        break
      case 'integrate':
        params = {
          targetSessionId: target,
          snapshotCommit: flags.snapshot,
          idempotencyKey: key,
          ...(flags['allow-stale'] ? { allowStale: true } : {}),
        }
        break
      default:
        throw new Error('Unknown session command')
    }
  } else throw new Error('Use ari env, ari agents, ari session <command>, or ari --skill')
  return { method, params, flags, timeoutMs }
}

function request(method, params, timeoutMs, env = process.env) {
  if (!env.ARI_CONTROL_ENDPOINT || !env.ARI_CONTROL_TOKEN)
    return Promise.resolve(failure('ari_not_running', 'Run this command inside an Ari session.'))
  return new Promise((resolve) => {
    const socket = net.connect(env.ARI_CONTROL_ENDPOINT)
    socket.setEncoding('utf8')
    let buffer = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(
      () => finish(failure('control_timeout', 'Control request timed out.')),
      timeoutMs + 5000,
    )
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({ type: 'hello', version: 1, token: env.ARI_CONTROL_TOKEN }) + '\n',
      ),
    )
    socket.on('error', () => finish(failure('ari_not_running', 'Cannot connect to Ari.')))
    socket.on('close', () => finish(failure('ari_not_running', 'Ari closed the connection.')))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        finish(failure('output_too_large', 'Response exceeds size limit.'))
        return
      }
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n')
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          finish(failure('invalid_request', 'Malformed Ari response.'))
          return
        }
        if (frame.type === 'ready') {
          if (frame.version !== 1) {
            finish(failure('protocol_version_mismatch', 'Ari CLI and runtime versions differ.'))
            return
          }
          socket.write(JSON.stringify({ type: 'request', id: 'cli', method, params }) + '\n')
        } else if (frame.type === 'response' || frame.type === 'error') {
          finish(frame.ok ? { ok: true, result: frame.result } : { ok: false, error: frame.error })
        }
      }
    })
  })
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--skill') {
    process.stdout.write(await fs.readFile(skillPath, 'utf8'))
    return
  }
  if (argv[0] === 'skill' && argv[1] === 'install') {
    const kind = argv[2]
    if (!['claude', 'codex'].includes(kind) || argv.length !== 3)
      throw new Error('Use ari skill install claude|codex')
    const base =
      kind === 'codex'
        ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
        : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const target = path.join(base, 'skills', 'ari', 'SKILL.md')
    const content = await fs.readFile(skillPath, 'utf8')
    await fs.mkdir(path.dirname(target), { recursive: true })
    const existing = await fs.readFile(target, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing && !existing.includes('protocol-version:'))
      throw new Error(
        'Existing ari skill is not managed by Ari; preserve or move it before installing.',
      )
    if (existing !== content) await fs.writeFile(target, content, 'utf8')
    process.stdout.write(
      JSON.stringify({ ok: true, path: target, updated: existing !== content }) + '\n',
    )
    return
  }
  const command = parse(argv)
  let result = await request(command.method, command.params, command.timeoutMs)
  if (
    result.ok &&
    command.flags.wait &&
    ['session.prompt', 'session.spawn'].includes(command.method)
  ) {
    const id = result.result.sessionId || result.result.child.id
    const waited = await request(
      'session.wait',
      { targetSessionIds: [id], timeoutMs: command.timeoutMs },
      command.timeoutMs,
    )
    result = waited.ok ? { ok: true, result: { ...result.result, wait: waited.result } } : waited
  }
  process.stdout.write(JSON.stringify(result, null, command.flags.json ? 0 : 2) + '\n')
  if (!result.ok) process.exitCode = 1
}

module.exports = { parse, request, main }
if (require.main === module)
  void main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(JSON.stringify(failure('invalid_request', error.message)) + '\n')
    process.exitCode = 1
  })
