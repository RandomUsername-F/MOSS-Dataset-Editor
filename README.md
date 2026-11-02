# MOSS-Dataset-Editor

Fork of [RunningOverGlowies/MOSS-BBox-Editor](https://github.com/RunningOverGlowies/MOSS-BBox-Editor). Refer to the original README for basic usage instructions.

Modified to work as stand-alone dataset manager. Meant for manual updating of old datasets to MOSS-image layout.

## New features

- **Local Python server** (`server.py`) that gives the editor read/write access to files on disk.
- **Load Dataset** button opens a native folder picker. The **Load subfolders** checkbox includes images in subfolders.
- **Dataset sidebar** (left) lists images with thumbnails and names. It is virtualized and lazy-loaded for large datasets.
- **Image selection** sets the canvas to the exact image dimensions and warns if they are not multiples of 16.
- **Per-image JSON autosave:** the sibling `.json` is loaded, or created if missing, and every change is saved immediately.
- **JSON box** (header): **Auto** compiles automatically. Checked, autosave writes the compiled MOSS-Image prompt (compact, `abs_centralized` / `yxyx` boxes, same output as `compile_prompt.py` from the dataset-image-annotator skill) and draft files are compiled when their image is loaded. Unchecked, autosave keeps each file in the format it already has (new files are drafts: pretty JSON, canvas rounded to multiples of 16). **Compile** and **Decompile** convert the open image's JSON on demand; decompiling is manual only. If a file cannot be compiled yet (for example an empty caption), it is saved as a draft and a notice at the top right of the canvas says why. Compiled files are decompiled in the editor automatically when opened.
- **LLM request settings** (⚙️) also hold **Special instructions** (free text about the dataset's theme or unusual concepts, added to every request), the **Hint** toggle (adds the companion field, tags or caption, as context), **Auto-review** with a retry count, and the timeout.
- **Text caption tab** shows the sibling `.txt` of the selected image (read-only). **Copy to summary caption** (in that tab) and **Copy from .txt** (next to `summary.caption`) replace the summary caption with its text.
- **Apply to dataset** (next to `summary.meta`) writes the current Style / Genre meta to every image's JSON in the loaded dataset, creating missing JSONs.
- **Search box** above the image list filters the dataset by captions, tags, labels, meta and the `.txt` file (not case sensitive). Start the term with `-` (e.g. `-forest`) to show only images that do **not** match. Page Up/Down and Ctrl+↑/↓ follow the filtered list.
- **Page Up / Page Down** (or **Ctrl+↑ / Ctrl+↓**, which also work while typing) select the previous / next image in the dataset.
- **Crop tool** (✂️ button right of Redo):
  - **Manual** mode: drag or resize the frame, or type X/Y/W/H.
  - **Auto (÷16)** mode: shows a centered frame cropped down to the nearest multiple of 16 and waits for **✔ Confirm crop**.
  - **Shortcuts:** **Ctrl+D** or **Ctrl+Numpad0** starts auto-crop, **Ctrl+Enter** confirms the crop, **Esc** cancels.
  - Existing boxes are shifted to the new coordinates. Boxes fully outside the crop are removed.
  - The image file is overwritten at maximum quality (JPEG quality 100, WebP lossless). **Backup original** keeps the first original in `.crop_backup` inside the dataset folder. GIFs are not supported.
- **LLM auto-caption** (card above Scene Summary): **Boxes + Caption + Tags** detects boxes and then captions and tags the scene and every new box. **Fill empty elements** captions and tags only existing empty elements. The server address field (default `http://localhost:1234/v1/chat/completions`, any OpenAI-compatible vision endpoint) is saved in the browser, and the ⚙️ button opens an editor for the exact request template and prompts, with a live preview. Every caption, summary, meta, palette and item tags field also has an **✨ Auto** button that overwrites only that field, sending the scene summary and the other characters/objects/text as context.
- **Ultralytics detector** (**🎯 Boxes (YOLO)** in the LLM card): creates boxes with local Ultralytics `.pt` models, run by `yolo_runner.py` in the server's Python or in a chosen venv. The **🎯 Ultralytics detector** tab of the ⚙️ settings popup shows whether `ultralytics` is installed (with a re-check button), the venv option, the models folder (with a folder picker) and a model manager: tick models or whole groups on/off, put models that detect the same thing into one group (only one model per group runs) and mark each model as 📷 Photo and/or 🎨 Illustration. The image type is read from `summary.meta` (or asked from the LLM when `meta` does not say), and in each group the model marked for that type is used. New boxes get the YOLO class as their first tag; `person` becomes a `character`, everything else an `object`.
- **Duplicate button (⧉)** on each box card clones the box.
- **Ctrl+C / Ctrl+V** copy the selected box(es) and paste them: centered on the mouse if it is over the canvas, otherwise at the canvas center (where new boxes are added). Disabled while a text field is focused.
- **Box rendering:** borders, dashes and handles keep a constant on-screen size at any zoom. The resize grab area is larger than the visible border and handles.
- **Mouse controls:** only the left button moves boxes. Middle and right buttons drag the canvas.
- **Thumbnail cache** (`.thumb_cache`) is cleared when the server exits.
- Toast notifications appear at the bottom of the window.
- **`run.bat`** installs missing dependencies and starts the server. The port can be changed inside the file.

## Usage

Run `run.bat` (or `pip install flask pillow` then `python server.py`) and open the printed link, `http://127.0.0.1:5012` by default.