# insta_logger — Chromium container: one Chromium (headful under Xvfb, VNC for the live screen) per user, each under
# its own unix user, started on demand by the manager (manager/, Go, standard library only).
# Exposes (on the internal backend network only), with a per-user bearer token on every route:
#   9223/tcp  manager API: /i/<id>/ensure, /i/<id>/cdp/… (DevTools relay: version, tab list, browser websocket),
#             /i/<id>/vnc (tunnel to the user's x11vnc)
ARG GO_IMAGE=golang:1.24-bookworm

FROM ${GO_IMAGE} AS manager-build
WORKDIR /src
COPY manager/ ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ig-chromium-manager .

FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb x11vnc \
      iproute2 curl ca-certificates tini findutils \
      fonts-noto-color-emoji fonts-noto-core fonts-dejavu-core fonts-liberation \
      libgl1-mesa-dri libglx-mesa0 libegl-mesa0 libgl1 libegl1 \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Managed policy: lock the browser down to Instagram (and the Meta domains its login and media use).
COPY policies.json /etc/chromium/policies/managed/insta_logger.json
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=manager-build /out/ig-chromium-manager /usr/local/bin/ig-chromium-manager
# Tenant 1 (the first account) keeps the user of the single-user releases (uid 10002), so its Instagram session in
# /data/profile is still readable after an upgrade. The manager creates the other users' directories on demand and
# starts their browsers under uid 10100+<id> (it needs only CAP_SETUID/SETGID/CHOWN/KILL for that).
RUN chmod 0644 /etc/chromium/policies/managed/insta_logger.json \
 && chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/ig-chromium-manager \
 && groupadd -g 10002 chrome \
 && useradd -u 10002 -g 10002 -M -d /home/chrome -s /usr/sbin/nologin chrome \
 && mkdir -p /data /home/chrome \
 && chown 10002:10002 /data/ \
 && chmod 0700 /data

# The manager (root, bounded capabilities) drops every browser to its own unix user.
ENV SCREEN=1280x800x24
VOLUME ["/data"]
EXPOSE 9223
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:9223/healthz || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
