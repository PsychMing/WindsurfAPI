# Release signing

> **Status: releases are signed from v3.10.0 onward.** The release workflow signs
> the four published binaries/zips and `SHA256SUMS` with cosign keyless signing:
> the signer identity is the workflow's GitHub OIDC token, exchanged for a
> short-lived Fulcio certificate. There is no long-lived private key, no signing
> secret, and no key material in this repository. Releases before v3.10.0 are
> unsigned and have no signature assets.

## What a release publishes

`.github/workflows/release.yml` attaches five signed blobs to the GitHub Release,
plus one Sigstore bundle for each one:

| Blob | Produced by |
|---|---|
| `windsurfapi.exe` | Windows single-exe (`@yao-pkg/pkg` + esbuild) |
| `windsurfapi-windows.zip` | exe + tray launcher scripts |
| `windsurfapi-macos-arm64` | macOS arm64 binary |
| `windsurfapi-macos.zip` | arm64 binary (x64 if the optional job succeeded) + launch scripts |
| `SHA256SUMS` | `sha256sum` over exactly the four assets above |

For every row, the release also carries one file:

| Artifact | Contents | Use |
|---|---|---|
| `<name>.sigstore.json` | Sigstore bundle: certificate, signature, Rekor inclusion proof | **authoritative** — verifies after the certificate expires |

The bundle is the durable proof. A Fulcio certificate lives for minutes, and
`cosign verify-blob --certificate` checks it against the current time unless a
signed timestamp is supplied. Verify the bundle; there is no detached `.sig` or
`.pem` pair attached to v3.10.0+ releases.

The manifest uses the **asset names as they appear on the release page** (flat),
so `sha256sum -c SHA256SUMS` works in the directory where the assets were
downloaded.

## Verify a download

Download every asset and signature file into one empty directory, then either
run the helper or the commands it wraps.

### Helper

```bash
node scripts/verify-release-assets.mjs /path/to/download
# or, from this checkout with the default directory:
node scripts/verify-release-assets.mjs --dir /path/to/download
```

