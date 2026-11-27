/** Pi's tool_call hook runs before execution and can block the call. */
export const PI_PERMISSION_EXTENSION = `
export default function ariPermissions(pi) {
  const mode = process.env.ARI_PI_PERMISSION_MODE;
  const readTools = new Set(['read', 'grep', 'find', 'ls']);
  const editTools = new Set(['edit', 'write']);
  for (const [name, config] of Object.entries(JSON.parse(process.env.ARI_PI_MCP_SERVERS || '{}'))) {
    if (typeof pi.registerMcpServer !== 'function') throw new Error('This Pi version cannot register Ari MCP servers. Update Pi.');
    pi.registerMcpServer(name, config);
  }
  pi.on('session_start', (_event, ctx) => ctx.ui.notify('ARI_PI_BRIDGE_READY', 'info'));
  pi.on('tool_call', async (event, ctx) => {
    if (mode === 'full') return;
    const tool = pi.getAllTools().find(tool => tool.name === event.toolName);
    if (tool?.sourceInfo?.source === 'builtin' && (readTools.has(event.toolName) ||
        (mode === 'allow-edits' && editTools.has(event.toolName)))) return;
    if (!ctx.hasUI) return { block: true, reason: 'Ari approval channel is unavailable.' };
    const title = 'ARI_PI_APPROVAL:' + JSON.stringify({toolName: event.toolName, toolCallId: event.toolCallId, args: event.input});
    try {
      const allowed = await ctx.ui.confirm(title, 'Allow this tool call?');
      if (!allowed) return { block: true, reason: 'Denied by Ari user.' };
    } catch {
      return { block: true, reason: 'Ari approval channel failed.' };
    }
  });
}
`
