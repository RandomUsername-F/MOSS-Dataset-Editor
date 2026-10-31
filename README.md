# MOSS-Dataset-Editor

Fork of [RunningOverGlowies/MOSS-BBox-Editor](https://github.com/RunningOverGlowies/MOSS-BBox-Editor). Refer to the original README for basic usage instructions.

Modified to work as stand-alone dataset manager. Meant for manual updating of old datasets to MOSS-image layout.

## New features

- **Local Python server** (`server.py`) that gives the editor read/write access to files on disk.
- **Load Dataset** button opens a native folder picker. The **Load subfolders** checkbox includes images in subfolders.
- **Dataset sidebar** (left) lists images with thumbnails and names. It is virtualized and lazy-loaded for large datasets.
- **Image selection** sets the canvas to the exact image dimensions and warns if they are not multiples of 16.
- **Per-image JSON autosave:** the sibling `.json` is loaded, or created if missing, and every change is saved immediately.
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
- **Duplicate button (⧉)** on each box card clones the box.
- **Ctrl+C / Ctrl+V** copy the selected box(es) and paste them: centered on the mouse if it is over the canvas, otherwise at the canvas center (where new boxes are added). Disabled while a text field is focused.
- **Box rendering:** borders, dashes and handles keep a constant on-screen size at any zoom. The resize grab area is larger than the visible border and handles.
- **Mouse controls:** only the left button moves boxes. Middle and right buttons drag the canvas.
- **Thumbnail cache** (`.thumb_cache`) is cleared when the server exits.
- Toast notifications appear at the bottom of the window.
- **`run.bat`** installs missing dependencies and starts the server. The port can be changed inside the file.

## Usage

Run `run.bat` (or `pip install flask pillow` then `python server.py`) and open the printed link, `http://127.0.0.1:5012` by default.