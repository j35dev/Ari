import { GitActions } from './GitActions'
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace'

/** The shared review canvas with explicit, snapshot-guarded local Git controls. */
export function SourceControlWorkspace({
  onCreatePr,
  ...props
}: Omit<ReviewWorkspaceProps, 'label' | 'renderControls'> & { onCreatePr?: () => void }) {
  return (
    <ReviewWorkspace
      {...props}
      label="Source control"
      renderControls={(state) => <GitActions {...state} onCreatePr={onCreatePr} />}
    />
  )
}
