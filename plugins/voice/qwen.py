# SPDX-License-Identifier: AGPL-3.0-only
"""Alexia's side of the Qwen3-TTS bridge: a reference clip in, a WAV out.

This file is run by whatever Python the user pointed the "Qwen program" setting at. It is
deliberately the whole of the Python in this plugin, and it is deliberately small: everything
about *which* voice, *which* clip and *what to say* is decided in `qwen.js` and arrives as
arguments, so this file holds no state and remembers nothing between calls.

**Nothing here installs anything.** If the packages are not in this interpreter, that is said
in one sentence on stderr and the exit code is non-zero — `fetching.js:run()` shows the last
line of stderr as the error, so what a person reads on the page is the sentence below rather
than a traceback. A plugin that pip-installed six gigabytes of PyTorch because somebody asked
for a voice would have decided something for them; see `plugins/media/launch.js`.

**Unverified from this repo, exactly as `fish.clone` was when it shipped.** There is no Qwen
install on the machine this was written on, so the call below is written from the published
shape of the model card and the first run against a real install is where it is confirmed.
That is why every failure here is a readable sentence: when the shape is wrong, what comes
back names the thing that was wrong rather than being a mystery.
"""

import argparse
import sys

# The published checkpoint, pinned. An unpinned name changes what runs, silently — the same
# reasoning `piper.js` pins its release with.
MODEL = "Qwen/Qwen3-TTS-Flash"

MISSING = (
    "This Python has no Qwen3-TTS in it. Install transformers, torch and soundfile into the "
    "interpreter the “Qwen program” setting points at, then try again. Alexia will not "
    "install them for you: that is six gigabytes and your decision."
)


def main() -> int:
    ask = argparse.ArgumentParser(add_help=False)
    ask.add_argument("--ref", required=True, help="the reference recording to imitate")
    ask.add_argument("--ref-text", default="", help="the words spoken in that recording")
    ask.add_argument("--text", required=True, help="what to say")
    ask.add_argument("--out", required=True, help="where to write the WAV")
    args = ask.parse_args()

    try:
        import soundfile
        import torch
        from transformers import AutoModelForTextToWaveform, AutoProcessor
    except ImportError:
        print(MISSING, file=sys.stderr)
        return 2

    # The card if there is one, and the processor otherwise. A model this size on a CPU is
    # minutes rather than seconds, which is worth being honest about rather than silently slow.
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        print("No graphics card was found, so this will take minutes rather than seconds.", file=sys.stderr)

    try:
        processor = AutoProcessor.from_pretrained(MODEL)
        model = AutoModelForTextToWaveform.from_pretrained(MODEL).to(device)
    except Exception as error:  # noqa: BLE001 — the message is the product here
        print(f"Qwen3-TTS could not be loaded: {error}", file=sys.stderr)
        return 3

    try:
        reference, rate = soundfile.read(args.ref)
        inputs = processor(
            text=args.text,
            audio=reference,
            sampling_rate=rate,
            prompt_text=args.ref_text or None,
            return_tensors="pt",
        ).to(device)
        with torch.no_grad():
            spoken = model.generate(**inputs)
        wave = spoken[0].detach().to("cpu").float().numpy()
        soundfile.write(args.out, wave, getattr(model.config, "sampling_rate", 24000))
    except Exception as error:  # noqa: BLE001
        print(f"Qwen3-TTS did not speak: {error}", file=sys.stderr)
        return 4

    return 0


if __name__ == "__main__":
    sys.exit(main())
