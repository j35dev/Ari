import { ChangeRequests } from './ChangeRequests'
import { GitActions } from './GitActions'
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace'

/** The shared review canvas with explicit, snapshot-guarded local Git controls. */
export function SourceControlWorkspace({
  onCreatePr,
  onCheckedOut,
  ...props
}: Omit<ReviewWorkspaceProps, 'label' | 'renderControls'> & {
  onCreatePr?: () => void
  onCheckedOut?: (path: string) => Promise<void> | void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChangeRequests scope={props.scope} onCheckedOut={onCheckedOut} />
      <div className="min-h-0 flex-1">
        <ReviewWorkspace
          {...props}
          label="Source control"
          renderControls={(state) => <GitActions {...state} onCreatePr={onCreatePr} />}
        />
      </div>
    </div>
  )
}
