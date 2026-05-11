import unittest

from webui.scan_parser import parse_scan_output


class ScanParserTests(unittest.TestCase):
    def test_parse_scan_output_track_metadata(self) -> None:
        raw = """
cyanrip 0.9.3 (release)
Album:          Demo Album
Album artist:   Demo Artist
Disc tracks:    2
AccurateRip:    found
Total time:     00:08:11.000

Tracks:
Track 1 info:
Summary:
  Properties:
    Duration:    00:04:01.000

  Accurip:       disc found in database (max confidence: 12)
    Accurip v2:  1234ABCD (accurately ripped, confidence 12)

  Metadata:
    title:       Intro
    artist:      The Band

Track 2 info:
Summary:
  Properties:
    Duration:    00:04:10.000

  Metadata:
    title:       Main Track
    artist:      The Band
""".strip()

        parsed = parse_scan_output(raw)
        self.assertEqual(parsed["disc"].get("album"), "Demo Album")
        self.assertEqual(parsed["disc"].get("album_artist"), "Demo Artist")
        self.assertEqual(len(parsed["tracks"]), 2)

        track1 = parsed["tracks"][0]
        self.assertEqual(track1["number"], 1)
        self.assertEqual(track1["title"], "Intro")
        self.assertEqual(track1["artist"], "The Band")
        self.assertEqual(track1["duration"], "00:04:01.000")
        self.assertEqual(track1["accurip_confidence"], 12)
        self.assertEqual(track1["accurip_max_confidence"], 12)
        self.assertEqual(track1["accurip"], "12/12")

    def test_parse_rip_completion_status(self) -> None:
        raw = """
Track 1 ripped and encoded successfully!
Summary:
  Accurip:       disc found in database (max confidence: 7)
    Accurip v2:  063A1EFC (accurately ripped, confidence 7)
""".strip()

        parsed = parse_scan_output(raw)
        self.assertEqual(len(parsed["tracks"]), 1)

        track = parsed["tracks"][0]
        self.assertEqual(track["status"], "done")
        self.assertEqual(track["progress"], 100.0)
        self.assertEqual(track["accurip_confidence"], 7)
        self.assertEqual(track["accurip_max_confidence"], 7)
        self.assertEqual(track["accurip"], "7/7")

    def test_accurip_v1_confidence_can_exceed_v2_max_confidence(self) -> None:
        raw = """
Track 1 ripped and encoded successfully!
Summary:
  AccurateRip:   disc found in database (max confidence: 2)
    AccurateRip v1:  A1B2C3D4 (accurately ripped, confidence 12)
    AccurateRip v2:  not found
""".strip()

        parsed = parse_scan_output(raw)
        track = parsed["tracks"][0]

        self.assertEqual(track["accurip_confidence"], 12)
        self.assertEqual(track["accurip_max_confidence"], 12)
        self.assertEqual(track["accurip"], "12/12")


if __name__ == "__main__":
    unittest.main()
