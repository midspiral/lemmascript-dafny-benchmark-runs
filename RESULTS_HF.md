# Private results archive

Destination: [midspiral/lemmascript-dafny-benchmark-runs-results](https://huggingface.co/datasets/midspiral/lemmascript-dafny-benchmark-runs-results), a private Hugging Face dataset. Any account with write access to this dataset can upload using its own login.

With `uv` installed, log in once and approve write access to the dataset:

```sh
uvx --from huggingface_hub hf auth login --force
```

From this repository, preview or push the current results:

```sh
npm run results:push -- --dry-run
npm run results:push
```

Run the same push command after new runs. It uploads `results/`,
`results-pre-context/`, the CSV ledgers and README in `records/`, and
`protocol.json`, preserving their paths. Failed and interrupted attempts are
included. Hidden files, temporary files, credentials outside those directories,
and the Git checkout are excluded; symlinks are rejected.

The script creates the dataset as private if needed and refuses to upload to a
public repository. It copies the selected files into a temporary snapshot,
uploads new or changed files, and verifies every uploaded file's size and hash.
`archive-manifest.json` lists SHA-256 hashes for the latest local snapshot.
Remote files absent locally are retained. Re-run the command after an interrupted
upload; unchanged content is skipped. Uploads are explicit, separate from running
benchmarks, and use a pinned Hugging Face client installed by `uv`.

To restore raw results into a fresh Git clone, run these commands from the clone's
root directory. A login with read access to the private dataset is sufficient:

```sh
uvx --from huggingface_hub==2.0.0 hf auth login
uvx --from huggingface_hub==2.0.0 hf download \
  midspiral/lemmascript-dafny-benchmark-runs-results \
  --repo-type dataset --local-dir . \
  --include 'results/**' --include 'results-pre-context/**'
```

Git provides the scripts, protocol, and published ledgers; this restores the two
raw results directories in their original locations. Re-run the download command
to fetch later uploads.

To download the entire archive, including its copies of the ledgers and protocol,
into a separate directory:

```sh
uvx --from huggingface_hub hf download \
  midspiral/lemmascript-dafny-benchmark-runs-results \
  --repo-type dataset --local-dir ../lemmascript-results-backup
```

Uploader tests: `npm run test:results`.
