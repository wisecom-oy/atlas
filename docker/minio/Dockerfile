# MinIO server and client, compiled from MinIO's own source.
#
# MinIO stopped publishing community binaries and images in October 2025 and archived the
# repository in 2026. Docker Hub has since removed `minio/minio` and quay.io refuses anonymous
# pulls of it (issue #800), so there is no official prebuilt image left to pin. MinIO's README
# now names a source build (`go install github.com/minio/minio@latest`) as the way to run the
# community edition. This file does that at pinned commits.
#
# Both commits are the final heads of the archived `minio/minio` and `minio/mc` repositories,
# which is what `@latest` resolves to. The server commit is newer than the last tagged release
# (RELEASE.2025-10-15T17-29-55Z, which fixed GHSA-jjjj-jwhf-8rgr) and adds the PostPolicy tag
# enforcement and conditional-put quorum fixes that never made it into a release.
#
# `go install` fetches through proxy.golang.org and checks every module against
# sum.golang.org, so the build is reproducible from a commit hash alone and keeps working if
# the GitHub repositories disappear. The two base images are Docker Official Images, pinned
# by digest, and pull anonymously.

# Go 1.27.x. MinIO needs 1.24 or later; a supported toolchain carries current stdlib fixes.
FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build

# github.com/minio/minio master, 2026-02-12, archived head.
ARG MINIO_COMMIT=7aac2a2c5b7c882e68c1ce017d8256be2feea27f
ARG MINIO_COMMIT_DATE=2026-02-12T20-18-48Z
# github.com/minio/mc master, 2025-11-06, archived head.
ARG MC_COMMIT=77f82e18b5401a65958f1619df6ebb994634bd88

ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-trimpath

# The -X flags mirror MinIO's buildscripts/gen-ldflags.go, so `minio --version` names the
# commit instead of DEVELOPMENT.GOGET.
RUN go install -ldflags "-s -w \
      -X github.com/minio/minio/cmd.Version=${MINIO_COMMIT_DATE} \
      -X github.com/minio/minio/cmd.CopyrightYear=2026 \
      -X github.com/minio/minio/cmd.ReleaseTag=DEVELOPMENT.${MINIO_COMMIT_DATE} \
      -X github.com/minio/minio/cmd.CommitID=${MINIO_COMMIT} \
      -X github.com/minio/minio/cmd.ShortCommitID=$(echo "${MINIO_COMMIT}" | cut -c1-12)" \
      "github.com/minio/minio@${MINIO_COMMIT}" \
 && go install -ldflags "-s -w" "github.com/minio/mc@${MC_COMMIT}"

FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

COPY --from=build /go/bin/minio /go/bin/mc /usr/bin/

# Same defaults as the image MinIO used to publish: data under /data, `mc` config in /tmp.
ENV MC_CONFIG_DIR=/tmp/.mc
VOLUME ["/data"]
EXPOSE 9000 9001
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data"]
