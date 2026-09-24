"""HTTP route table (method, path, required role)."""
ROUTES = [
    ("GET", "/health", "public"),
    ("GET", "/stations", "viewer"),
    ("GET", "/stations/summary", "analyst"),
    ("POST", "/stations/export", "operator"),
]


def required_role(path):
    return next(role for method, route, role in ROUTES if route == path)
