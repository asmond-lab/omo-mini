"""Active alert dispatch; the archived prototype is not imported."""
from channels import resolve_channel


def send_alert(region, severity, configured_channel):
    destination = resolve_channel(configured_channel, severity)
    return {"region": region, "destination": destination}


def dispatch_count(events):
    """One delivery per event, regardless of severity."""
    return len(events)
