from __future__ import annotations

import shlex
from dataclasses import dataclass
from typing import Any, Iterable

SUPPORTED_OUTPUTS = [
    "flac",
    "tta",
    "opus",
    "aac",
    "wavpack",
    "alac",
    "mp3",
    "vorbis",
    "wav",
    "aac_mp4",
    "opus_mp4",
    "pcm",
]

SANITATION_MODES = ["simple", "os_simple", "unicode", "os_unicode"]
PREGAP_ACTIONS = ["default", "drop", "merge", "track"]
COVERART_LOOKUP_SIZES = [-1, 250, 500, 1200]

DEFAULT_CONFIG: dict[str, Any] = {
    "device_path": "",
    "offset": 0,
    "max_retries": 10,
    "ripping_retries": None,
    "speed": None,
    "pregap_rules": [],
    "paranoia_level": "max",
    "overread_leadinout": False,
    "decode_hdcd": False,
    "force_deemphasis": False,
    "disable_deemphasis": False,
    "disable_replaygain": True,
    "outputs": ["flac"],
    "bitrate": 256,
    "directory_scheme": "{album}{if #releasecomment# > #0# (|releasecomment|)} [{format}]",
    "track_scheme": "{if #totaldiscs# > #1#|disc|.}{track} - {title}",
    "log_scheme": "{album}{if #totaldiscs# > #1# CD|disc|}",
    "cue_scheme": "{album}{if #totaldiscs# > #1# CD|disc|}",
    "track_selection": [],
    "sanitation": "unicode",
    "print_info_only": False,
    "album_metadata": "",
    "track_metadata": [],
    "release": "",
    "disc_number": None,
    "total_discs": None,
    "cover_arts": [],
    "disable_mb": False,
    "disable_accurip": False,
    "disable_coverart_db": False,
    "coverart_lookup_size": -1,
    "disable_coverart_embedding": False,
    "eject_on_success": False,
    "find_drive_offset": False,
    "print_version": False,
    "show_help": False,
}


class CommandBuilderError(ValueError):
    """Raised when UI input cannot be converted into a valid cyanrip command."""


@dataclass(slots=True)
class BuildResult:
    argv: list[str]

    @property
    def shell(self) -> str:
        return " ".join(shlex.quote(part) for part in self.argv)


