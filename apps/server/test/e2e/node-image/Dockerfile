# A throwaway stand-in for a real Linux host: systemd as PID 1, a real dockerd,
# and the shadow tools — so the agent under test sees the same surface it sees on
# a homelab box (systemd units, /var/run/docker.sock, useradd), not a stripped
# container. Runs privileged; the host needs cgroup v2.
FROM debian:13-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update && apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus \
        ca-certificates curl gnupg \
        iproute2 iptables kmod procps passwd sudo xz-utils \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-compose-plugin \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Units that have no business running in a container and only produce noise or
# hangs at boot.
RUN systemctl mask \
        systemd-udevd.service systemd-udev-trigger.service \
        systemd-modules-load.service systemd-journald-audit.socket \
        systemd-firstboot.service systemd-resolved.service \
        getty.target console-getty.service \
    && systemctl enable docker.service

# The image ships one /etc/machine-id, so every container from it would be the
# same machine as far as the fleet is concerned — agents are keyed on that id and
# three nodes would collapse into one entry. Blanking it is the same step you run
# before cloning a VM template; systemd generates a fresh one on each boot.
RUN rm -f /var/lib/dbus/machine-id && : > /etc/machine-id

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
