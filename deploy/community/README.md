# Social community image

This is the reproducible image for Social's shared public Community board and
members-only People directory at `www.mobius.you`. Private messages and owner
identity keys remain on each person's own Möbius instance.

Deploy the signed directory-search support before updating personal Social
installations, then close the old public GET directory after they have updated.
The final image in this revision closes GET immediately: deploying it before
updating older installations makes their People search fail. Merging this PR
does not itself perform either deployment or an installation update.

Build only from a committed revision and pass that exact revision into the
image:

```bash
sha="$(git rev-parse HEAD)"
docker build \
  --build-arg "SOURCE_SHA=$sha" \
  -f deploy/community/Dockerfile \
  -t "mobius-social:$sha" .
```

The image exposes `/healthz`, `/version`, and Social's public router under
`/api/common`. Production routing maps
`/api/app-services/social/{directory,board,...}` to that internal prefix.

Merging prepares an immutable candidate; it does not authorize or perform a
production deployment. Production promotion belongs to the host's separate,
service-scoped controller so application maintainers cannot turn repository
write access into general host access.

The repository workflow publishes only the immutable
`ghcr.io/mobius-os/app-social-community:sha-<commit>` candidate and its build
attestation. There is deliberately no moving production tag and no host
credential in this repository.

The Python base image and every Python dependency are digest/version pinned.
Their updates are deliberate reviewed source changes, never an automatic
production replacement.
