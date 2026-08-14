# CEO Office custom update pipeline

The custom Windows installer publishes to `YAYPLANET-Ryan/orca-ceo-office` and
keeps the CEO Office sidebar in every build. The workspace at `E:\ORCA` is
not bundled into the installer and remains a separate data repository.

## One-time GitHub setup

Create `YAYPLANET-Ryan/orca-ceo-office` as a public repository. A public repository
is required for unauthenticated installed clients to read GitHub Release
update metadata and download installer assets. Do not put business documents,
credentials, or private workspace data in this repository.

Then push the custom branch:

```powershell
git remote add custom https://github.com/YAYPLANET-Ryan/orca-ceo-office.git
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
- The release also contains `orca-windows-setup.exe.sha256` so a manually
  downloaded installer can be verified before it runs.

## Endpoint distribution rule

Build the Windows installer once in the release workflow. Paired laptops and
other endpoint PCs must download the verified GitHub Release asset; they must
not clone the repository, install a compiler toolchain, or rebuild Orca.

For an unpublished hotfix, upload the verified installer to a draft release and
download it with an authenticated GitHub CLI session. For a normal published
release, let the built-in Orca updater install it. Use manual download only when
the updater is unavailable.

After a manual download, compare the installer SHA256 with the accompanying
`.sha256` asset before starting the installer.

Use workflow dispatch with an explicit version for the first release. The
version must be higher than the installed version, for example:
`1.4.169-ceo.20260805.1`.
