import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("push_results", Path(__file__).resolve().parents[1] / "push-results.py")
uploader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploader)


class ResultsUploadTest(unittest.TestCase):
    def test_snapshot_limits_scope_and_preserves_binary_content_and_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            folder = Path(temporary) / "snapshot"
            folder.mkdir()
            contents = {
                "results/run/tasks/0006/trial-01/candidate.dfy": b"lemma L()\r\n{}\r\n",
                "results/run/unfinished/claude.stream.jsonl": b'{"partial":',
                "results-pre-context/old/result.json": b"{}\n",
                "records/locs.csv": b"record_id,added_dafny_lines\n",
                "records/README.md": b"Record documentation\n",
                "protocol.json": b"{}\n",
                ".env": b"private",
                "results/.env": b"private",
                "results/run/.cache/file": b"cache",
                "results/run/active.tmp": b"temporary",
                "records/.ledger.lock": b"lock",
                "records/unrelated.txt": b"unrelated",
                "run.mjs": b"source code",
            }
            for name, data in contents.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            selected = uploader.selected_files(root)
            self.assertEqual(len(selected), 6)
            hashes = uploader.snapshot(root, selected, folder)
            self.assertEqual(len(hashes), 8)
            manifest = json.loads((folder / "archive-manifest.json").read_text())
            for relative in selected:
                data = contents[relative.as_posix()]
                self.assertEqual((folder / relative).read_bytes(), data)
                self.assertEqual(manifest["files"][relative.as_posix()]["sha256"], hashlib.sha256(data).hexdigest())
            repeated = Path(temporary) / "repeated"
            repeated.mkdir()
            self.assertEqual(uploader.snapshot(root, selected, repeated), hashes)
            (root / "results/link").symlink_to(root / ".env")
            with self.assertRaisesRegex(ValueError, "symlink"):
                uploader.selected_files(root)

    def test_read_only_login_cannot_create_repository(self):
        for name in ["mitnamin", "another-member"]:
            api = Mock()
            api.whoami.return_value = {"name": name, "auth": {"accessToken": {"role": "read"}}}
            with self.assertRaisesRegex(ValueError, "read-only"):
                uploader.prepare_repo(api, uploader.REPO_ID)
            api.create_repo.assert_not_called()

    def test_another_member_can_use_their_own_write_capable_login(self):
        for auth in [{"accessToken": {"role": "write"}}, {"accessToken": {"role": "fineGrained"}}, {"type": "oauth"}]:
            api = Mock()
            api.whoami.return_value = {"name": "another-member", "auth": auth}
            api.repo_info.return_value = SimpleNamespace(private=True)
            uploader.prepare_repo(api, uploader.REPO_ID)
            api.repo_info.assert_called_once_with(uploader.REPO_ID, repo_type="dataset")

    def test_creation_is_private_and_existing_public_repository_is_rejected(self):
        api = Mock()
        api.whoami.return_value = {"name": "mitnamin", "auth": {"accessToken": {"role": "write"}}}
        api.repo_info.return_value = SimpleNamespace(private=False)
        with self.assertRaisesRegex(ValueError, "not private"):
            uploader.prepare_repo(api, uploader.REPO_ID)
        api.create_repo.assert_called_once_with(repo_id=uploader.REPO_ID, repo_type="dataset", private=True, exist_ok=True)
        api.repo_info.return_value = SimpleNamespace(private=True)
        uploader.prepare_repo(api, uploader.REPO_ID)

    def test_remote_verification_checks_lfs_and_git_hashes_and_permits_retained_files(self):
        hashes = {"small": {"size": 1, "git_blob": "blob1", "sha256": "sha1"}, "large": {"size": 2, "git_blob": "blob2", "sha256": "sha2"}}
        small = SimpleNamespace(path="small", size=1, lfs=None, blob_id="blob1")
        large = SimpleNamespace(path="large", size=2, lfs=SimpleNamespace(sha256="sha2"))
        uploader.verify_remote([small, large, SimpleNamespace(path="old")], hashes)
        with self.assertRaisesRegex(ValueError, "missing"):
            uploader.verify_remote([small], hashes)
        large.lfs.sha256 = "corrupt"
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            uploader.verify_remote([small, large], hashes)


if __name__ == "__main__":
    unittest.main()
