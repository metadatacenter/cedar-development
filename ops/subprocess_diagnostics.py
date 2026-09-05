"""Operator-facing descriptions for subprocess exit status."""

import platform
import signal
from pathlib import Path


def describe_return_code(return_code: int) -> str:
    if return_code >= 0:
        return f"exited with code {return_code}"
    number = -return_code
    try:
        name = signal.Signals(number).name
    except ValueError:
        name = "UNKNOWN"
    description = f"was terminated by {name} (signal {number})"
    if platform.system() == "Darwin":
        return description + f"; inspect {Path.home() / 'Library/Logs/DiagnosticReports'}"
    if platform.system() == "Linux":
        return description + "; inspect coredumpctl and /var/lib/systemd/coredump"
    return description + "; inspect the platform crash-report or core-dump location"
