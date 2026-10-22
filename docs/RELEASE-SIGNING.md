# Release artifacts: what is verified today, and the unsigned-release risk

> **Status: releases are unsigned.** This file records the controls that exist,
> what each one actually proves, and the concrete signing path this project can
> adopt. No private key, keystore, or signing credential belongs in this
> repository; only a public verification key may be committed.

## What a release publishes

`.github/workflows/release.yml` builds and attaches five files to the GitHub
Release:

| Asset | Produced by |
|---|---|
| `windsurfapi.exe` | Windows single-exe (`@yao-pkg/pkg` + esbuild) |
| `windsurfapi-windows.zip` | exe + tray launcher scripts |
| `windsurfapi-macos-arm64` | macOS arm64 binary |
| `windsurfapi-macos.zip` | arm64 binary (x64 if the optional job succeeded) + launch scripts |
| `SHA256SUMS` | `sha256sum` over exactly the four assets above |

The same workflow pushes a GHCR image with the mutable tags `latest` (stable
releases only), `X.Y.Z`, and `X.Y`.

### Manifest layout

The manifest uses the **asset names as they appear on the release page** (flat),
so `sha256sum -c SHA256SUMS` works in the directory where the five files were
downloaded. The first release with a manifest, `v3.9.53`, recorded build-tree
paths (`dist-windows/windsurfapi.exe`, `dist-macos/...`); for it, recreate the
directories before checking, or compare hashes manually. Earlier releases have
no `SHA256SUMS` at all.

## Verify a download today

Download all five assets into one empty directory, then:

```bash
# Linux
sha256sum -c SHA256SUMS

# macOS (BSD shasum)
shasum -a 256 -c SHA256SUMS
```

Windows PowerShell (no `sha256sum` by default):

```powershell
Get-Content SHA256SUMS | ForEach-Object {
  $expected, $name = $_ -split '\s+', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $name).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { throw "MISMATCH: $name" }
}
```

A pass proves the bytes match the manifest. It does **not** prove who produced
the manifest.

## OTA update verification

The project has two OTA paths. Neither verifies a cryptographic signature.

### Dashboard `/self-update` (git checkout)

`src/dashboard/api.js` implements the update as a Git operation:

1. `git fetch --no-tags origin <branch>` — a failed fetch is not permission to
   operate on stale refs.
2. `git ls-remote --tags origin 'refs/tags/v[0-9]*'` — the remote tag namespace
   is the publication authority; local tags are neither read nor mutated.
3. Only stable `vX.Y.Z` tags are considered. The newest one reachable from
   `origin/<branch>` is selected.
4. The exact remote tag ref is fetched into `FETCH_HEAD` and checked against the
   object ID that `ls-remote` advertised. Annotated tags must be tag objects
   whose peeled commit matches; a lightweight tag must name exactly one commit.
5. The tag's commit must be an ancestor of `origin/<branch>`.
6. The update is a fast-forward merge to that commit; divergence is refused. A
   dirty tracked tree is refused unless `forceReset` is explicitly requested,
   and local commits ahead of `origin/<branch>` are protected by
   `DASHBOARD_ALLOW_HARD_RESET`.
7. A rollback point is written before the mutation and promoted only after Git
   proves HEAD reached the expected commit. `/self-update/rollback` restores it.

What this does **not** do: `git verify-tag` / `git verify-commit`. There is no
signature check anywhere in the path. The trust anchor is GitHub's ref namespace
plus TLS plus the configured `origin` URL. `forceUpdate` deliberately follows
`origin/<branch>` HEAD instead of the newest tag.

### `deploy/update.sh` (Docker)

The script pulls a **mutable tag** by default (`ghcr.io/dwgx/windsurf-api:latest`,
or `--tag X.Y.Z`), recreates only the app service, waits for `/health`, and
restores the previous image if the health gate fails. It does not verify an
image digest or signature.

A stronger manual posture is available today: `--image
ghcr.io/dwgx/windsurf-api@sha256:<digest>` pins the exact image. Get the digest
from `docker buildx imagetools inspect ghcr.io/dwgx/windsurf-api:<tag>` or from
the running container, and compare it with a value obtained out of band.

## The unsigned-release risk

`SHA256SUMS` and the binaries are served from the same GitHub Release. Anyone who
can publish or overwrite that release — a compromised maintainer account, a
stolen CI token, or a malicious workflow change — can replace the binary and the
manifest together. A user who verifies both from the same page gets integrity
against corruption and in-transit damage, but not authenticity.

Concrete consequences:

- The Windows exe runs with the user's privileges and reads the side-by-side
  `.env` (gateway keys and optional upstream credentials) and `accounts.json`
  (upstream session tokens). A trojaned release is credential theft, not just a
  bad binary.
