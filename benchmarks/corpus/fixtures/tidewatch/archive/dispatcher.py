"""Retired prototype dispatch; not the active scheduler target."""


def dispatch_count(events):
    """The prototype batched all events as one delivery."""
    return 1 if events else 0

LEGACY_ROUTE = "mailbox:prototype"
