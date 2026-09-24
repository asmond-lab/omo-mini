"""Active storage policy."""
SNAPSHOT_DIRECTORY = "data/snapshots"
RETENTION_DAYS = 14


def snapshot_path(station_id, day):
    return f"{SNAPSHOT_DIRECTORY}/{station_id}/{day}.json"


def is_expired(age_days):
    return age_days > RETENTION_DAYS
