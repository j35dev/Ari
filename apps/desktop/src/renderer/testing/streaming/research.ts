/** Sources checked 23 Nov 2026. Notes describe documentation, not captured live client sessions. */
export const research = [
  {
    product: 'Cursor',
    kind: 'Official release note · Cursor 3.4, May 2026',
    url: 'https://cursor.com/changelog/3-4',
    note: 'Compact, Balanced and Detailed response density let readers choose how much tool activity appears. Ari should support a quiet default with deliberate access to full detail.',
  },
  {
    product: 'VS Code / Copilot',
    kind: 'Current documentation',
    url: 'https://code.visualstudio.com/docs/chat/chat-overview#customize-the-chat-experience',
    note: 'Experimental persistent progress stays visible until the response finishes. Compact mode previews running calls and collapses completed groups. Ari should separate current activity from the history ledger.',
  },
  {
    product: 'Claude Desktop / Cowork',
    kind: 'Official earlier-version tutorial',
    url: 'https://academy.claude.com/tutorials/delegating-your-first-task-in-claude-cowork',
    note: 'The tutorial describes progress at the top right with task details on click, and explicitly notes that its video uses an earlier version. It motivates a separate work log, not a claim about today’s exact pixels.',
  },
  {
    product: 'Claude Desktop / Cowork',
    kind: 'Current documentation',
    url: 'https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork',
    note: 'Current guidance describes per-step progress, steering, questions and parallel work. Claude’s unified chat/Cowork experience is rolling out, so old screenshots should not be treated as current captures.',
  },
  {
    product: 'Codex Desktop',
    kind: 'Official announcement and changelog',
    url: 'https://learn.chatgpt.com/docs/changelog',
    note: 'Codex is now in ChatGPT Desktop. Official updates describe task/subagent progress and reconnection improvements. The original app announcement emphasizes project threads and review in context.',
  },
  {
    product: 'Codex Desktop',
    kind: 'User report, not a verified universal behavior',
    url: 'https://github.com/openai/codex/issues/22334',
    note: 'A report describes manually opened Working details collapsing again during updates. Ari’s detail preference should stay stable through new chunks and reconnects.',
  },
  {
    product: 'Zed',
    kind: 'Official release note',
    url: 'https://zed.dev/releases/stable/1.5.3',
    note: 'Zed shipped improvements for large read-file outlines and pending confirmations scrolled out of view. Detail expansion and offscreen decisions need explicit handling.',
  },
  {
    product: 'Zed',
    kind: 'User report, not a verified universal behavior',
    url: 'https://github.com/zed-industries/zed/discussions/62385',
    note: 'A discussion reports that collapsed per-tool cards still dominate chat. Making each card smaller alone does not solve transcript structure.',
  },
  {
    product: 'Windsurf / Devin Desktop',
    kind: 'Current documentation with legacy distinction',
    url: 'https://docs.devin.ai/desktop/cascade',
    note: 'Windsurf docs now redirect to Devin Desktop and label Cascade legacy. The old agent’s explicit todo list is a useful outline precedent; it should not be described as the current default agent.',
  },
  {
    product: 'Devin Local',
    kind: 'Current documentation',
    url: 'https://docs.devin.ai/desktop/devin-local/overview',
    note: 'Devin Local is the current primary local harness and other ACP agents can be selected. Ari’s presentation must be harness-neutral and capability-aware.',
  },
] as const