The helper requires [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
on `PATH` (or `--cosign <path>`). It verifies the manifest bundle first, checks
the four assets against the signed manifest, then verifies each asset's own
bundle against the release identity and issuer. Exit codes: `0` verified,
`1` verification failed, `2` usage or environment error.

### Manual commands

```bash
# 1. Verify the manifest's own signature. This is the trust anchor.
cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS

# 2. Verify each asset's own bundle.
for f in windsurfapi.exe windsurfapi-windows.zip windsurfapi-macos-arm64 windsurfapi-macos.zip; do
  cosign verify-blob \
    --bundle "$f.sigstore.json" \
    --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$f"
done

# 3. Check the bytes against the now-authenticated manifest.
sha256sum -c SHA256SUMS
```

Only the `.sigstore.json` bundle is published from v3.10.0 onward; there is no
detached `.sig`/`.pem` pair to verify. The bundle is the durable proof.

On macOS use `shasum -a 256 -c SHA256SUMS`. On Windows, `Get-FileHash` replaces
step 3:

```powershell
Get-Content SHA256SUMS | ForEach-Object {
  $expected, $name = $_ -split '\s+', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $name).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { throw "MISMATCH: $name" }
}
```

The identity is the workflow ref that GitHub's OIDC token carries for a tag
push. To pin one exact release, replace the regexp with:

```text
--certificate-identity https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/v3.10.0
```

### Identity and issuer

| Claim | Value |
|---|---|
| Issuer | `https://token.actions.githubusercontent.com` |
| Identity (tag build) | `https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/vX.Y.Z` |

`scripts/verify-release-assets.mjs`（`--tag vX.Y.Z` 生成精确锚定的 identity，验收某个版本时用它，不要只依赖默认正则） carries the same values as
`DEFAULT_IDENTITY_REGEXP` / `DEFAULT_OIDC_ISSUER`; `test/release-signing.test.js`
fails if this page and the script drift apart.

## What the signature proves — and what it does not

It proves that the signed bytes were presented to Sigstore by the
`release.yml` workflow running in `dwgx/WindsurfAPI` for a `v*` tag, and that
the signature was recorded in the public Rekor transparency log. Anyone who can
publish or overwrite the GitHub Release but cannot obtain that OIDC identity
cannot produce a matching signature.

It does **not** prove:

- **Human review or intent.** The workflow signs whatever the tag points at.
  A compromised maintainer account that can push a tag can also run the
  workflow and produce a valid signature. Check the tag and commit out of band
  when that matters.
- **A reproducible build.** The signature attests to the produced bytes, not to
  a verifiable correspondence with the source tree.
- **That every build action is immutable.** The cosign installer is pinned by
  commit SHA and cosign to an exact release, but the rest of the workflow still
  uses major action tags (SEC-11 is not fully closed). A compromised upstream
  action runs before the signature is produced, so the signature would faithfully
  cover a malicious build.
- **The Docker image.** This signing covers release assets only; the GHCR image
  is not signed by this workflow.

The signature is a provenance claim from a specific repository identity. It is
not a substitute for the hash check, and the hash check is not a substitute for
the signature: the manifest and the binaries used to be served from the same
release with no root of trust outside it.

## How the release job is wired

The `release` job in `.github/workflows/release.yml`:

1. assembles the Windows/macOS assets and generates `SHA256SUMS`;
2. installs `sigstore/cosign-installer` pinned by commit SHA, with
   `cosign-release: 'v3.1.4'`;
3. runs `cosign sign-blob` once per signed blob, writing one
   `<name>.sigstore.json` bundle per blob;
4. refuses to continue if any signature bundle is empty;
5. uploads the assets and all signature bundles to the GitHub Release.

The job has `permissions: contents: write` and `id-token: write`. The OIDC
permission is what lets cosign obtain a Fulcio certificate; no repository secret
is read anywhere in the signing path. A signing failure fails the job, so a
release cannot be published with the notes claiming signatures but no signature
assets.

Signing depends on Sigstore (Fulcio for the certificate, Rekor for the
transparency entry, TUF for the trust root). An outage blocks the release rather
than silently shipping unsigned assets. That is deliberate: a release that says
it is signed and is not is worse than an obviously unsigned one.

## Install and self-update paths

These paths do not download GitHub Release assets, so the cosign signatures do
not cover them. Do not pretend otherwise in support replies.

### Dashboard `/self-update` (git checkout)

`src/dashboard/api.js` updates by fetching a stable `vX.Y.Z` tag, checking that
the tag object and peeled commit are consistent, that the commit is an ancestor
of the update branch, and that the move is a fast-forward. The trust anchor is
GitHub's ref namespace plus TLS plus the configured `origin` URL. It never
downloads `SHA256SUMS` or a binary, so there is nothing here for cosign to
verify.

Adding `git verify-tag` is a separate root of trust (a signing key that every
deployment must already have) and is intentionally not wired: a verifier that
fails closed on machines without the key would break every existing
installation. That remains future work.

### `deploy/update.sh` (Docker)

The script pulls a mutable tag by default and recreates only the app service,
with a `/health` gate and rollback. Release-asset signatures do not cover the
image. The stronger posture is to pin a digest:

```bash
docker buildx imagetools inspect ghcr.io/dwgx/windsurf-api:<tag>
bash deploy/update.sh --image ghcr.io/dwgx/windsurf-api@sha256:<digest>
```

A future change could sign the image by digest with the same keyless identity;
that is not part of this release-asset signing work.

### Windows / manual install

The Windows distribution is a manual download. Verify before running the exe:
follow [Verify a download](#verify-a-download) with the downloaded files in one
directory. `deploy/windows/README.md` points here. A trojaned exe runs with the
user's privileges and reads the side-by-side `.env` and `accounts.json`, so this
is the path where verification matters most.

### `install-ls.sh`

This installer downloads language-server binaries from a different repository
(`windsurf-ls-release`) and verifies their own manifest/pin hashes. It is not
covered by the release-asset signatures described here.

## Historical releases

- v3.10.0 and later: signed as described above.
- v3.9.53–v3.9.60: `SHA256SUMS` only, unsigned. v3.9.53 recorded build-tree
  paths (`dist-windows/...`, `dist-macos/...`); later releases use flat names.
- Earlier releases: no manifest and no signatures.

## Changing the identity

If the repository, workflow path, or signing mechanism changes, update the
identity in three places together: this document, `DEFAULT_IDENTITY_REGEXP` in
`scripts/verify-release-assets.mjs`, and the release workflow. The signing test
compares the document with the script so a partial update fails CI. Treat an
identity change as a trust-root change: users who pinned the old identity must
be told explicitly.
