import os
import unittest

from webui.runner import CyanripJobRunner


class RunnerStateTests(unittest.TestCase):
    def test_scan_result_is_persisted_in_snapshot(self) -> None:
        runner = CyanripJobRunner()
        runner.update_scan_result(
            {
                "album": "Demo Album",
                "album_artist": "Demo Artist",
                "disc_tracks": "2",
            },
            [
                {
                    "number": 1,
                    "title": "Intro",
                    "artist": "The Band",
                    "duration": "00:01:22.000",
                    "status": "detected",
                    "progress": 0,
                    "accurip_text": "",
                    "accurip_confidence": None,
                    "accurip_max_confidence": None,
                },
                {
                    "number": 2,
                    "title": "Main",
                    "artist": "The Band",
                    "duration": "00:03:10.000",
                    "status": "detected",
                    "progress": 0,
                    "accurip_text": "",
                    "accurip_confidence": None,
                    "accurip_max_confidence": None,
                },
            ],
            returncode=0,
        )

        snap = runner.snapshot()
        self.assertTrue(snap["scan"]["last_success"])
        self.assertEqual(snap["disc"]["info"]["album"], "Demo Album")
        self.assertEqual(len(snap["disc"]["tracks"]), 2)
        self.assertEqual(len(snap["rip"]["tracks"]), 2)
        self.assertEqual(snap["rip"]["total_tracks"], 2)

    def test_runtime_signals_update_track_snapshot(self) -> None:
        runner = CyanripJobRunner()
        runner.update_scan_result(
            {},
            [
                {
                    "number": 1,
                    "title": "Track 01",
                    "artist": "",
                    "duration": "",
                    "status": "detected",
                    "progress": 0,
                    "accurip_text": "",
                    "accurip_confidence": None,
                    "accurip_max_confidence": None,
                }
            ],
            returncode=0,
        )

        runner._append_log("Tracks to rip: 1")
        runner._append_log("Track 1 info:")
        runner._append_log("title: Intro")
        runner._append_log("artist: The Band")
        runner._append_log("Duration: 00:04:01.000")
        runner._append_log("Ripping and encoding track 1, progress - 37.5%, ETA - 00:03:10, errors - 0")
        runner._append_log("Track 1 ripped and encoded successfully!")

        snap = runner.snapshot()
        self.assertEqual(snap["rip"]["current_track_no"], 1)
        self.assertEqual(snap["rip"]["eta"], "00:03:10")

        track = snap["rip"]["tracks"][0]
        self.assertEqual(track["title"], "Intro")
        self.assertEqual(track["artist"], "The Band")
        self.assertEqual(track["duration"], "00:04:01.000")
        self.assertEqual(track["status"], "done")
        self.assertEqual(track["progress"], 100.0)

    def test_runtime_accurip_v1_confidence_overrides_lower_max_confidence(self) -> None:
        runner = CyanripJobRunner()
        runner.update_scan_result(
            {},
            [
                {
                    "number": 1,
                    "title": "Track 01",
                    "artist": "",
                    "duration": "",
                    "status": "detected",
                    "progress": 0,
                    "accurip_text": "",
                    "accurip_confidence": None,
                    "accurip_max_confidence": 2,
                }
            ],
            returncode=0,
        )

        runner._append_log("Track 1 ripped and encoded successfully!")
        runner._append_log("AccurateRip: disc found in database (max confidence: 2)")
        runner._append_log("AccurateRip v1: A1B2C3D4 (accurately ripped, confidence 12)")
        runner._append_log("AccurateRip v2: not found")

        track = runner.snapshot()["rip"]["tracks"][0]
        self.assertEqual(track["accurip_confidence"], 12)
        self.assertEqual(track["accurip_max_confidence"], 12)
        self.assertEqual(track["accurip"], "12/12")

    def test_failed_scan_state_is_persisted(self) -> None:
        runner = CyanripJobRunner()
        runner.update_scan_result({}, [], returncode=22, error="scan failed")

        snap = runner.snapshot()
        self.assertFalse(snap["scan"]["last_success"])
        self.assertEqual(snap["scan"]["last_returncode"], 22)
        self.assertEqual(snap["scan"]["last_error"], "scan failed")

    def test_process_env_keeps_system_tmp_variables(self) -> None:
        runner = CyanripJobRunner()
        env = runner._build_process_env()

        self.assertEqual(env.get("TMPDIR"), os.environ.get("TMPDIR"))
        self.assertEqual(env.get("TMP"), os.environ.get("TMP"))
        self.assertEqual(env.get("TEMP"), os.environ.get("TEMP"))


if __name__ == "__main__":
    unittest.main()
