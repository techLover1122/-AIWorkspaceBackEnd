# syntax=docker/dockerfile:1
#
# WhatsApp Go sidecar (whatsmeow). Uses mattn/go-sqlite3 → CGO required.
# go.sum is generated during build (GOFLAGS=-mod=mod) since the repo ships
# only go.mod.

FROM golang:1.25-bookworm AS build
WORKDIR /src
ENV CGO_ENABLED=1 GOFLAGS=-mod=mod
COPY . .
RUN go build -o /out/ai-ide-whatsapp .

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ai-ide-whatsapp /usr/local/bin/ai-ide-whatsapp
ENV LISTEN_ADDR=0.0.0.0:8091 \
    SESSION_DIR=/data
EXPOSE 8091
CMD ["/usr/local/bin/ai-ide-whatsapp"]
