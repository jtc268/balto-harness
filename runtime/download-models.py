from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download


CACHE_ROOT = Path("/root/.cache/huggingface/hub")
MARKER_PATH = CACHE_ROOT / ".balto-qwen38-complete.json"
REPOSITORIES = (
    ("RadixArk/Qwen3.8-27B-NVFP4", "52d1adc5f38aa5ebf099c29ed7025ba34cfbb854"),
    ("RadixArk/Qwen3.8-27B-DSpark", "923ed3a8572615643f0137e424e4ce4edd7f1cda"),
)


def download(repository):
    repo_id, revision = repository
    snapshot_download(
        repo_id=repo_id,
        revision=revision,
        cache_dir=str(CACHE_ROOT),
        max_workers=4,
    )
    return {"repo": repo_id, "revision": revision}


def main():
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    if os.environ.get("BALTO_DOWNLOAD_CHECK") == "1":
        api = HfApi()
        checked = [
            {"repo": repo_id, "revision": api.model_info(repo_id, revision=revision).sha}
            for repo_id, revision in REPOSITORIES
        ]
        print(json.dumps({"checked": checked}))
        return
    with ThreadPoolExecutor(max_workers=len(REPOSITORIES)) as executor:
        completed = list(executor.map(download, REPOSITORIES))
    marker = {
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "repositories": completed,
    }
    temporary = MARKER_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(marker, indent=2), encoding="utf-8")
    temporary.replace(MARKER_PATH)


if __name__ == "__main__":
    main()
