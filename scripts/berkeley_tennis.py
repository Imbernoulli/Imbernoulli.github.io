#!/usr/bin/env python3
"""Fetch Berkeley municipal tennis availability using only the Python standard library.

python3 scripts/berkeley_tennis.py                     # today + next two days
python3 scripts/berkeley_tennis.py --park 'live oak' --after 17
python3 scripts/berkeley_tennis.py --date 2026-10-31 --json
python3 scripts/berkeley_tennis.py --output /tmp/availability.json
"""

import argparse
import datetime as dt
import html
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

BASE = "https://ca-berkeley.civicrec.com/CA/berkeley-ca/catalog"
CATALOG_HASH = "50900cc08e08223966673cbdc0c1b7e3"
TENNIS_TAB = "7865"
TZ = ZoneInfo("America/Los_Angeles")
BOOK_URL = (
    f"{BASE}/index/{CATALOG_HASH}?filter="
    "c2VhcmNoPVRlbm5pcyUyMGNvdXJ0JnJlbnRhbCU1QmZyb20lNUQ9JnJlbnRhbCU1QnRvJTVEPQ=="
)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36"


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        self.key = None

    def _req(self, url, method="GET", ajax=True):
        headers = {"User-Agent": UA}
        if ajax:
            headers.update({"X-Requested-With": "XMLHttpRequest", "Accept": "application/json"})
        request = urllib.request.Request(
            url, data=b"" if method == "POST" else None, headers=headers, method=method
        )
        for attempt in range(3):
            try:
                with self.opener.open(request, timeout=30) as response:
                    return response.read().decode("utf-8")
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    raise RuntimeError("CivicRec rate limit reached; stopping this update") from None
                if exc.code not in (500, 502, 503, 504) or attempt == 2:
                    # Do not expose a session key in logs via the request URL.
                    raise RuntimeError(f"CivicRec returned HTTP {exc.code}") from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise RuntimeError("Could not reach CivicRec after three attempts") from None
            time.sleep(2 ** (attempt + 1))

    def start(self):
        page = html.unescape(self._req(f"{BASE}/index/{CATALOG_HASH}", ajax=False))
        match = re.search(r'"checkoutData":\s*\{\s*"key":\s*"([0-9a-f]{32})"', page)
        if not match:
            raise ValueError("Checkout key missing; the CivicRec page may have changed")
        self.key = match.group(1)

    def items(self, path, field, method="GET"):
        payload = json.loads(self._req(f"{BASE}/{path}", method=method))
        if not isinstance(payload, dict) or not isinstance(payload.get(field), list):
            raise ValueError(f"CivicRec response is missing the {field} list")
        if payload.get("success") is False or payload.get("error"):
            raise ValueError("CivicRec reported an error")
        return payload[field]

    def parks(self):
        groups = self.items(f"getItems/{self.key}/{TENNIS_TAB}", "groups", "POST")
        if not groups:
            raise ValueError("No tennis parks returned; refusing to publish an empty snapshot")
        return [(group["id"], group["name"]) for group in groups]

    def courts(self, park_id):
        items = self.items(
            f"getLocationFacilities/{self.key}/{TENNIS_TAB}/{park_id}", "items", "POST"
        )
        if not items:
            raise ValueError("No courts returned for a park; refusing an incomplete snapshot")
        return [(item["id"], item["text"]) for item in items]

    def slots(self, court_id, date):
        rates = self.items(f"getFacilityRates/{self.key}/{court_id}/{date}", "rates")
        if not rates:
            return None, []
        rate = next((rate for rate in rates if "adult" in rate["label"].lower()), rates[0])
        hours = self.items(
            f"getFacilityHours/{self.key}/{court_id}/{rate['id']}/{date}", "hours"
        )
        segments = set()
        other_dates = set()
        for hour in hours:
            if str(hour.get("rateType", {}).get("id")) != str(rate["id"]) or hour.get("block"):
                continue
            start = dt.datetime.fromisoformat(hour["startDtm"])
            end = dt.datetime.fromisoformat(hour["endDtm"])
            if end < start:
                raise ValueError(
                    f"CivicRec returned a reversed interval for court {court_id}, {date}: "
                    f"{start.isoformat()} to {end.isoformat()}"
                )
            if end == start:
                continue
            # CivicRec can roll an exhausted date forward to another day. Only
            # retain hours belonging to the requested date, never relabel them.
            if start.date().isoformat() != date or end.date() != start.date():
                other_dates.add(f"{start.date()}/{end.date()}")
                continue
            segments.add((start, end))
        if other_dates:
            print(
                f"CivicRec court {court_id}, requested {date}: ignored hours on "
                + ", ".join(sorted(other_dates)), file=sys.stderr
            )
        merged = []
        for start, end in sorted(segments):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        return rate, merged


