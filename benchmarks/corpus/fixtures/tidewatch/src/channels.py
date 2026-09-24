"""Destination mapping for current alert transport."""
SLACK_DESTINATIONS = {
    "critical": "#tide-critical",
    "warning": "#tide-warnings",
}


def resolve_channel(channel, severity):
    if channel == "slack":
        return SLACK_DESTINATIONS[severity]
    return "mailbox:operations"
