import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Tool } from '../tools'

/**
 * Structured plan tracking for Ari Core. The todo list lives at a fixed
 * path inside the workspace so it can never escape the jail: no argument
 * influences the file location, only the file contents.
 *
 * The file is scoped per session — every session in a project shares the
 * workspace folder, so a single shared file would leak one agent's plan
 * into every other session's transcript header.
 */

export const TODO_FILENAME = '.ari-todo.json'

/**
 * Workspace-relative plan filename for a session. Session ids come from
 * the engine, but a path separator would escape the workspace — sanitize
 * rather than trust (same shape as FileConversationStore's key mapping).
 * An absent session keeps the legacy shared filename.
 */
export function todoFilenameFor(sessionId?: string | null): string {
  if (!sessionId) return TODO_FILENAME
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `.ari-todo-${safe}.json`
}

export type TodoStatus = 'pending' | 'in_progress' | 'done'

export interface TodoItem {
  text: string
  status: TodoStatus
}

function parseItems(args: Record<string, unknown>): TodoItem[] {
  const raw = args['items']
  if (!Array.isArray(raw)) throw new Error('items must be an array')
  const items: TodoItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('each item must be an object with text and status')
    }
    const record = entry as Record<string, unknown>
    const text = record['text']
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('each item needs a non-empty text')
    }
    const status = record['status']
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done') {
      throw new Error(`invalid status: ${String(status)}`)
    }
    items.push({ text, status })
  }
  return items
}

/** Renders items as a numbered markdown-style checklist. */
export function formatChecklist(items: TodoItem[]): string {
  if (items.length === 0) return '(empty todo list)'
  return items
    .map((item, index) => {
      const box = item.status === 'done' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'
      return `${index + 1}. ${box} ${item.text}`
    })
    .join('\n')
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Write the structured plan/todo list for the current task. Overwrites the previous list; pass the full list every time.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'The complete todo list',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What needs to happen' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['items'],
  },
  execute: async (args, ctx) => {
    const items = parseItems(args)
    // Fixed workspace-relative target — arguments cannot move it. Scoped to
    // the session so sibling sessions in one project never share a plan.
    const filename = todoFilenameFor(ctx.sessionId)
    const target = path.join(ctx.workspacePath, filename)
    await fs.writeFile(target, JSON.stringify(items, null, 2), 'utf8')
    return `${formatChecklist(items)}\n(saved to ${filename})`
  },
}