- The Docker `latest` tag is mutable; a registry-account compromise can retag
  it. The health gate and rollback protect against a broken image, not a
  malicious one.
- The git OTA path installs the newest stable tag reachable from the update
  branch, signed or not. A compromised GitHub account that can push such a tag
  can move every auto-updating deployment.
- The build pipeline is large (`@yao-pkg/pkg`, esbuild, Node) and the workflow
  actions are pinned to major tags rather than commit SHAs; a compromise there
  happens before the hashing step, so the manifest would faithfully describe a
  malicious build.

What is already mitigated: TLS to GitHub/GHCR, the tag/ancestry/fast-forward
checks, the clean-tree and local-commit guards, the rollback point, the Docker
health gate and rollback, `secret-scan` in CI, and exact pins for esbuild/pkg in
the release jobs.

## Future path (concrete, no key material)

Three concrete options, plus two orthogonal improvements. Pick one root of trust
and verify it out of band.

### Option A — cosign keyless (Sigstore)

No long-lived key. The release job signs the manifest with the workflow's OIDC
identity; the signature, certificate, and transparency-log proof travel in a
bundle.

```yaml
# add to the release job's existing permissions
permissions:
  contents: read
  id-token: write          # OIDC for keyless signing
steps:
  - uses: sigstore/cosign-installer@<commit-sha>   # pin per SEC-11
  - run: cosign sign-blob --yes --bundle SHA256SUMS.sigstore.json SHA256SUMS
```

Publish `SHA256SUMS.sigstore.json` next to `SHA256SUMS`. Verify with:

```bash
cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

Trade-offs: depends on Sigstore/Fulcio/Rekor availability; the artifact digest is
recorded in a public transparency log (the digest is already public); the
verification identity is a workflow path, so a renamed workflow needs a new
regexp.

### Option B — minisign (offline key)

A small Ed25519 signature over `SHA256SUMS`. The private key stays offline; when
adopted, only the public key would be committed here and in the README.

```bash
# once, on an offline machine (passphrase-protected key)
minisign -G -p minisign.pub -s minisign.key

# per release
minisign -S -s minisign.key -m SHA256SUMS        # writes SHA256SUMS.minisig

# verification
minisign -Vm SHA256SUMS -p minisign.pub
```

Publish `SHA256SUMS.minisig` next to `SHA256SUMS`. Signing can happen on a
maintainer workstation and the signature uploaded by hand, or in CI with the
encrypted private key and its passphrase stored as secrets — the offline option
keeps the key out of CI entirely.

Trade-offs: manual custody and a public-key distribution problem; a lost key
means a new key and a new trust-on-first-use decision for users. It is the
simplest option that does not depend on a third-party service.

### Option C — GitHub artifact attestations

`actions/attest-build-provenance` records a build-provenance attestation tied to
the workflow identity; users verify with the GitHub CLI.

```yaml
permissions:
  contents: read
  id-token: write
  attestations: write
steps:
  - uses: actions/attest-build-provenance@v2
    with:
      subject-path: |
        dist-windows/windsurfapi.exe
        dist-windows/windsurfapi-windows.zip
        dist-macos/windsurfapi-macos-arm64
        windsurfapi-macos.zip
        SHA256SUMS
```

```bash
gh attestation verify windsurfapi.exe --repo dwgx/WindsurfAPI
```

Trade-offs: no key, but verification is GitHub-specific and the attestation
proves the workflow built the artifact, not that a human reviewed the commit.

### Orthogonal — signed release tags

Annotated tags are already used for releases, but they are not signed. `git tag
-s vX.Y.Z` plus a distributed public key would let the OTA path call `git
verify-tag` before merging. That is a separate key and a separate distribution
problem; do not add `verify-tag` to the updater until the key is available to
every deployment, or the update path will fail closed on machines without it.

### Docker images

Once a signing option is chosen, sign the image by digest (`cosign sign
ghcr.io/dwgx/windsurf-api@sha256:<digest>`) and verify before `deploy/update.sh`
recreates the service. Pinning `--image repo@sha256:<digest>` is already
supported and is a useful stopgap.

## Recommended order

1. **cosign keyless or GitHub attestations** — no offline key custody, and the
   release job can obtain an OIDC identity by adding `id-token: write`.
2. **minisign** — if offline signing is preferred over a Sigstore dependency.
3. **Signed tags** — only when the OTA verifier can be given the public key.

Acceptance for any option: a user can verify with one command against a public
key or identity that is **not served from the same release page**, and the OTA
path verifies the same root. Until then, treat the current hashes as an
integrity check and say so in support replies.

No key material is added by this document. The only repository change in this
area is the manifest layout fix described above.
