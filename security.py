"""Bounded request throttling for the single web worker."""
from collections import OrderedDict, deque
from ipaddress import ip_address
from threading import Lock
from time import monotonic


class Throttle:
    def __init__(self, capacity=4096):
        self.capacity = capacity
        self.buckets = OrderedDict()
        self.lock = Lock()

    def take(self, key, limit, window):
        now = monotonic()
        cutoff = now - window
        with self.lock:
            bucket = self.buckets.setdefault(key, deque())
            self.buckets.move_to_end(key)
            if len(self.buckets) > self.capacity:
                self.buckets.popitem(last=False)
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                return False
            bucket.append(now)
            return True

    def clear(self, key):
        with self.lock:
            self.buckets.pop(key, None)


def client_address(environ, *, render_proxy=False):
    candidate = environ.get("REMOTE_ADDR", "")
    if render_proxy:
        # Render appends the client IP. Earlier forwarded entries are caller controlled.
        forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
        if forwarded:
            candidate = forwarded.rsplit(",", 1)[-1].strip()
    try:
        address = ip_address(candidate)
    except ValueError:
        return "unknown"
    if address.version == 6 and address.ipv4_mapped:
        return str(address.ipv4_mapped)
    if address.version == 6:
        # Treat rotating addresses in the same IPv6 /64 as one source.
        return str(type(address)(int(address) & ((1 << 128) - (1 << 64))))
    return str(address)
