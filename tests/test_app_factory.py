import tempfile
import unittest
from pathlib import Path

APP_FACTORY_IMPORT_ERROR = None

try:
    from webui.app_factory import _list_directories, _resolve_directory_for_browse, _scan_config_from_user
except ModuleNotFoundError as exc:  # pragma: no cover - depends on optional test env deps
    APP_FACTORY_IMPORT_ERROR = exc


@unittest.skipIf(APP_FACTORY_IMPORT_ERROR is not None, "Flask dependency not installed in test environment.")
class DirectoryBrowseTests(unittest.TestCase):
    def test_resolve_existing_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            resolved = _resolve_directory_for_browse(temp_dir)
            self.assertEqual(resolved, Path(temp_dir).resolve())

    def test_resolve_missing_path_falls_back_to_existing_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "new" / "nested" / "path"
            resolved = _resolve_directory_for_browse(str(missing))
            self.assertEqual(resolved, Path(temp_dir).resolve())

    def test_list_directories_returns_only_directories_sorted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "beta").mkdir()
            (root / ".hidden").mkdir()
            (root / "alpha").mkdir()
            (root / "file.txt").write_text("x", encoding="utf-8")

            payload = _list_directories(temp_dir)

            names = [item["name"] for item in payload["directories"]]
            self.assertEqual(names, [".hidden", "alpha", "beta"])
            self.assertEqual(payload["path"], str(root.resolve()))
            self.assertEqual(payload["parent"], str(root.resolve().parent))

    def test_scan_config_removes_rip_specific_fields(self) -> None:
        raw = {
            "device_path": "/dev/sr0",
            "offset": 6,
            "find_drive_offset": True,
            "outputs": ["flac", "mp3"],
            "bitrate": 320,
            "directory_scheme": "{album}",
            "track_scheme": "{track}",
            "log_scheme": "{album}",
            "cue_scheme": "{album}",
            "max_retries": 15,
            "paranoia_level": "max",
            "disable_mb": True,
            "disable_accurip": False,
            "disable_coverart_db": True,
        }

        cfg = _scan_config_from_user(raw)

        self.assertTrue(cfg["print_info_only"])
        self.assertEqual(cfg["device_path"], "/dev/sr0")
        self.assertEqual(cfg["offset"], 6)
        self.assertTrue(cfg["find_drive_offset"])
        self.assertEqual(cfg["outputs"], [])
        self.assertIsNone(cfg["bitrate"])
        self.assertEqual(cfg["directory_scheme"], "")
        self.assertEqual(cfg["track_scheme"], "")
        self.assertEqual(cfg["log_scheme"], "")
        self.assertEqual(cfg["cue_scheme"], "")
        self.assertIsNone(cfg["max_retries"])
        self.assertIsNone(cfg["paranoia_level"])
        self.assertTrue(cfg["disable_mb"])
        self.assertFalse(cfg["disable_accurip"])
        self.assertTrue(cfg["disable_coverart_db"])


if __name__ == "__main__":
    unittest.main()
