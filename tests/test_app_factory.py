import tempfile
import unittest
from pathlib import Path
from unittest import mock

APP_FACTORY_IMPORT_ERROR = None

try:
    from webui.app_factory import (
        create_app,
        _dispatch_ws_rpc,
        _extract_release_candidates,
        _extract_release_options,
        _extract_musicbrainz_submission_url,
        _classify_scan_error,
        _list_directories,
        _resolve_directory_for_browse,
        _runtime_data_root,
        _runtime_default_binary_path,
        _runtime_default_output_dir,
        _resolve_binary_path,
        _manual_cover_from_config,
        _scan_config_from_user,
    )
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
            "coverart_lookup_size": 500,
            "disc_number": 2,
            "total_discs": 3,
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
        self.assertEqual(cfg["coverart_lookup_size"], 500)
        self.assertEqual(cfg["disc_number"], 2)
        self.assertEqual(cfg["total_discs"], 3)

    def test_scan_config_keeps_release_id_for_disambiguation(self) -> None:
        cfg = _scan_config_from_user({"release": "669ea5be-085c-406c-9cd8-4e1107cf0998"})
        self.assertEqual(cfg["release"], "669ea5be-085c-406c-9cd8-4e1107cf0998")

    def test_runtime_default_paths_can_be_overridden_by_appimage_env(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            appimage_dir = Path(temp_dir)
            output_dir = appimage_dir / "output"
            binary = appimage_dir / "usr" / "bin" / "cyanrip"

            with mock.patch.dict(
                "os.environ",
                {
                    "CYANRIP_WEBUI_DEFAULT_OUTPUT_DIR": str(output_dir),
                    "CYANRIP_WEBUI_BUNDLED_CYANRIP": str(binary),
                },
            ):
                data_root = _runtime_data_root()

                self.assertEqual(data_root, appimage_dir)
                self.assertEqual(_runtime_default_output_dir(data_root), output_dir)
                self.assertEqual(_runtime_default_binary_path(), str(binary))

    def test_frozen_source_default_binary_resolves_to_bundled_binary(self) -> None:
        bundled = "/tmp/.mount_cyanrip/usr/bin/cyanrip"

        with mock.patch("webui.app_factory.APP_IS_FROZEN", True), mock.patch(
            "webui.app_factory.DEFAULT_BINARY_PATH",
            bundled,
        ):
            self.assertEqual(_resolve_binary_path("./bin/cyanrip"), bundled)
            self.assertEqual(_resolve_binary_path("bin/cyanrip"), bundled)
            self.assertEqual(_resolve_binary_path("/tmp/.mount_cyanripABC/usr/bin/cyanrip"), bundled)

    def test_extract_release_candidates_from_multi_release_output(self) -> None:
        sample = """
Error: multiple releases were found for this disc id.
Release ID: 669ea5be-085c-406c-9cd8-4e1107cf0998
Release ID: a4124f8f-e8fb-4eb9-9b1f-b38a4f0055fd
"""
        candidates = _extract_release_candidates(sample)
        self.assertEqual(
            candidates,
            [
                "669ea5be-085c-406c-9cd8-4e1107cf0998",
                "a4124f8f-e8fb-4eb9-9b1f-b38a4f0055fd",
            ],
        )

    def test_extract_release_options_from_numbered_release_list(self) -> None:
        sample = """
Multiple releases found in database for DiscID xK0tLeZ7wIoD8OQdqNKITcnSNhE-:
    1 (ID: d495d9cc-272c-4644-be7e-8e58098e6027): Eple (GB) (2001-07-23)
    2 (ID: a2bd9b1c-58c4-3563-bc5d-989df771881f): Eple (XE) (2001)
"""
        options = _extract_release_options(sample)
        self.assertEqual(
            options,
            [
                {
                    "id": "d495d9cc-272c-4644-be7e-8e58098e6027",
                    "label": "Eple (GB) (2001-07-23) (d495d9cc-272c-4644-be7e-8e58098e6027)",
                },
                {
                    "id": "a2bd9b1c-58c4-3563-bc5d-989df771881f",
                    "label": "Eple (XE) (2001) (a2bd9b1c-58c4-3563-bc5d-989df771881f)",
                },
            ],
        )

    def test_extract_musicbrainz_submission_url_from_no_release_output(self) -> None:
        sample = """
Unable to find release info for this CD, and metadata hasn't been manually added!
Please help improve the MusicBrainz DB by submitting the disc info via the following URL:
https://musicbrainz.org/cdtoc/attach?toc=1+2+33892+150+15544&tracks=2&id=5WDBlEEBFuSweSiev4RhZa8VMuw-
To continue add metadata via -a or -t, or ignore via -N!
"""

        url = _extract_musicbrainz_submission_url(sample)
        self.assertEqual(
            url,
            "https://musicbrainz.org/cdtoc/attach?toc=1+2+33892+150+15544&tracks=2&id=5WDBlEEBFuSweSiev4RhZa8VMuw-",
        )
        self.assertEqual(
            _classify_scan_error(
                raw_output=sample,
                release_candidates=[],
                release_options=[],
                musicbrainz_submission_url=url,
            ),
            "no_release_found",
        )

    def test_scan_error_classifier_handles_cyanrip_source_edge_cases(self) -> None:
        cases = {
            "No mediums match DiscID!": "release_selection_invalid",
            "Could not connect to MusicBrainz.": "musicbrainz_lookup_failed",
            "MusicBrainz query failed: temporary failure": "musicbrainz_lookup_failed",
            "Unable to get AccuRIP DB data: missing entry!": "accuraterip_lookup_failed",
            "Unable to get cover art \"Front\": not found!": "cover_art_lookup_failed",
            "Unable to init paranoia!": "device_open_failed",
            "No track was long enough, unable to find drive offset!": "drive_offset_not_found",
        }

        for raw_output, expected in cases.items():
            with self.subTest(raw_output=raw_output):
                self.assertEqual(
                    _classify_scan_error(
                        raw_output=raw_output,
                        release_candidates=[],
                        release_options=[],
                        musicbrainz_submission_url="",
                    ),
                    expected,
                )

    def test_manual_cover_from_config_prefers_explicit_session_payload(self) -> None:
        cover = _manual_cover_from_config(
            {
                "manual_cover": {
                    "source": "/tmp/cyanrip-webui/cover-uploads/manual.png",
                    "sourceType": "upload",
                },
                "cover_arts": [{"destination": "Front", "source": "https://example.com/front.jpg"}],
            }
        )

        self.assertEqual(
            cover,
            {
                "source": "/tmp/cyanrip-webui/cover-uploads/manual.png",
                "sourceType": "upload",
            },
        )

    def test_manual_cover_from_config_falls_back_to_cover_art_entry(self) -> None:
        cover = _manual_cover_from_config(
            {
                "cover_arts": [{"destination": "Front", "source": "https://example.com/front.jpg"}],
            }
        )

        self.assertEqual(
            cover,
            {
                "source": "https://example.com/front.jpg",
                "sourceType": "url",
            },
        )

    def test_websocket_rpc_dispatches_allowed_api_route(self) -> None:
        app = create_app()

        response = _dispatch_ws_rpc(app, {"id": 7, "method": "GET", "url": "/api/settings"})

        self.assertEqual(response["type"], "rpc")
        self.assertEqual(response["id"], 7)
        self.assertTrue(response["ok"])
        self.assertEqual(response["status"], 200)
        self.assertIn("settings", response["body"])

    def test_websocket_rpc_updates_manual_cover_session(self) -> None:
        app = create_app()

        response = _dispatch_ws_rpc(
            app,
            {
                "id": 9,
                "method": "POST",
                "url": "/api/cover/session",
                "body": {
                    "manual_cover": {
                        "source": "/tmp/cyanrip-webui/cover-uploads/manual.png",
                        "sourceType": "upload",
                    },
                },
            },
        )

        self.assertTrue(response["ok"])
        self.assertEqual(
            response["body"]["session"]["manual_cover"],
            {
                "source": "/tmp/cyanrip-webui/cover-uploads/manual.png",
                "sourceType": "upload",
            },
        )

    def test_websocket_rpc_rejects_non_rpc_routes(self) -> None:
        app = create_app()

        response = _dispatch_ws_rpc(app, {"id": 8, "method": "GET", "url": "/api/cover"})

        self.assertFalse(response["ok"])
        self.assertEqual(response["status"], 404)


if __name__ == "__main__":
    unittest.main()