class CommandBuilder:
    @staticmethod
    def build(binary_path: str, config: dict[str, Any] | None) -> BuildResult:
        binary = (binary_path or "").strip()
        if not binary:
            raise CommandBuilderError("Path to cyanrip binary is missing.")

        data: dict[str, Any] = dict(DEFAULT_CONFIG)
        if config:
            data.update(config)

        cmd: list[str] = [binary]

        CommandBuilder._append_string(cmd, "-d", data.get("device_path"))

        offset = CommandBuilder._parse_int(data.get("offset"), "Offset", allow_empty=True)
        if offset is not None:
            cmd.extend(["-s", str(offset)])

        max_retries = CommandBuilder._parse_int(
            data.get("max_retries"), "Max retries", minimum=0, allow_empty=True
        )
        if max_retries is not None:
            cmd.extend(["-r", str(max_retries)])

        ripping_retries = CommandBuilder._parse_int(
            data.get("ripping_retries"), "Ripping retries (-Z)", minimum=0, allow_empty=True
        )
        if ripping_retries is not None:
            cmd.extend(["-Z", str(ripping_retries)])

        speed = CommandBuilder._parse_int(data.get("speed"), "Drive speed", minimum=0, allow_empty=True)
        if speed is not None:
            cmd.extend(["-S", str(speed)])

        paranoia = CommandBuilder._parse_paranoia(data.get("paranoia_level"))
        if paranoia is not None:
            cmd.extend(["-P", paranoia])

        for pregap in CommandBuilder._parse_pregap_rules(data.get("pregap_rules")):
            cmd.extend(["-p", pregap])

        CommandBuilder._append_bool_flag(cmd, "-O", data.get("overread_leadinout"))
        CommandBuilder._append_bool_flag(cmd, "-H", data.get("decode_hdcd"))
        CommandBuilder._append_bool_flag(cmd, "-E", data.get("force_deemphasis"))
        CommandBuilder._append_bool_flag(cmd, "-W", data.get("disable_deemphasis"))
        CommandBuilder._append_bool_flag(cmd, "-K", data.get("disable_replaygain"))

        outputs = CommandBuilder._parse_outputs(data.get("outputs"))
        if outputs:
            cmd.extend(["-o", ",".join(outputs)])

        bitrate = CommandBuilder._parse_float(data.get("bitrate"), "Bitrate", minimum=1, allow_empty=True)
        if bitrate is not None:
            if bitrate.is_integer():
                cmd.extend(["-b", str(int(bitrate))])
            else:
                cmd.extend(["-b", str(bitrate)])

        CommandBuilder._append_string(cmd, "-D", data.get("directory_scheme"))
        CommandBuilder._append_string(cmd, "-F", data.get("track_scheme"))
        CommandBuilder._append_string(cmd, "-L", data.get("log_scheme"))
        CommandBuilder._append_string(cmd, "-M", data.get("cue_scheme"))

        track_selection = CommandBuilder._parse_track_list(data.get("track_selection"))
        if track_selection:
            cmd.extend(["-l", ",".join(str(idx) for idx in track_selection)])

        sanitation = CommandBuilder._parse_string(data.get("sanitation"), "Sanitation", allow_empty=True)
        if sanitation:
            if sanitation not in SANITATION_MODES:
                raise CommandBuilderError(
                    f"Invalid sanitation mode: {sanitation}. Allowed: {', '.join(SANITATION_MODES)}"
                )
            cmd.extend(["-T", sanitation])

        CommandBuilder._append_bool_flag(cmd, "-I", data.get("print_info_only"))
        CommandBuilder._append_string(cmd, "-a", data.get("album_metadata"))

        for track_meta in CommandBuilder._parse_track_metadata(data.get("track_metadata")):
            cmd.extend(["-t", track_meta])

        CommandBuilder._append_string(cmd, "-R", data.get("release"))

        disc_flag = CommandBuilder._parse_disc_flag(data.get("disc_number"), data.get("total_discs"))
        if disc_flag:
            cmd.extend(["-c", disc_flag])

        for cover_art in CommandBuilder._parse_cover_arts(data.get("cover_arts")):
            cmd.extend(["-C", cover_art])

        CommandBuilder._append_bool_flag(cmd, "-N", data.get("disable_mb"))
        CommandBuilder._append_bool_flag(cmd, "-A", data.get("disable_accurip"))
        CommandBuilder._append_bool_flag(cmd, "-U", data.get("disable_coverart_db"))

        coverart_size = CommandBuilder._parse_int(
            data.get("coverart_lookup_size"), "Coverart max size", allow_empty=True
        )
        if coverart_size is not None:
            if coverart_size not in COVERART_LOOKUP_SIZES:
                raise CommandBuilderError(
                    f"Invalid cover art size: {coverart_size}. Allowed: {', '.join(str(v) for v in COVERART_LOOKUP_SIZES)}"
                )
            cmd.extend(["-m", str(coverart_size)])

        CommandBuilder._append_bool_flag(cmd, "-G", data.get("disable_coverart_embedding"))

        CommandBuilder._append_bool_flag(cmd, "-Q", data.get("eject_on_success"))
        CommandBuilder._append_bool_flag(cmd, "-f", data.get("find_drive_offset"))
        CommandBuilder._append_bool_flag(cmd, "-V", data.get("print_version"))
        CommandBuilder._append_bool_flag(cmd, "-h", data.get("show_help"))

        return BuildResult(argv=cmd)

    @staticmethod
    def _append_bool_flag(cmd: list[str], flag: str, enabled: Any) -> None:
        if bool(enabled):
            cmd.append(flag)

    @staticmethod
    def _append_string(cmd: list[str], flag: str, value: Any) -> None:
        parsed = CommandBuilder._parse_string(value, flag, allow_empty=True)
        if parsed:
            cmd.extend([flag, parsed])

    @staticmethod
    def _parse_string(value: Any, field: str, allow_empty: bool = False) -> str | None:
        if value is None:
            return None
        parsed = str(value).strip()
        if not parsed:
            if allow_empty:
                return None
            raise CommandBuilderError(f"{field} must not be empty.")
        return parsed

    @staticmethod
    def _parse_int(
        value: Any,
        field: str,
        minimum: int | None = None,
        maximum: int | None = None,
        allow_empty: bool = False,
    ) -> int | None:
        if value is None or value == "":
            if allow_empty:
                return None
            raise CommandBuilderError(f"{field} is missing.")
        try:
            parsed = int(str(value).strip())
        except (TypeError, ValueError) as exc:
            raise CommandBuilderError(f"{field} must be an integer.") from exc

        if minimum is not None and parsed < minimum:
            raise CommandBuilderError(f"{field} must be >= {minimum}.")
        if maximum is not None and parsed > maximum:
            raise CommandBuilderError(f"{field} must be <= {maximum}.")

        return parsed

    @staticmethod
    def _parse_float(
        value: Any,
        field: str,
        minimum: float | None = None,
        maximum: float | None = None,
        allow_empty: bool = False,
    ) -> float | None:
        if value is None or value == "":
            if allow_empty:
                return None
            raise CommandBuilderError(f"{field} is missing.")
        try:
            parsed = float(str(value).strip())
        except (TypeError, ValueError) as exc:
            raise CommandBuilderError(f"{field} must be numeric.") from exc

        if minimum is not None and parsed < minimum:
            raise CommandBuilderError(f"{field} must be >= {minimum}.")
        if maximum is not None and parsed > maximum:
            raise CommandBuilderError(f"{field} must be <= {maximum}.")

        return parsed

    @staticmethod
    def _parse_outputs(value: Any) -> list[str]:
        if value is None:
            return []

        if isinstance(value, str):
            raw = [part.strip() for part in value.split(",")]
        elif isinstance(value, Iterable):
            raw = [str(part).strip() for part in value]
        else:
            raise CommandBuilderError("Output formats must be a list or CSV string.")

        outputs = [part for part in raw if part]
        if not outputs:
            return []

        seen: set[str] = set()
        for output in outputs:
            if output not in SUPPORTED_OUTPUTS:
                raise CommandBuilderError(
                    f"Invalid output format: {output}. Allowed: {', '.join(SUPPORTED_OUTPUTS)}"
                )
            if output in seen:
                raise CommandBuilderError(f"Output format is duplicated: {output}")
            seen.add(output)

        return outputs

    @staticmethod
    def _parse_track_list(value: Any) -> list[int]:
        if value is None or value == "":
            return []

        if isinstance(value, str):
            raw = [part.strip() for part in value.split(",")]
        elif isinstance(value, Iterable):
            raw = [str(part).strip() for part in value]
        else:
            raise CommandBuilderError("Track list must be a list or CSV string.")

        tracks: list[int] = []
        seen: set[int] = set()
        for part in raw:
            if not part:
                continue
            idx = CommandBuilder._parse_int(part, "Track number", minimum=1, maximum=197)
            assert idx is not None
            if idx in seen:
                raise CommandBuilderError(f"Track number is duplicated: {idx}")
            seen.add(idx)
            tracks.append(idx)

        return sorted(tracks)

    @staticmethod
    def _parse_pregap_rules(value: Any) -> list[str]:
        if value in (None, ""):
            return []
        if not isinstance(value, Iterable) or isinstance(value, (str, bytes)):
            raise CommandBuilderError("Pregap rules must be a list.")

        rules: list[str] = []
        for idx, item in enumerate(value, start=1):
            if not isinstance(item, dict):
                raise CommandBuilderError(f"Pregap rule #{idx} has an invalid format.")
            track = CommandBuilder._parse_int(item.get("track"), f"Pregap rule #{idx} track", minimum=1, maximum=197)
            action = CommandBuilder._parse_string(item.get("action"), f"Pregap rule #{idx} action")
            assert track is not None and action is not None

            if action not in PREGAP_ACTIONS:
                raise CommandBuilderError(
                    f"Invalid pregap action in rule #{idx}: {action}. Allowed: {', '.join(PREGAP_ACTIONS)}"
                )

            rules.append(f"{track}={action}")

        return rules

    @staticmethod
    def _parse_track_metadata(value: Any) -> list[str]:
        if value in (None, ""):
            return []
        if not isinstance(value, Iterable) or isinstance(value, (str, bytes)):
            raise CommandBuilderError("Track metadata must be a list.")

        args: list[str] = []
        for idx, item in enumerate(value, start=1):
            if not isinstance(item, dict):
                raise CommandBuilderError(f"Track metadata #{idx} has an invalid format.")

            track = CommandBuilder._parse_int(item.get("track"), f"Track metadata #{idx} track", minimum=1, maximum=197)
            payload = CommandBuilder._parse_string(item.get("metadata"), f"Track metadata #{idx} data")
            assert track is not None and payload is not None

            args.append(f"{track}={payload}")

        return args

    @staticmethod
    def _parse_disc_flag(disc_number: Any, total_discs: Any) -> str | None:
        disc = CommandBuilder._parse_int(disc_number, "Disc number", minimum=1, allow_empty=True)
        total = CommandBuilder._parse_int(total_discs, "Total discs", minimum=1, allow_empty=True)

        if disc is None and total is None:
            return None
        if disc is None:
            raise CommandBuilderError("Disc number must be set when total discs is set.")
        if total is not None and disc > total:
            raise CommandBuilderError("Disc number must not be greater than total discs.")

        if total is None:
            return str(disc)
        return f"{disc}/{total}"

    @staticmethod
    def _parse_cover_arts(value: Any) -> list[str]:
        if value in (None, ""):
            return []
        if not isinstance(value, Iterable) or isinstance(value, (str, bytes)):
            raise CommandBuilderError("Cover art entries must be a list.")

        args: list[str] = []
        for idx, item in enumerate(value, start=1):
            if not isinstance(item, dict):
                raise CommandBuilderError(f"Cover art entry #{idx} has an invalid format.")

            source = CommandBuilder._parse_string(item.get("source"), f"Cover art #{idx} source")
            destination = CommandBuilder._parse_string(
                item.get("destination"), f"Cover art #{idx} destination", allow_empty=True
            )
            assert source is not None
            args.append(f"{destination}={source}" if destination else source)

        return args

    @staticmethod
    def _parse_paranoia(value: Any) -> str | None:
        parsed = CommandBuilder._parse_string(value, "Paranoia level", allow_empty=True)
        if not parsed:
            return None

        if parsed in {"none", "max"}:
            return parsed

        parsed_int = CommandBuilder._parse_int(parsed, "Paranoia level", minimum=0)
        assert parsed_int is not None
        return str(parsed_int)
