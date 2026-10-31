/** Registers a request worktree as its own project and starts a session there. */
export async function openCheckedOutWorktree(
  path: string,
  deps: {
    open: (path: string) => Promise<{ id: string; status: string }>
    refreshProjects: () => void
    startSession: (projectId: string) => void
  },
): Promise<void> {
  const project = await deps.open(path)
  deps.refreshProjects()
  if (project.status === 'ok') deps.startSession(project.id)
}