def collect(client, dates, park_keywords=None):
    """Build a complete snapshot. Any upstream failure leaves the previous one intact."""
    started = dt.datetime.now(TZ)
    client.start()
    parks = client.parks()
    if park_keywords:
        parks = [park for park in parks if any(k.lower() in park[1].lower() for k in park_keywords)]
        if not parks:
            raise ValueError("No parks matched the supplied keywords")
    result = {date: {} for date in dates}
    for park_id, park_name in parks:
        for court_id, court_name in client.courts(park_id):
            for date in dates:
                rate, segments = client.slots(court_id, date)
                result[date].setdefault(park_name, []).append({
                    "court": court_name,
                    "court_id": str(court_id),
                    "park_id": str(park_id),
                    "fee": rate.get("base_fee") if rate else None,
                    "slots": [[start.strftime("%H:%M"), end.strftime("%H:%M")] for start, end in segments],
                })
    return {
        "schema_version": 1,
        "timezone": TZ.key,
        "query_started_at": started.isoformat(timespec="seconds"),
        "generated_at": dt.datetime.now(TZ).isoformat(timespec="seconds"),
        "booking_url": BOOK_URL,
        "dates": result,
    }


def write_snapshot(path, snapshot):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            json.dump(snapshot, file, ensure_ascii=False, indent=2)
            file.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=3)
    parser.add_argument("--date", action="append", help="YYYY-MM-DD; repeat for multiple dates")
    parser.add_argument("--park", action="append", help="Park name keyword; repeat to include more parks")
    parser.add_argument("--after", type=float, help="CLI display only: earliest hour, e.g. 17 or 17.5")
    parser.add_argument("--json", action="store_true", help="Print the complete snapshot as JSON")
    parser.add_argument("--output", help="Atomically save a complete, unfiltered JSON snapshot")
    args = parser.parse_args()
    if not 1 <= args.days <= 14:
        parser.error("--days must be between 1 and 14")
    if args.after is not None and not 0 <= args.after < 24:
        parser.error("--after must be between 0 and 24 (exclusive)")
    now = dt.datetime.now(TZ)
    try:
        dates = list(dict.fromkeys(
            [dt.date.fromisoformat(date).isoformat() for date in args.date] if args.date else
            [(now.date() + dt.timedelta(days=i)).isoformat() for i in range(args.days)]
        ))
    except ValueError:
        parser.error("--date must be a valid date in YYYY-MM-DD format")
    try:
        snapshot = collect(Client(), dates, args.park)
        if args.output:
            write_snapshot(args.output, snapshot)
        if args.json:
            print(json.dumps(snapshot, ensure_ascii=False, indent=2))
        elif not args.output:
            for date, parks in snapshot["dates"].items():
                print(f"\n===== {date} =====")
                found = False
                cutoff = args.after * 60 if args.after is not None else 0
                if date == now.date().isoformat():
                    cutoff = max(cutoff, now.hour * 60 + now.minute + bool(now.second or now.microsecond))
                for park, courts in parks.items():
                    lines = []
                    for court in courts:
                        slots = []
                        for start, end in court["slots"]:
                            a, b = [int(t[:2]) * 60 + int(t[3:]) for t in (start, end)]
                            if date >= now.date().isoformat() and b > max(a, cutoff):
                                a = max(a, cutoff)
                                slots.append(f"{int(a // 60):02d}:{int(a % 60):02d}–{end}")
                        if slots:
                            lines.append(f"    {court['court']}: {', '.join(slots)}")
                    if lines:
                        found = True
                        print(f"  {park}\n" + "\n".join(lines))
                if not found:
                    print("  No available times")
            print(f"\nBook: {BOOK_URL}\nChecked: {snapshot['generated_at']}")
    except (ValueError, KeyError, TypeError, OSError, RuntimeError) as exc:
        print(f"Availability update failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
