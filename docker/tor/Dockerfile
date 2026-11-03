# Tor SOCKS5 proxy for connector containers (e.g. nuclei -proxy socks5://oasm-tor:9050).
# Debian's signed tor package instead of a third-party Tor image.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tor \
 && rm -rf /var/lib/apt/lists/*

COPY torrc /etc/tor/torrc

# debian-tor owns /var/lib/tor (guard state, kept on the tor-data volume).
USER debian-tor
EXPOSE 9050
CMD ["tor", "-f", "/etc/tor/torrc"]
