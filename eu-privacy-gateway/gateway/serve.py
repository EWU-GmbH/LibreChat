"""Production entrypoint that binds a dual-stack socket.

Railway's private network is IPv6-only (services are reached via their
``*.railway.internal`` AAAA record), but Railway's healthcheck prober connects
over IPv4. A plain ``uvicorn --host ::`` can end up on an IPv6-only socket
(``IPV6_V6ONLY``), which the IPv4 healthcheck cannot reach — and ``--host
0.0.0.0`` is not reachable over the IPv6 private network at all.

This launcher binds one ``AF_INET6`` socket with ``IPV6_V6ONLY`` disabled so it
accepts BOTH native IPv6 (private networking from LibreChat) and IPv4-mapped
connections (the healthcheck), then hands it to uvicorn.
"""

from __future__ import annotations

import os
import socket

import uvicorn


def _dual_stack_socket(port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    except OSError:
        # Best-effort: if the platform forbids toggling V6ONLY we still bind ::.
        pass
    sock.bind(("::", port))
    return sock


def main() -> None:
    port = int(os.environ.get("PORT", os.environ.get("GATEWAY_PORT", "8100")))
    sock = _dual_stack_socket(port)
    config = uvicorn.Config("gateway.app:app", log_level="info")
    server = uvicorn.Server(config)
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
