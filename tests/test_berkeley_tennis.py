import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "berkeley_tennis", Path(__file__).resolve().parents[1] / "scripts/berkeley_tennis.py"
)
tennis = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tennis)


class AvailabilityTests(unittest.TestCase):
    def test_rate_limit_stops_without_immediate_retries(self):
        client = tennis.Client()
        error = urllib.error.HTTPError("https://example.invalid", 429, "Too Many Requests", {}, None)
        with patch.object(client.opener, "open", side_effect=error) as request:
            with self.assertRaisesRegex(RuntimeError, "rate limit"):
                client._req("https://example.invalid")
        self.assertEqual(request.call_count, 1)

    def test_adult_rate_blocked_hours_and_merging(self):
        client = tennis.Client()
        client.key = "test"
        rates = [{"id": 1, "label": "Youth"}, {"id": 2, "label": "Adult", "base_fee": "10"}]

        def hour(start, end, rate="2", blocked=False):
            return {"startDtm": f"2026-10-24 {start}:00", "endDtm": f"2026-10-24 {end}:00",
                    "rateType": {"id": rate}, "block": blocked}

        hours = [hour("17:00", "18:00"), hour("18:00", "19:00"), hour("17:30", "18:30"),
                 hour("19:00", "20:00", blocked=True), hour("20:00", "21:00"),
                 hour("21:00", "22:00", rate=1)]
        with patch.object(client, "items", side_effect=[rates, hours]):
            rate, segments = client.slots("court", "2026-10-24")
        self.assertEqual(rate["id"], 2)
        self.assertEqual([(a.strftime("%H:%M"), b.strftime("%H:%M")) for a, b in segments],
                         [("17:00", "19:00"), ("20:00", "21:00")])

    def test_missing_payload_is_failure_but_empty_hours_is_valid(self):
        client = tennis.Client()
        with patch.object(client, "_req", return_value='{"success": false}'):
            with self.assertRaises(ValueError):
                client.items("path", "hours")
        with patch.object(client, "_req", return_value='{"hours": []}'):
            self.assertEqual(client.items("path", "hours"), [])
        with patch.object(client, "_req", return_value='{"success": false, "hours": []}'):
            with self.assertRaises(ValueError):
                client.items("path", "hours")

    def test_empty_catalog_is_failure(self):
        client = tennis.Client()
        with patch.object(client, "items", return_value=[]):
            with self.assertRaises(ValueError):
                client.parks()
            with self.assertRaises(ValueError):
                client.courts("park")

    def test_checkout_key_in_both_html_encodings(self):
        key = "a" * 32
        for page in ['"checkoutData":{"key":"' + key + '"}',
                     '&quot;checkoutData&quot;:{&quot;key&quot;:&quot;' + key + '&quot;}']:
            client = tennis.Client()
            with patch.object(client, "_req", return_value=page):
                client.start()
            self.assertEqual(client.key, key)

    def test_failure_on_later_court_preserves_previous_snapshot(self):
        class FailingClient:
            def start(self): pass
            def parks(self): return [("park", "Live Oak Park")]
            def courts(self, _): return [("one", "Court 1"), ("two", "Court 2")]
            def slots(self, court, _):
                if court == "two":
                    raise ValueError("upstream failure")
                return None, []

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "availability.json"
            path.write_text('{"previous":true}')
            with self.assertRaises(ValueError):
                tennis.write_snapshot(path, tennis.collect(FailingClient(), ["2026-10-24"]))
            self.assertEqual(json.loads(path.read_text()), {"previous": True})

    def test_snapshot_covers_all_dates_and_preserves_full_windows(self):
        class GoodClient:
            def start(self): pass
            def parks(self): return [(17517, "Live Oak Park")]
            def courts(self, _): return [(68491, "Court 1")]
            def slots(self, _, date):
                return {"base_fee": "10"}, [(dt.datetime.fromisoformat(date + "T07:00"),
                                              dt.datetime.fromisoformat(date + "T22:00"))]

        dates = ["2026-10-24", "2026-10-25", "2026-10-26"]
        snapshot = tennis.collect(GoodClient(), dates)
        self.assertEqual(list(snapshot["dates"]), dates)
        self.assertEqual(snapshot["timezone"], "America/Los_Angeles")
        for parks in snapshot["dates"].values():
            self.assertEqual(parks["Live Oak Park"][0]["slots"], [["07:00", "22:00"]])
            self.assertEqual(parks["Live Oak Park"][0]["park_id"], "17517")
            self.assertEqual(parks["Live Oak Park"][0]["court_id"], "68491")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "nested" / "availability.json"
            tennis.write_snapshot(path, snapshot)
            self.assertEqual(json.loads(path.read_text()), snapshot)


if __name__ == "__main__":
    unittest.main()
