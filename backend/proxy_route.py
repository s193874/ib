"""Owner-authenticated, per-API HTTP(S) routing through the existing local Mihomo proxy.

Only invoked by the authenticated IB adapter's POST /proxy endpoint.
Never logs authentication headers, model prompts, URL query strings, or response bodies.
"""
import ipaddress
import socket
import urllib.error
import urllib.parse
import urllib.request

PROXY = "http://127.0.0.1:7890"
MAX_BYTES = 16 * 1024 * 1024
FORWARD_HEADERS = {
    "content-type", "accept", "authorization", "x-api-key",
    "anthropic-version", "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "x-goog-api-key", "x-dashscope-sse",
    "openai-organization", "openai-project"
}
opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
)


def validate_target(value):
    if not isinstance(value, str) or not value or len(value) > 8192:
        raise ValueError("invalid_proxy_target")
    try:
        url = urllib.parse.urlsplit(value)
        host = url.hostname
        port = url.port or 443
    except ValueError:
        raise ValueError("invalid_proxy_target")
    if (url.scheme != "https" or not host or url.username or url.password
            or not (1 <= port <= 65535)
            or any(ch in value for ch in ("\r", "\n", "\x00"))
            or host.lower() == "localhost" or host.lower().endswith(".localhost")
            or host.lower().endswith(".local")):
        raise ValueError("invalid_proxy_target")
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:
            raise ValueError("private_proxy_target")
    except ValueError as e:
        if str(e) == "private_proxy_target":
            raise
        if not all(part and part.replace("-", "").isalnum() for part in host.rstrip(".").split(".")):
            raise ValueError("invalid_proxy_target")
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ValueError("proxy_dns_failed")
    if not addresses or not all(ipaddress.ip_address(addr[4][0]).is_global for addr in addresses):
        raise ValueError("private_proxy_target")
    return value


def handle(handler, payload):
    method = handler.headers.get("X-IB-Target-Method", "POST").upper()
    if method not in ("POST", "GET"):
        return handler.send(405, {"ok": False, "error": "proxy_method_denied"})
    if method == "GET" and payload:
        return handler.send(400, {"ok": False, "error": "proxy_get_body_denied"})
    try:
        url = validate_target(handler.headers.get("X-IB-Target-URL", ""))
    except ValueError as e:
        return handler.send(400, {"ok": False, "error": str(e)})
    headers = {k: v for k, v in handler.headers.items() if k.lower() in FORWARD_HEADERS}
    request = urllib.request.Request(url, data=payload if method == "POST" else None,
                                     method=method, headers=headers)
    try:
        upstream = opener.open(request, timeout=120)
    except urllib.error.HTTPError as e:
        upstream = e  # Preserve the real provider error/status for API diagnostics.
    except (OSError, urllib.error.URLError, TimeoutError, ValueError):
        return handler.send(502, {"ok": False, "error": "clash_upstream_unreachable"})
    try:
        with upstream:
            handler.send_response(upstream.status)
            handler.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
            if upstream.headers.get("Content-Encoding"):
                handler.send_header("Content-Encoding", upstream.headers["Content-Encoding"])
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("X-Content-Type-Options", "nosniff")
            handler.send_header("Connection", "close")
            length = upstream.headers.get("Content-Length")
            if length and length.isdecimal():
                handler.send_header("Content-Length", length)
            handler.end_headers()
            handler.close_connection = True
            # read1() returns available bytes instead of waiting for 16KB to fill:
            # required to preserve provider SSE streaming / cancellation.
            while True:
                chunk = upstream.read1(16384)
                if not chunk:
                    break
                handler.wfile.write(chunk)
                handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
        pass  # Browser aborted an in-flight generation, or provider connection closed.
