from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class LogLine:
    index: int
    line: str


class CyanripJobRunner:
    def __init__(self, max_log_lines: int = 4000) -> None:
        self._lock = threading.RLock()
        self._max_log_lines = max_log_lines

        self._state = "idle"
        self._job_id: str | None = None
        self._command: list[str] = []
        self._shell_command = ""
        self._working_directory: str | None = None
        self._started_at: float | None = None
        self._finished_at: float | None = None
        self._returncode: int | None = None

        self._process: subprocess.Popen[str] | None = None
        self._reader_thread: threading.Thread | None = None
        self._stop_requested = False

        self._next_log_index = 0
        self._logs: deque[LogLine] = deque(maxlen=max_log_lines)

    def start(self, command: list[str], shell_command: str, working_directory: str | None = None) -> dict[str, Any]:
        if not command:
            raise ValueError("Command must not be empty")

        cwd = self._resolve_workdir(working_directory)

        with self._lock:
            if self._state == "running":
                raise RuntimeError("Es laeuft bereits ein cyanrip-Prozess.")

            self._reset_for_new_job(command, shell_command, cwd)

            try:
                self._process = subprocess.Popen(
                    command,
                    cwd=cwd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    universal_newlines=True,
                    env=os.environ.copy(),
                )
            except FileNotFoundError as exc:
                self._state = "failed"
                self._finished_at = time.time()
                self._append_log(f"Fehler: Binary nicht gefunden ({command[0]})")
                raise FileNotFoundError(f"Binary nicht gefunden: {command[0]}") from exc
            except OSError as exc:
                self._state = "failed"
                self._finished_at = time.time()
                self._append_log(f"Fehler beim Starten: {exc}")
                raise

            self._reader_thread = threading.Thread(target=self._stream_output, daemon=True)
            self._reader_thread.start()

            return self.snapshot()

    def stop(self) -> dict[str, Any]:
        proc: subprocess.Popen[str] | None = None
        with self._lock:
            if self._state != "running" or self._process is None:
                return self.snapshot()
            self._stop_requested = True
            proc = self._process
            self._append_log("Stop angefordert: versuche cyanrip sauber zu beenden...")

        assert proc is not None
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            oldest_idx = self._logs[0].index if self._logs else self._next_log_index
            return {
                "job_id": self._job_id,
                "state": self._state,
                "is_running": self._state == "running",
                "command": list(self._command),
                "shell_command": self._shell_command,
                "working_directory": self._working_directory,
                "started_at": self._iso(self._started_at),
                "finished_at": self._iso(self._finished_at),
                "returncode": self._returncode,
                "log_next_index": self._next_log_index,
                "log_oldest_index": oldest_idx,
                "log_buffer_size": len(self._logs),
            }

    def logs(self, since: int | None = None) -> dict[str, Any]:
        with self._lock:
            oldest_idx = self._logs[0].index if self._logs else self._next_log_index
            if since is None:
                since_idx = oldest_idx
            else:
                since_idx = max(since, oldest_idx)

            lines = [
                {"index": line.index, "line": line.line}
                for line in self._logs
                if line.index >= since_idx
            ]

            return {
                "lines": lines,
                "next_index": self._next_log_index,
                "oldest_index": oldest_idx,
            }

    def _reset_for_new_job(self, command: list[str], shell_command: str, cwd: str) -> None:
        self._state = "running"
        self._job_id = uuid.uuid4().hex[:12]
        self._command = list(command)
        self._shell_command = shell_command
        self._working_directory = cwd
        self._started_at = time.time()
        self._finished_at = None
        self._returncode = None
        self._process = None
        self._reader_thread = None
        self._stop_requested = False
        self._next_log_index = 0
        self._logs.clear()

        self._append_log(f"Job {self._job_id} gestartet")
        self._append_log(f"Arbeitsverzeichnis: {cwd}")
        self._append_log(f"Command: {shell_command}")

    def _append_log(self, line: str) -> None:
        normalized = line.rstrip("\n")
        self._logs.append(LogLine(index=self._next_log_index, line=normalized))
        self._next_log_index += 1

    def _stream_output(self) -> None:
        proc: subprocess.Popen[str] | None = None
        with self._lock:
            proc = self._process

        if proc is None:
            return

        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                with self._lock:
                    self._append_log(line)
        finally:
            returncode = proc.wait()
            with self._lock:
                self._returncode = returncode
                self._finished_at = time.time()
                self._process = None
                self._reader_thread = None

                if self._stop_requested:
                    self._state = "stopped"
                    self._append_log("cyanrip wurde gestoppt.")
                elif returncode == 0:
                    self._state = "finished"
                    self._append_log("cyanrip erfolgreich beendet.")
                else:
                    self._state = "failed"
                    self._append_log(f"cyanrip mit Exit-Code {returncode} beendet.")

                self._stop_requested = False

    @staticmethod
    def _resolve_workdir(working_directory: str | None) -> str:
        if not working_directory:
            return os.getcwd()

        cwd = os.path.abspath(os.path.expanduser(working_directory))
        if not os.path.isdir(cwd):
            raise NotADirectoryError(f"Arbeitsverzeichnis existiert nicht: {cwd}")
        return cwd

    @staticmethod
    def _iso(timestamp: float | None) -> str | None:
        if timestamp is None:
            return None
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(timestamp))
