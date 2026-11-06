# Source control

Open Source control from the Git titlebar control. Reviews open in a full-width workspace by default; dock them beside the conversation, or change the default in Settings → Source control.

The Changes tab includes a filterable file tree, commit history, working/staged/branch/session comparisons, split and unified diffs, search, line wrapping, viewed markers, and line-range attachments. Stage selected files, commit the index, push or pull, and manage branches and stashes from the review controls. Mutations check the reviewed snapshot and refuse stale state or an active agent writer. Discard creates a recovery checkpoint first. Creating or switching branches requires a clean worktree.

Git operations work with any configured Git remote. Hosted request features use these adapters:

| Host                                            | Authentication                                           | Request actions                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GitHub.com, Enterprise Server, Enterprise Cloud | Access token or `gh auth login`                          | Create, diff, comment, approve, request changes, draft/ready, merge, close                                |
| GitLab.com and self-managed                     | Token with `api` scope or `glab auth login`              | Create, diff, comment, approve, draft/ready, merge, close                                                 |
| Forgejo, Gitea, Codeberg                        | Repository/issue access token                            | Create, diff, comment, approve, request changes, title-based draft/ready, merge, close                    |
| Bitbucket Cloud and Data Center                 | Access token; Cloud API tokens also need Atlassian email | Create, diff, comment, approve, merge, decline                                                            |
| Azure DevOps and Server                         | PAT with Code read/write                                 | Create, diff, comment, draft/ready, merge, abandon                                                        |
| GitCafe                                         | Access token                                             | Create, diff, comment, approve, request changes, draft/ready, merge, close, subject to server permissions |

Add an HTTPS instance URL in Settings → Source control. Include the organization for Azure Cloud or the collection for Azure Server. Self-hosted instances are identified from saved connections; Ari does not guess the provider of an unknown private host. SSH and HTTPS remotes are supported, including GitLab subgroups and Azure repository names with spaces.

Tokens are encrypted through Ari's existing device secret storage. Only account/connection metadata returns to the renderer. Credentials are scoped to the exact instance. Requests have deadlines and response limits; Bitbucket diff redirects must stay on the configured API origin. Git's own fetch/push authentication remains separate from hosting API tokens.

The Pull requests tab lists up to 30 open pull or merge requests. Open a request to review its description and files, submit a review, create a separate checkout, close it, or merge it. Merge verifies the current head against the loaded request head and leaves branch protection/conflict checks to the host. GitLab and Bitbucket approvals post review text as a separate comment; if that comment fails, the approval result is reported and the UI retains the text.

Azure and Bitbucket Data Center diffs and request checkouts fetch hidden Git refs and require working Git credentials. GitCafe reads version-bound diff pages through its API. Oversized or omitted diffs produce an explicit error instead of an incomplete clean view. Inline threaded host reviews, check administration, and reviewer/label management remain on the hosting website.

The provider boundaries and expandable review layout were informed by the MIT-licensed [t3code](https://github.com/pingdotgg/t3code) implementation. Ari uses its own contracts, encrypted store, React components, virtualized diff surface, and Git services.

Validation uses provider HTTP fixtures, real temporary Git repositories, renderer interaction tests, typechecking, lint, and a production desktop build. Live provider accounts were not exercised in this change.
