# Releasing Ari

1. In one PR, set `version` in `apps/desktop/package.json` and add `docs/releases/<version>.md` with the notes. Merge it once `verify` passes.
2. Tag the merge commit on `main` and push the tag:

   ```sh
   git tag v<version> <merge commit>
   git push origin v<version>
   ```

The `release` workflow builds Windows, macOS and Linux, checks that every installer and `latest*.yml` update file is present and that each packaged app starts and loads its native modules, and then publishes the release with the notes file. It stops before publishing if the tag doesn't match the version, the notes file is missing, or any platform fails.

To try the builds and checks without releasing, run the `release` workflow by hand on a branch (Actions → release → Run workflow).
