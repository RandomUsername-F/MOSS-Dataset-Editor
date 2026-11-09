"""Runs Ultralytics detection in whichever Python (system or venv) has `ultralytics` installed.
Input (stdin, JSON): {"image": path, "models": [paths], "conf": 0.25}
Output (last stdout line, JSON): {"boxes": [{"label", "conf", "bbox": [x1, y1, x2, y2], "model"}], "size": [w, h]}
"""
import json
import sys


def iou(a, b):
    w = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = w * h
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0


def main():
    req = json.load(sys.stdin)
    classes = req.get('classes')  # open-vocabulary models (YOLO-World) get their keywords before predicting
    if classes:
        from ultralytics import YOLOWorld as Model
    else:
        from ultralytics import YOLO as Model
    found, size = [], [0, 0]
    for mi, path in enumerate(req['models']):
        model = Model(path)
        if classes:
            model.set_classes(classes)
        r = model.predict(req['image'], conf=req['conf'], verbose=bool(req.get('verbose')))[0]
        size = [r.orig_shape[1], r.orig_shape[0]]
        b = r.boxes if r.boxes is not None else getattr(r, 'obb', None)
        if b is None:  # classification / depth / semantic models have no boxes
            continue
        name = path.replace('\\', '/').split('/')[-1]
        for xy, c, k in zip(b.xyxy.tolist(), b.conf.tolist(), b.cls.tolist()):
            found.append({'label': r.names[int(k)], 'conf': round(c, 4), 'bbox': [round(v, 1) for v in xy], 'model': name, 'mi': mi})
    found.sort(key=lambda d: -d['conf'])
    keep = []
    for d in found:  # the same object from several models is kept once (highest confidence)
        if not any(d['label'] == k['label'] and iou(d['bbox'], k['bbox']) > 0.7 for k in keep):
            keep.append(d)
    print(json.dumps({'boxes': keep, 'size': size}))


if __name__ == '__main__':
    main()
