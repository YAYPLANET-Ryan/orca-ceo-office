# CEO Office custom update pipeline

The custom Windows installer publishes to `YAY-LABS/orca-ceo-office` and
keeps the CEO Office sidebar in every build. The workspace at `E:\ORCA` is
not bundled into the installer and remains a separate data repository.

## One-time GitHub setup

Create `YAY-LABS/orca-ceo-office` as a public repository. A public repository
is required for unauthenticated installed clients to read GitHub Release
update metadata and download installer assets. Do not put business documents,
credentials, or private workspace data in this repository.

Then push the custom branch:

```powershell
git remote add custom https://github.com/YAY-LABS/orca-ceo-office.git
git push -u custom ryan/ceo-office-sidebar
```

## Release flow

- `Sync Orca Upstream` runs daily and opens a PR when `stablyai/orca/main`
  changes.
- Review and merge that PR into `ryan/ceo-office-sidebar`.
- The merge triggers `Custom Windows Release`.
- The workflow builds, tests, and publishes the Windows installer and update
  metadata to GitHub Releases.
- Installed clients use the existing Orca updater to discover the Release.

Use workflow dispatch with an explicit version for the first release. The
version must be higher than the installed version, for example:
`1.4.169-ceo.20260805.1`.
