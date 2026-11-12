#!/usr/bin/env python3
"""stt.py <fichier_audio> <dossier_sortie> <langue> <modèle> : transcrit avec faster-whisper (CPU, int8) et écrit out.txt.
Appelé par Hermes (HERMES_LOCAL_STT_COMMAND) pour les messages vocaux Telegram."""
import sys
from pathlib import Path
from faster_whisper import WhisperModel

audio, outdir, lang, model = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
m = WhisperModel(model, device="cpu", compute_type="int8")
segments, _ = m.transcribe(audio, language=lang or None, vad_filter=True)
Path(outdir, "out.txt").write_text(" ".join(s.text.strip() for s in segments).strip(), encoding="utf-8")
