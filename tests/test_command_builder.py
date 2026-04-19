import unittest

from webui.command_builder import CommandBuilder, CommandBuilderError


class CommandBuilderTests(unittest.TestCase):
    def test_build_full_command(self) -> None:
        config = {
            "device_path": "/dev/sr1",
            "offset": -6,
            "max_retries": 9,
            "ripping_retries": 2,
            "speed": 4,
            "paranoia_level": "none",
            "pregap_rules": [
                {"track": 2, "action": "merge"},
                {"track": 5, "action": "track"},
            ],
            "overread_leadinout": True,
            "decode_hdcd": True,
            "force_deemphasis": True,
            "disable_deemphasis": True,
            "disable_replaygain": True,
            "outputs": ["flac", "mp3"],
            "bitrate": 320,
            "directory_scheme": "{album} [{format}]",
            "track_scheme": "{track} - {title}",
            "log_scheme": "{album}",
            "cue_scheme": "{album}",
            "track_selection": [3, 1],
            "sanitation": "os_simple",
            "print_info_only": True,
            "album_metadata": "album=Album:album_artist=Artist",
            "track_metadata": [
                {"track": 1, "metadata": "title=Intro"},
                {"track": 2, "metadata": "title=Song:artist=Band"},
            ],
            "release": "2",
            "disc_number": 1,
            "total_discs": 2,
            "cover_arts": [
                {"destination": "Front", "source": "/tmp/cover.jpg"},
                {"source": "https://example.com/back.jpg"},
            ],
            "disable_mb": True,
            "disable_accurip": True,
            "disable_coverart_db": True,
            "coverart_lookup_size": 500,
            "disable_coverart_embedding": True,
            "eject_on_success": True,
            "find_drive_offset": True,
            "print_version": True,
            "show_help": True,
        }

        result = CommandBuilder.build("/opt/cyanrip", config).argv
        self.assertEqual(
            result,
            [
                "/opt/cyanrip",
                "-d",
                "/dev/sr1",
                "-s",
                "-6",
                "-r",
                "9",
                "-Z",
                "2",
                "-S",
                "4",
                "-P",
                "none",
                "-p",
                "2=merge",
                "-p",
                "5=track",
                "-O",
                "-H",
                "-E",
                "-W",
                "-K",
                "-o",
                "flac,mp3",
                "-b",
                "320",
                "-D",
                "{album} [{format}]",
                "-F",
                "{track} - {title}",
                "-L",
                "{album}",
                "-M",
                "{album}",
                "-l",
                "1,3",
                "-T",
                "os_simple",
                "-I",
                "-a",
                "album=Album:album_artist=Artist",
                "-t",
                "1=title=Intro",
                "-t",
                "2=title=Song:artist=Band",
                "-R",
                "2",
                "-c",
                "1/2",
                "-C",
                "Front=/tmp/cover.jpg",
                "-C",
                "https://example.com/back.jpg",
                "-N",
                "-A",
                "-U",
                "-m",
                "500",
                "-G",
                "-Q",
                "-f",
                "-V",
                "-h",
            ],
        )

    def test_invalid_output_raises(self) -> None:
        with self.assertRaises(CommandBuilderError):
            CommandBuilder.build("/opt/cyanrip", {"outputs": ["flac", "broken"]})

    def test_total_discs_without_disc_raises(self) -> None:
        with self.assertRaises(CommandBuilderError):
            CommandBuilder.build("/opt/cyanrip", {"total_discs": 2})

    def test_shell_quoting(self) -> None:
        result = CommandBuilder.build(
            "/opt/my cyanrip",
            {"album_metadata": "album=My Album", "show_help": True},
        )
        self.assertIn("'/opt/my cyanrip'", result.shell)
        self.assertIn("-h", result.shell)


if __name__ == "__main__":
    unittest.main()
