"""Tests for the Kaggle SDXL image provider + POST /generate/keyframe (fake run.sh, no Kaggle)."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.providers.image import kaggle_sdxl_provider as mod
from app.providers.image.kaggle_sdxl_provider import KaggleSdxlProvider

FAKE_RUN_SH = """#!/usr/bin/env bash
set -e
echo "1 prompt(s) from $1 | model: $MODEL | size: $SIZE"
echo "Waiting for Kaggle..."
OUT="outputs/20260101-000000"
mkdir -p "$OUT"
printf '\\x89PNG\\r\\n' > "$OUT/img_000.png"
echo "Images saved to $OUT"
"""


@pytest.fixture
def kaggle_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    kd = tmp_path / "kaggle-image-gen"
    kd.mkdir()
    (kd / "run.sh").write_text(FAKE_RUN_SH)
    os.chmod(kd / "run.sh", 0o755)
    (kd / ".env").write_text("KAGGLE_API_TOKEN=fake\n")
    monkeypatch.setattr(mod, "KAGGLE_DIR", kd)
    monkeypatch.setattr(mod, "RUN_SH", kd / "run.sh")
    return kd


@pytest.fixture
def outputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    out = tmp_path / "outputs"
    out.mkdir()
    monkeypatch.setattr(mod.settings, "_raw_outputs_path", str(out))
    return out


def test_registered_and_unavailable_without_pipeline(tmp_path: Path, monkeypatch):
    from app.registry import IMAGE_DRAFT_PROVIDERS

    assert IMAGE_DRAFT_PROVIDERS["kaggle_sdxl"] is KaggleSdxlProvider
    monkeypatch.setattr(mod, "KAGGLE_DIR", tmp_path / "nope")
    monkeypatch.setattr(mod, "RUN_SH", tmp_path / "nope" / "run.sh")
    p = KaggleSdxlProvider()
    assert p.is_available() is False
    assert "not found" in (p.unavailable_reason() or "")


def test_generate_runs_script_and_copies_png(kaggle_dir: Path, outputs: Path):
    progress: list[str] = []

    async def on_progress(pct, msg):
        progress.append(msg)

    result = asyncio.run(
        KaggleSdxlProvider().generate("A lighthouse\nat dusk", [], {"aspect_ratio": "16:9", "model": "juggernaut"}, on_progress)
    )

    assert result.success is True, result.error
    rel = result.output_paths[0]
    assert rel.startswith("keyframes/kaggle_") and rel.endswith(".png")
    assert (outputs / rel).read_bytes().startswith(b"\x89PNG")
    assert result.metadata["size"] == "1344x768" and result.metadata["model"] == "juggernaut"
    assert progress and progress[0].startswith("Kaggle: pushing notebook (juggernaut, 1344x768)")
    assert progress[-1] == "Kaggle: complete"


def test_generate_rejects_unknown_model(kaggle_dir: Path, outputs: Path):
    result = asyncio.run(KaggleSdxlProvider().generate("x", [], {"model": "flux"}))
    assert result.success is False and "Unknown Kaggle model" in (result.error or "")


def test_generate_reports_script_failure(kaggle_dir: Path, outputs: Path):
    (kaggle_dir / "run.sh").write_text("#!/usr/bin/env bash\necho 'kernel ERROR: quota exceeded'\nexit 1\n")
    result = asyncio.run(KaggleSdxlProvider().generate("x", [], {}))
    assert result.success is False
    assert "quota exceeded" in (result.error or "")


def test_keyframe_job_route(kaggle_dir: Path, outputs: Path):
    from app.main import app

    client = TestClient(app)
    assert client.post(
        "/generate/keyframe", json={"scene_id": "s1", "prompt": "x", "provider_id": "nope"}
    ).status_code == 404

    res = client.post(
        "/generate/keyframe",
        json={"scene_id": "s1", "prompt": "A lighthouse", "provider_id": "kaggle_sdxl", "aspect_ratio": "1:1"},
    )
    assert res.status_code == 200, res.text
    job_id = res.json()["job_id"]

    deadline = time.time() + 10
    while time.time() < deadline:
        job = client.get(f"/jobs/{job_id}").json()
        if job["status"] in ("completed", "failed"):
            break
        time.sleep(0.2)
    assert job["status"] == "completed", job
    assert job["output_path"].startswith("keyframes/kaggle_")
