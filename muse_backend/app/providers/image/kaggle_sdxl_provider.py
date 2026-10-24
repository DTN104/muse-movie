"""
Visual Muse — Image Provider: Kaggle SDXL (free Kaggle GPU)

Wraps the existing `kaggle-image-gen/run.sh` pipeline: it pushes a notebook to Kaggle,
renders with SDXL or Juggernaut XL on a free GPU, and downloads the PNGs. No content
filter, no quota beyond Kaggle's weekly GPU hours — but slow: ~3 min model download
plus ~25 s per image, and only one run at a time (single shared kernel).

Location of the pipeline: env KAGGLE_IMAGE_GEN_DIR, else ../kaggle-image-gen next to the
Muse-Studio checkout. Credentials stay in that folder's .env; this provider never reads them.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from app.config import settings
from app.providers.base import ImageDraftProvider, ImageResult

# muse_backend/app/providers/image → parents[3] = muse_backend, parents[4] = Muse-Studio root
KAGGLE_DIR: Path = Path(
    os.getenv("KAGGLE_IMAGE_GEN_DIR") or Path(__file__).resolve().parents[4].parent / "kaggle-image-gen"
)
RUN_SH: Path = KAGGLE_DIR / "run.sh"
MODELS = ("sdxl", "juggernaut")
# Only SDXL-native resolutions (others give distorted/duplicated subjects).
SIZE_BY_ASPECT = {"16:9": "1344x768", "9:16": "768x1344", "1:1": "1024x1024", "21:9": "1536x640"}
TIMEOUT_SECONDS = 25 * 60


class KaggleSdxlProvider(ImageDraftProvider):
    provider_id = "kaggle_sdxl"
    display_name = "Kaggle SDXL (free GPU)"
    provider_type = "api"

    def is_available(self) -> bool:
        return RUN_SH.exists() and (KAGGLE_DIR / ".env").exists()

    def unavailable_reason(self) -> Optional[str]:
        if not RUN_SH.exists():
            return f"kaggle-image-gen not found at {KAGGLE_DIR} (set KAGGLE_IMAGE_GEN_DIR)."
        if not (KAGGLE_DIR / ".env").exists():
            return f"Missing {KAGGLE_DIR / '.env'} with KAGGLE_API_TOKEN."
        return None

    def capabilities(self) -> dict[str, Any]:
        return {
            "models": list(MODELS),
            "aspect_ratios": list(SIZE_BY_ASPECT),
            "reference_images": False,
            "note": "Runs kaggle-image-gen/run.sh on Kaggle's free GPU; ~4 min per image, one job at a time.",
        }

    async def generate(
        self,
        prompt: str,
        reference_image_paths: list[str],
        params: dict[str, Any],
        on_progress: Optional[Callable] = None,
    ) -> ImageResult:
        model = str(params.get("model") or "sdxl")
        if model not in MODELS:
            return ImageResult(success=False, error=f"Unknown Kaggle model '{model}' (use {', '.join(MODELS)}).")
        size = SIZE_BY_ASPECT.get(str(params.get("aspect_ratio") or "1:1"), "1024x1024")
        out_dir = settings.outputs_path / "keyframes"
        out_dir.mkdir(parents=True, exist_ok=True)

        # run.sh takes one prompt per line; a single-line prompt = a single image.
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(" ".join(prompt.split()) + "\n")
            prompt_file = f.name

        saved_dir: Optional[Path] = None
        tail: list[str] = []
        try:
            proc = await asyncio.create_subprocess_exec(
                str(RUN_SH),
                prompt_file,
                cwd=str(KAGGLE_DIR),
                env={**os.environ, "MODEL": model, "SIZE": size},
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            async def pump() -> None:
                nonlocal saved_dir
                assert proc.stdout is not None
                async for raw in proc.stdout:
                    line = raw.decode("utf-8", "replace").rstrip()
                    if not line:
                        continue
                    tail.append(line)
                    del tail[:-12]
                    if line.startswith("Images saved to "):
                        saved_dir = KAGGLE_DIR / line.removeprefix("Images saved to ").strip()
                    if on_progress:
                        await on_progress(50, f"Kaggle: {line.strip()[:120]}")

            if on_progress:
                await on_progress(5, f"Kaggle: pushing notebook ({model}, {size})")
            await asyncio.wait_for(pump(), timeout=TIMEOUT_SECONDS)
            code = await proc.wait()
        except asyncio.TimeoutError:
            proc.kill()
            return ImageResult(success=False, error=f"Kaggle run exceeded {TIMEOUT_SECONDS // 60} minutes.")
        except Exception as exc:  # noqa: BLE001
            return ImageResult(success=False, error=f"Kaggle: {exc}")
        finally:
            Path(prompt_file).unlink(missing_ok=True)

        if code != 0 or saved_dir is None:
            return ImageResult(
                success=False,
                error="Kaggle run failed: " + (" | ".join(tail[-4:]) or f"exit code {code}"),
                metadata={"provider": self.provider_id, "log_tail": tail},
            )

        outputs: list[str] = []
        for src in sorted(saved_dir.glob("*.png")):
            final = out_dir / f"kaggle_{uuid.uuid4().hex[:8]}.png"
            shutil.copy2(src, final)
            outputs.append(final.relative_to(settings.outputs_path).as_posix())
        if not outputs:
            return ImageResult(success=False, error=f"Kaggle finished but no PNG found in {saved_dir}.")

        if on_progress:
            await on_progress(100, "Kaggle: complete")
        return ImageResult(
            success=True,
            output_paths=outputs,
            metadata={"provider": self.provider_id, "model": model, "size": size, "kaggle_output_dir": str(saved_dir)},
        )
