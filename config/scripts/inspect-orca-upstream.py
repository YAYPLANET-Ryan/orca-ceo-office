"""Read-only upstream inspection; successful inspection never implies a merge."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def git(*args, cwd=None, allowed=(0,)):
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False, timeout=120,
    )
    if result.returncode not in allowed:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result


def inspect(base, upstream, cwd=None):
    def text(*args):
        return git(*args, cwd=cwd).stdout.decode("utf-8").strip()

    base_sha = text("rev-parse", "--verify", f"{base}^{{commit}}")
    upstream_sha = text("rev-parse", "--verify", f"{upstream}^{{commit}}")
    ahead, behind = map(int, text("rev-list", "--left-right", "--count",
                                  f"{base_sha}...{upstream_sha}").split())
    common = git("merge-base", base_sha, upstream_sha, cwd=cwd, allowed=(0, 1))
    report = {
        "state": "NEEDS_REVIEW" if behind else "AHEAD" if ahead else "UP_TO_DATE",
        "base_sha": base_sha, "upstream_sha": upstream_sha,
        "ahead": ahead, "behind": behind, "merged": False,
        "relationship": "unrelated" if common.returncode else
                        "diverged" if ahead and behind else
                        "behind" if behind else "ahead" if ahead else "equal",
        "conflict_check": "not_needed", "conflict_paths": [],
    }
    if not common.returncode and ahead and behind:
        merge = git("merge-tree", "--write-tree", "--name-only", "-z", "--no-messages",
                    base_sha, upstream_sha, cwd=cwd, allowed=(0, 1))
        fields = merge.stdout.decode("utf-8", errors="replace").split("\0")
        if not fields[0] or len(fields[0].strip()) not in (40, 64):
            raise RuntimeError("merge-tree did not produce a valid tree identity")
        report["conflict_check"] = "conflicts" if merge.returncode else "clean"
        report["conflict_paths"] = sorted(set(value for value in fields[1:] if value))
    elif common.returncode:
        report["state"] = "NEEDS_REVIEW"
        report["conflict_check"] = "unrelated_histories"
    return report


def summary(report):
    lines = [f"# STATE: {report['state']}", "",
             "Inspection completed. No code was merged, committed, pushed or released.", "",
             f"Relationship: {report['relationship']}; ahead: {report['ahead']}; "
             f"behind: {report['behind']}; conflict check: {report['conflict_check']}.", "",
             f"Base SHA: {report['base_sha']}", "",
             f"Upstream SHA: {report['upstream_sha']}", "",
             "Manual review is required before applying upstream changes."
             if report["state"] == "NEEDS_REVIEW" else "No incoming upstream commits.", "",
             "Conflict paths are preserved in the JSON artifact."]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        report = inspect(args.base, args.upstream)
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        Path(args.output).write_text(json.dumps({"state": "INFRA_ERROR", "merged": False,
                                               "error": str(error)}, indent=2) + "\n",
                                    encoding="utf-8")
        print("Upstream inspection failed; see artifact for details.", file=sys.stderr)
        return 1
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(summary(report))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as output:
            output.write(summary(report))
    if report["state"] == "NEEDS_REVIEW":
        print("::warning::Upstream changes need manual review; no changes were applied.")
    return int(report["state"] == "NEEDS_REVIEW" and os.environ.get("FAIL_ON_REVIEW") == "1")


if __name__ == "__main__":
    sys.exit(main())
