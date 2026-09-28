/**
 * The pane header's on-screen name: the session, prefixed with its project
 * when one is known. Ad-hoc / unfiled sessions keep the session title alone.
 */
export function formatPaneTitle(
  sessionTitle: string | null | undefined,
  projectName: string | null | undefined,
): string | null {
  if (sessionTitle == null || sessionTitle === '') return null
  if (projectName == null || projectName === '') return sessionTitle
  return `${projectName} - ${sessionTitle}`
}
