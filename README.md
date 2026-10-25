# MOSS-Dataset-Editor

Fork of [RunningOverGlowies/MOSS-BBox-Editor](https://github.com/RunningOverGlowies/MOSS-BBox-Editor). Refer to the original README for basic usage instructions.

Modified to work as stand-alone dataset manager. Meant for manual updating of old datasets to MOSS-image layout.

## New features

- **Local Python server** (`server.py`) that gives the editor read/write access to files on disk.
- **Load Dataset** button opens a native folder picker. The **Load subfolders** checkbox includes images in subfolders.
- **Dataset sidebar** (left) lists images with thumbnails and names. It is virtualized and lazy-loaded for large datasets.
- **Image selection** sets the canvas to the exact image dimensions and warns if they are not multiples of 16.
- **Per-image JSON autosave:** the sibling `.json` is loaded, or created if missing, and every change is saved immediately.
- **Text caption tab** shows the sibling `.txt` of the selected image (read-only).
- **Duplicate button (⧉)** on each box card clones the box.
- **Mouse controls:** only the left button moves boxes. Middle and right buttons drag the canvas.
- **`run.bat`** installs missing dependencies and starts the server. The port can be changed inside the file.

## Usage

Run `run.bat` (or `pip install flask pillow` then `python server.py`) and open the printed link, `http://127.0.0.1:5000` by default.
