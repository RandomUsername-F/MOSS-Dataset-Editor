"""Local server for MOSS-BBox-Editor dataset mode.
Setup: pip install flask pillow   (pillow is optional, used for cached thumbnails)
Run:   python server.py [--port 5000]
"""
import argparse, atexit, hashlib, json, logging, os, re, shutil, signal, subprocess, sys, threading, time
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

BASE = os.path.dirname(os.path.abspath(__file__))
THUMB_DIR = os.path.join(BASE, '.thumb_cache')
IMG_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'}
STATIC_EXT = {'.html', '.js', '.css'}
MAX_FILES = 200_000
MAX_JSON = 20_000_000

app = Flask(__name__)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
logging.getLogger('werkzeug').setLevel(logging.WARNING)
D = {'root': None, 'files': [], 'version': 0}
lock = threading.Lock()


@app.before_request
def guard():
    if request.host.split(':')[0] not in ('127.0.0.1', 'localhost'):
        abort(403)
    if request.method in ('POST', 'PUT') and not request.is_json:
        abort(415)  # forces a CORS preflight for cross-site requests, which this server never answers


def nkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s.lower())]


def scan(root, recursive):
    out, stack, truncated = [], [root], False
    while stack and not truncated:
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    if recursive and not e.name.startswith('.'):
                        stack.append(e.path)
                elif os.path.splitext(e.name)[1].lower() in IMG_EXT:
                    out.append(os.path.relpath(e.path, root))
                    if len(out) >= MAX_FILES:
                        truncated = True
                        break
            except OSError:
                pass
    out.sort(key=lambda p: nkey(p.replace('\\', '/')))
    return out, truncated


def resolve():
    v, i = request.args.get('v', type=int), request.args.get('i', type=int)
    with lock:
        files, root, ver = D['files'], D['root'], D['version']
    if v != ver or i is None or not 0 <= i < len(files):
        abort(404)
    return os.path.join(root, files[i])


@app.post('/api/pick-folder')
def pick_folder():
    code = ("import tkinter as tk\nfrom tkinter import filedialog\n"
            "r=tk.Tk();r.withdraw();r.attributes('-topmost',True)\n"
            "print(filedialog.askdirectory(title='Select dataset folder'),end='')")
    try:  # separate process: Tk must own its thread
        p = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=600,
                           env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        if p.returncode:
            return jsonify(manual=True, path='')
        return jsonify(path=os.path.normpath(p.stdout.decode('utf-8').strip()) if p.stdout.strip() else '')
    except Exception:
        return jsonify(manual=True, path='')


