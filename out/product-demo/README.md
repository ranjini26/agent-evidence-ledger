# Product demos

Recorded from the static build with the `product-demo` agent skill (pinned in `skills-lock.json`; install with `npx skills experimental_install`, Node 22+). All data shown is synthetic **SAMPLE** data, and every frame of the voiceover video is stamped as such.

| File                          | What it is                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `full-demo-voiceover.mp4`     | Full walkthrough, ~99 s, voiceover (macOS `say`, Samantha) and soft English captions                        |
| `full-demo-voiceover.png`     | Poster frame                                                                                                |
| `full-demo.srt`               | Captions as a separate file                                                                                 |
| `evidence-trail.mp4` / `.png` | 17 s silent clip: from a failed control to the exact log entry                                              |
| `takes/`                      | Cursor scripts for each video                                                                               |
| `voiceover/narration.json`    | The narration script, one entry per scene                                                                   |
| `voiceover/mix.py`            | Places each narration clip at its scene, writes captions, adds the SAMPLE stamp                             |
| `fixtures/`                   | The SAMPLE trace uploaded in the full demo (a copy of `evals/groundedness/traces/gt-24-mixed-answers.json`) |

## Re-render the full demo

Serve the static build (`bun run build:pages`) at `/agent-evidence-ledger/` on port 8090, or point `DEMO_URL` at `bun run dev` (`http://localhost:8080/`). Then:

```sh
python3 - <<'PY'   # regenerate the voice clips and their durations
import json, subprocess
V = "out/product-demo/voiceover"; d = {}
for s in json.load(open(f"{V}/narration.json")):
    f = f"{V}/{s['id']}.aiff"
    subprocess.run(["say", "-v", "Samantha", "-r", "178", "-o", f, s["text"]], check=True)
    d[s["id"]] = round(float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], capture_output=True, text=True).stdout), 3)
json.dump(d, open(f"{V}/durations.json", "w"), indent=2)
PY
node .claude/skills/product-demo/scripts/record.mjs --take out/product-demo/takes/full-demo.mjs \
  --out out/product-demo/full-demo --width 1600 --height 1000 --keep-frames
python3 out/product-demo/voiceover/mix.py full-demo
```
