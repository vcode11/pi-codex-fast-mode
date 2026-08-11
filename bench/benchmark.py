import argparse
import hashlib
import json
import statistics
import subprocess
import time
from pathlib import Path

PROMPT = "Count from 1 through 1000, one integer per line, and output nothing else."
METRICS = ("ttfb", "stream", "turn", "wall")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="openai-codex/gpt-5.6-luna")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def run(repo, model, kind, trial):
    command = [
        "pi",
        "--mode",
        "json",
        "--no-session",
        "--no-tools",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        "--model",
        model,
        "--thinking",
        "minimal",
    ]
    if kind == "fast":
        command.extend(["-e", str(repo / "extensions/codex-fast-mode.ts"), "--fast"])
    command.append(PROMPT)

    started = time.monotonic()
    first_text = None
    turn_started = None
    turn_ended = None
    text = []
    usage = None
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    for line in process.stdout:
        now = time.monotonic()
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "turn_start" and turn_started is None:
            turn_started = now
        if event.get("type") == "message_update":
            update = event.get("assistantMessageEvent") or {}
            if update.get("type") == "text_delta" and update.get("delta"):
                if first_text is None:
                    first_text = now
                text.append(update["delta"])
        if event.get("type") == "turn_end":
            turn_ended = now
            usage = (event.get("message") or {}).get("usage")

    stderr = process.stderr.read()
    code = process.wait()
    ended = time.monotonic()
    output = "".join(text)
    return {
        "trial": trial,
        "kind": kind,
        "model": model,
        "code": code,
        "ttfb": None if first_text is None else first_text - started,
        "stream": None if first_text is None or turn_ended is None else turn_ended - first_text,
        "turn": None if turn_started is None or turn_ended is None else turn_ended - turn_started,
        "wall": ended - started,
        "chars": len(output),
        "sha256": hashlib.sha256(output.encode()).hexdigest(),
        "usage": usage,
        "stderr": stderr[-500:],
    }


def main():
    args = parse_args()
    repo = Path(__file__).resolve().parents[1]
    records = []
    output = args.output.open("w") if args.output else None

    def emit(record):
        line = json.dumps(record)
        print(line, flush=True)
        if output:
            output.write(f"{line}\n")
            output.flush()

    try:
        for trial in range(1, args.rounds + 1):
            order = ("baseline", "fast") if trial % 2 else ("fast", "baseline")
            for kind in order:
                record = run(repo, args.model, kind, trial)
                records.append(record)
                emit(record)
                if record["code"] != 0:
                    raise SystemExit(f"{kind} trial {trial} failed")

        for metric in METRICS:
            medians = {
                kind: statistics.median(record[metric] for record in records if record["kind"] == kind)
                for kind in ("baseline", "fast")
            }
            emit(
                {
                    "metric": metric,
                    "baseline_median": medians["baseline"],
                    "fast_median": medians["fast"],
                    "speedup": medians["baseline"] / medians["fast"],
                }
            )
    finally:
        if output:
            output.close()


if __name__ == "__main__":
    main()
