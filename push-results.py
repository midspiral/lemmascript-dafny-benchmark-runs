#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["huggingface_hub==2.0.0"]
# ///
"""Explicit, incremental backup of raw results to a private Hugging Face dataset."""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile

REPO_ID = "midspiral/lemmascript-dafny-benchmark-runs-results"
LOGIN = "uvx --from huggingface_hub hf auth login --force"
CARD = """---
pretty_name: LemmaScript Dafny benchmark run results
---

# LemmaScript Dafny benchmark run results

Private archive of raw artifacts from
[lemmascript-dafny-benchmark-runs](https://github.com/midspiral/lemmascript-dafny-benchmark-runs).

- `results/`: current runs, including completed, failed, and interrupted attempts.
- `results-pre-context/`: historical runs before the current context protocol.
- `records/`: copies of the published trial, LOC, usage, skill, and review ledgers.
- `protocol.json`: the benchmark protocol.
- `archive-manifest.json`: sizes and SHA-256 hashes of files in the latest upload.

Paths match the local runs repository. Use the ledgers for published outcomes;
an archived directory does not imply a completed or successful trial.

Update from the runs repository with `npm run results:push`. Each upload adds or
updates files and preserves remote files absent locally. The manifest describes
the latest local snapshot, so older remote-only files may not be listed in it.
The uploader checks that this dataset is private before sending any contents.
"""


def selected_files(root):
    """Select the two raw archives and public records, never the whole checkout."""
    selected = []
    for name in ("results", "results-pre-context", "records"):
        directory = root / name
        if directory.is_symlink():
            raise ValueError(f"Refusing symlink: {directory}")
        if not directory.exists():
            continue
        for file in sorted(directory.rglob("*")):
            relative = file.relative_to(root)
            if any(part.startswith(".") for part in relative.parts) or file.name.endswith(".tmp"):
                continue
            if file.is_symlink():
                raise ValueError(f"Refusing symlink: {relative}")
            if file.is_file() and (name != "records" or file.suffix == ".csv" or file.name == "README.md"):
                selected.append(relative)
    if not any(p.parts[0] in ("results", "results-pre-context") for p in selected):
        raise ValueError("No raw results found in results/ or results-pre-context/.")
    protocol = root / "protocol.json"
    if protocol.is_symlink() or not protocol.is_file():
        raise ValueError("Expected a regular protocol.json in the runs repository.")
    return sorted([*selected, Path("protocol.json")])


def file_hashes(file):
    size = file.stat().st_size
    sha = hashlib.sha256()
    blob = hashlib.sha1(f"blob {size}\0".encode())
    with file.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
            blob.update(chunk)
    return {"size": size, "sha256": sha.hexdigest(), "git_blob": blob.hexdigest()}


def snapshot(root, files, destination):
    import shutil

    hashes = {}
    for relative in files:
        source, target = root / relative, destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        before = source.stat()
        shutil.copyfile(source, target, follow_symlinks=False)
        after = source.stat()
        if source.is_symlink() or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError(f"File changed while copying: {relative}; retry when its writer is idle.")
        hashes[relative.as_posix()] = file_hashes(target)
    (destination / "README.md").write_text(CARD, encoding="utf8")
    hashes["README.md"] = file_hashes(destination / "README.md")
    manifest = {"schema": 1, "files": {name: {"size": info["size"], "sha256": info["sha256"]} for name, info in sorted(hashes.items())}}
    (destination / "archive-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
    hashes["archive-manifest.json"] = file_hashes(destination / "archive-manifest.json")
    return hashes


def prepare_repo(api, repo_id):
    identity = api.whoami()
    if identity.get("auth", {}).get("accessToken", {}).get("role") == "read":
        raise ValueError(f"The saved Hugging Face token is read-only; run {LOGIN} and approve write access.")
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=True, exist_ok=True)
    if api.repo_info(repo_id, repo_type="dataset").private is not True:
        raise ValueError(f"Refusing to upload: {repo_id} is not private.")


def verify_remote(entries, hashes):
    remote = {entry.path: entry for entry in entries}
    for name, expected in hashes.items():
        entry = remote.get(name)
        if entry is None or entry.size != expected["size"]:
            raise ValueError(f"Remote file missing or size mismatch: {name}")
        actual, wanted = (entry.lfs.sha256, expected["sha256"]) if entry.lfs else (entry.blob_id, expected["git_blob"])
        if actual != wanted:
            raise ValueError(f"Remote hash mismatch: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent, help="runs repository or restored archive")
    parser.add_argument("--repo", default=REPO_ID, help="private dataset repository ID")
    parser.add_argument("--dry-run", action="store_true", help="list upload scope without authentication or network requests")
    args = parser.parse_args()
    root = args.source.resolve()
    files = selected_files(root)
    total = sum((root / p).stat().st_size for p in files)
    print(f"Destination: https://huggingface.co/datasets/{args.repo} (private)", flush=True)
    print(f"Selected {len(files)} files, {total / 1024**2:.1f} MiB, plus README and hash manifest.", flush=True)
    if args.dry_run:
        for directory in sorted({p.parts[0] for p in files}):
            print(f"  {directory}: {sum(p.parts[0] == directory for p in files)} files")
        return

    from huggingface_hub import HfApi, RepoFile

    api = HfApi(endpoint="https://huggingface.co", token=True)
    prepare_repo(api, args.repo)
    with tempfile.TemporaryDirectory(prefix="lemmascript-results-") as temporary:
        folder = Path(temporary)
        hashes = snapshot(root, files, folder)
        print("Uploading snapshot; unchanged files are skipped and remote-only files are retained.", flush=True)
        api.upload_folder(repo_id=args.repo, repo_type="dataset", folder_path=folder, commit_message="Back up benchmark run results")
        info = api.repo_info(args.repo, repo_type="dataset")
        if info.private is not True:
            raise ValueError("Repository visibility changed during upload; expected private.")
        entries = api.list_repo_tree(args.repo, repo_type="dataset", revision=info.sha, recursive=True)
        verify_remote((entry for entry in entries if isinstance(entry, RepoFile)), hashes)
    print(f"Verified {len(hashes)} files at private dataset revision {info.sha}.")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"Upload incomplete: {error or 'interrupted'}", file=sys.stderr)
        sys.exit(1)