@app.post('/api/dataset')
def load_dataset():
    j = request.get_json(silent=True) or {}
    root = os.path.abspath(os.path.expanduser(str(j.get('path', ''))))
    if not os.path.isdir(root):
        return jsonify(error='Folder not found'), 400
    files, truncated = scan(root, bool(j.get('recursive')))
    with lock:
        D.update(root=root, files=files, version=time.time_ns() // 1_000_000)  # unique per load, even across restarts
        version = D['version']
    return jsonify(count=len(files), truncated=truncated, version=version, root=root)


@app.get('/api/items')
def items():
    off, lim = max(0, request.args.get('offset', 0, int)), min(request.args.get('limit', 200, int), 1000)
    with lock:
        files = D['files']
    return jsonify(items=[{'rel': f.replace('\\', '/'), 'name': os.path.basename(f)} for f in files[off:off + lim]])


@app.get('/api/image')
def image():
    return send_file(resolve())


@app.get('/api/thumb')
def thumb():
    p = resolve()
    try:
        from PIL import Image
        st = os.stat(p)
        out = os.path.join(THUMB_DIR, hashlib.sha1(f'{p}|{st.st_mtime_ns}|{st.st_size}'.encode()).hexdigest() + '.jpg')
        if not os.path.exists(out):
            os.makedirs(THUMB_DIR, exist_ok=True)
            tmp = f'{out}.{threading.get_ident()}.tmp'
            with Image.open(p) as im:
                im.draft('RGB', (192, 192))
                t = im.convert('RGB')
                t.thumbnail((96, 96))
                t.save(tmp, 'JPEG', quality=80)
            os.replace(tmp, out)
        return send_file(out, max_age=0)
    except Exception:
        return send_file(p)  # Pillow missing or unreadable image: serve the original


@app.get('/api/sidecar')
def sidecar():
    base = os.path.splitext(resolve())[0]

    def read(ext, cap):
        try:
            with open(base + ext, 'rb') as f:
                return f.read(cap).decode('utf-8-sig', 'replace')
        except OSError:
            return None

    raw, data, invalid = read('.json', MAX_JSON), None, False
    if raw is not None:
        try:
            data = json.loads(raw)
        except ValueError:
            invalid = True
    return jsonify(exists=raw is not None, invalid=invalid, json=data, txt=read('.txt', 1_000_000))


@app.put('/api/json')
def save_json():
    path = os.path.splitext(resolve())[0] + '.json'
    raw = request.get_data()
    if len(raw) > MAX_JSON:
        abort(413)
    try:
        obj = json.loads(raw)
    except ValueError:
        abort(400)
    if not isinstance(obj, dict) or not isinstance(obj.get('items'), list):
        abort(400)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:  # atomic replace: never leaves a half-written .json
        f.write(raw)
    os.replace(tmp, path)
    return jsonify(ok=True)


@app.post('/api/crop')
def crop_image():
    p = resolve()
    j = request.get_json(silent=True) or {}
    try:
        x, y, w, h = (int(j[k]) for k in 'xywh')
    except (KeyError, TypeError, ValueError):
        abort(400)
    if os.path.splitext(p)[1].lower() == '.gif':
        return jsonify(error='GIF cropping is not supported'), 400
    tmp = p + '.crop.tmp'
    try:
        from PIL import Image, ImageOps
        with Image.open(p) as im:
            fmt = 'JPEG' if im.format == 'MPO' else im.format
            icc = im.info.get('icc_profile')
            im.load()
            img = ImageOps.exif_transpose(im)  # same orientation the browser displays
            W, H = img.size
            if not (w >= 1 and h >= 1 and x >= 0 and y >= 0 and x + w <= W and y + h <= H):
                return jsonify(error='Crop frame is outside the image'), 400
            out = img.crop((x, y, x + w, y + h))
            kw = {'icc_profile': icc} if icc else {}
            if fmt == 'JPEG':
                kw.update(quality=100, subsampling=0)
            elif fmt == 'WEBP':
                kw.update(lossless=True, quality=100, exact=True)
            if j.get('backup', True):
                root = D['root']
                bak = os.path.join(root, '.crop_backup', os.path.relpath(p, root))
                if not os.path.exists(bak):  # keep only the very first original
                    os.makedirs(os.path.dirname(bak), exist_ok=True)
                    shutil.copy2(p, bak)
            out.save(tmp, format=fmt, **kw)
        os.replace(tmp, p)
    except ImportError:
        return jsonify(error='Pillow is required for cropping (pip install pillow)'), 500
    except Exception as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        return jsonify(error=f'Crop failed: {e}'), 500
    return jsonify(ok=True, width=w, height=h)


def write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


@app.post('/api/apply-meta')
def apply_meta():
    j = request.get_json(silent=True) or {}
    meta = j.get('meta')
    if not isinstance(meta, list) or not all(isinstance(m, str) for m in meta):
        abort(400)
    with lock:
        files, root, ver = D['files'], D['root'], D['version']
    if j.get('v') != ver:
        abort(404)
    n = {'updated': 0, 'created': 0, 'skipped': 0}
    for f in files:
        img = os.path.join(root, f)
        path = os.path.splitext(img)[0] + '.json'
        try:
            if os.path.exists(path):
                with open(path, encoding='utf-8-sig') as fh:
                    obj = json.load(fh)
                if not isinstance(obj, dict) or not isinstance(obj.get('items'), list):
                    n['skipped'] += 1  # not a MOSS schema: left untouched
                    continue
                key = 'updated'
            else:
                from PIL import Image  # needed for the dimensions of new JSONs
                with Image.open(img) as im:
                    w, h = im.size
                obj = {'width': w, 'height': h, 'bbox_coord_space': 'abs', 'bbox_format': 'xyxy',
                       'summary': {'canvas': 'single', 'meta': [], 'palette': [], 'caption': ''}, 'items': []}
                key = 'created'
            if not isinstance(obj.get('summary'), dict):
                obj['summary'] = {}
            obj['summary']['meta'] = meta
            write_json(path, obj)
            n[key] += 1
        except Exception:
            n['skipped'] += 1
    return jsonify(n)


def clear_thumbs():
    shutil.rmtree(THUMB_DIR, ignore_errors=True)


@app.get('/')
def index():
    return send_from_directory(BASE, 'index.html')


@app.get('/<path:name>')
def static_files(name):
    if '/' in name or '\\' in name or os.path.splitext(name)[1] not in STATIC_EXT:
        abort(404)
    return send_from_directory(BASE, name)


if __name__ == '__main__':
    clear_thumbs()  # also removes leftovers from a previous crash
    atexit.register(clear_thumbs)
    for sig in ('SIGTERM', 'SIGBREAK'):  # SIGBREAK = Ctrl+Break on Windows
        if hasattr(signal, sig):
            signal.signal(getattr(signal, sig), lambda *_: sys.exit(0))
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5000)
    port = ap.parse_args().port
    url = f'http://127.0.0.1:{port}'
    print(f'MOSS-BBox-Editor running at {url}  (Ctrl+C to stop)')
    app.run('127.0.0.1', port, threaded=True)
