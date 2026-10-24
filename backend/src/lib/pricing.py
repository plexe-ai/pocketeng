"""Hard-coded EC2 + EBS pricing for the workspace Infra tab.

We deliberately keep this static instead of calling the AWS Pricing API:

  - The Pricing API is global (us-east-1 only), slow (~500ms+), and
    returns a 20MB JSON document we'd then have to parse — multiplying
    every GET /servers response by an order of magnitude in latency.
  - Our managed workspaces use a handful of instance types (t3.medium /
    t3.large / m6i.large at most), all in one region today. A small dict
    is exact for the cases we care about and "approximate" for everything
    else.
  - These numbers are user-facing estimates ("~$30/mo"), not invoices.
    The dashboard says "estimate" and so do we.

If we ever onboard a customer that needs an instance type or region we
don't list, the fallback returns None and the UI hides the cost line
(graceful degrade — never lies).
"""
# `X | None` in annotations is 3.10+ syntax. Lambda runs 3.12 so prod is
# fine, but local test collection on Python 3.9 needs PEP 563 to defer
# the evaluation.
from __future__ import annotations


# Linux on-demand hourly prices, USD, us-east-1.
# Source: https://aws.amazon.com/ec2/pricing/on-demand/ (refresh quarterly).
_INSTANCE_HOURLY_USD = {
    "t3.micro":   0.0104,
    "t3.small":   0.0208,
    "t3.medium":  0.0416,
    "t3.large":   0.0832,
    "t3.xlarge":  0.1664,
    "t3a.medium": 0.0376,
    "m6i.large":  0.096,
    "m6i.xlarge": 0.192,
    "c6i.large":  0.085,
    "c6i.xlarge": 0.170,
}

# EBS pricing — per-GB-month for the volume type. gp3 dominates our fleet.
_EBS_GB_MONTH_USD = {
    "gp3":      0.08,
    "gp2":      0.10,
    "io1":      0.125,
    "io2":      0.125,
    "st1":      0.045,
    "sc1":      0.015,
    "standard": 0.05,
}

# Hours per "month" — average 30-day month is close enough for an estimate.
HOURS_PER_MONTH = 730


def estimate_monthly_usd(instance_type: str | None, volumes: list | None) -> float | None:
    """Estimated monthly USD cost at current-state always-on rate.

    Returns None if we can't price the instance type — the UI hides the
    cost line in that case rather than guess. EBS volumes that we can't
    price are silently skipped (compute estimate is still useful).
    """
    if not instance_type:
        return None
    hourly = _INSTANCE_HOURLY_USD.get(instance_type)
    if hourly is None:
        return None
    compute = hourly * HOURS_PER_MONTH

    storage = 0.0
    for vol in volumes or []:
        rate = _EBS_GB_MONTH_USD.get((vol.get("type") or "").lower())
        size = vol.get("sizeGB") or 0
        if rate is not None and size:
            storage += rate * size

    return round(compute + storage, 2)
