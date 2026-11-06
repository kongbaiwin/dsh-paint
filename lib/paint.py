#!/usr/bin/env python3
"""dsh-paint 渲染核心：图片 → 矢量 SVG → PNG（纯 CPU，不联网）

由插件进程调用，参数全部显式传入；进度写到 --prog 指定的文件（dsh-lamp 可读）。
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
VENDOR = HERE.parent / "vendor"


def build_parser():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="输入图片")
    ap.add_argument("--out", required=True, help="输出 PNG")
    ap.add_argument("--svg", required=True, help="输出 SVG")
    ap.add_argument("--size", type=int, default=2048, help="输出长边像素")
    ap.add_argument("--trace", type=int, default=0, help="描摹分辨率，0=与 size 相同")
    ap.add_argument("--ss", type=int, default=2, help="超采样倍数（2=抗锯齿）")
    ap.add_argument("--speckle", type=int, default=1, help="过滤小于该面积的碎块")
    ap.add_argument("--layer-diff", type=int, default=2, help="颜色分层阈值，越小越还原")
    ap.add_argument("--precision", type=int, default=8, help="每通道位数 1-8")
    ap.add_argument("--corner", type=int, default=80, help="拐角判定阈值")
    ap.add_argument("--crop", action="store_true", help="居中裁成正方形（默认保留原比例）")
    ap.add_argument("--label", default="矢量化")
    ap.add_argument("--prog", default="", help="进度文件（JSON，dsh-lamp 兼容）")
    ap.add_argument("--ctl", default="", help="控制文件（pause / resume / stop）")
    return ap


def main():
    args = build_parser().parse_args()

    # 优先用插件自带的 vtracer；没有就退回环境里的
    if VENDOR.exists():
        sys.path.insert(0, str(VENDOR))
    try:
        import vtracer
    except Exception as exc:  # noqa: BLE001
        _write(args.prog, running=False, error=f"缺少 vtracer：{exc}", done=0, total=100,
               label=args.label, updated=time.strftime("%H:%M:%S"))
        print(f"缺少 vtracer：{exc}", file=sys.stderr)
        return 2

    prog = Path(args.prog) if args.prog else None
    ctl = Path(args.ctl) if args.ctl else None
    start_ms = int(time.time() * 1000)
    t0 = time.time()

    def tick(pct, note=""):
        el = time.time() - t0
        eta = (el / pct * (100 - pct)) if pct >= 60 else 0
        _write(prog, running=True, paused=False, label=args.label, done=pct, total=100,
               elapsed=round(el, 1), eta=round(eta, 1), note=note,
               updated=time.strftime("%H:%M:%S"))

    def control():
        if not ctl or not ctl.exists():
            return None
        try:
            j = json.loads(ctl.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None
        at = j.get("at")
        if isinstance(at, (int, float)) and at < start_ms:
            return None          # 上一轮残留的指令，忽略
        return j.get("action")

    # ── 1. 读入 ──
    src = Image.open(args.src).convert("RGB")
    w, h = src.size
    if args.crop:
        side = min(w, h)
        src = src.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
        w, h = src.size
    # 中间文件放进度文件旁边，不污染画库
    tmp_base = Path(args.prog).parent if args.prog else Path(args.svg).parent
    tmp = tmp_base / "_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    src_png = tmp / "input.png"
    src.save(src_png)
    tick(10, "准备输入")

    # ── 2. 上采样 ──
    trace = args.trace if args.trace > 0 else args.size
    tw = trace if w >= h else max(1, int(round(trace * w / h)))
    th = trace if h >= w else max(1, int(round(trace * h / w)))
    big = src.resize((tw, th), Image.LANCZOS)
    big_png = tmp / "big.png"
    big.save(big_png)
    tick(20, "上采样")

    # ── 3. 矢量化 ──
    svg_path = Path(args.svg)
    svg_path.parent.mkdir(parents=True, exist_ok=True)
    vtracer.convert_image_to_svg_py(
        str(big_png), str(svg_path),
        colormode="color", hierarchical="stacked", mode="spline",
        filter_speckle=args.speckle, color_precision=args.precision,
        layer_difference=args.layer_diff, corner_threshold=args.corner,
        length_threshold=4.0, max_iterations=10, splice_threshold=45,
        path_precision=3,
    )
    tick(45, "矢量化完成")

    # ── 4. 解析 ──
    text = svg_path.read_text(encoding="utf-8")
    m = re.search(r'viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)"', text)
    if m:
        vw, vh = float(m.group(3)), float(m.group(4))
    else:
        wm = re.search(r'width="([\d.]+)', text)
        hm = re.search(r'height="([\d.]+)', text)
        vw, vh = (float(wm.group(1)), float(hm.group(1))) if wm and hm else (512.0, 512.0)

    scale = (args.size * args.ss) / max(vw, vh)
    out_w = max(1, int(round(vw * scale)))
    out_h = max(1, int(round(vh * scale)))
    img = Image.new("RGB", (out_w, out_h), "white")
    draw = ImageDraw.Draw(img)

    shapes = []
    for tag in re.findall(r"<path\b[^>]*/?>", text):
        dm = re.search(r'd="([^"]+)"', tag)
        fm = re.search(r'fill="([^"]*)"', tag)
        tm = re.search(r'transform="translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)"', tag)
        if not dm:
            continue
        ox, oy = (float(tm.group(1)), float(tm.group(2))) if tm else (0.0, 0.0)
        shapes.append((dm.group(1), fm.group(1) if fm else None, ox, oy))
    tick(55, f"解析 {len(shapes)} 个形状")

    # ── 5. 渲染（支持暂停/停止）──
    stopped = False
    total = max(1, len(shapes))
    for i, (dstr, fill, ox, oy) in enumerate(shapes):
        if i % 40 == 0:
            act = control()
            if act == "stop":
                stopped = True
                break
            if act == "pause":
                _write(prog, running=True, paused=True, label=args.label,
                       done=int(55 + 45 * i / total), total=100,
                       elapsed=round(time.time() - t0, 1), updated=time.strftime("%H:%M:%S"))
                while control() == "pause":
                    time.sleep(0.3)
                if control() == "stop":
                    stopped = True
                    break
            tick(int(55 + 45 * i / total), f"渲染 {i}/{total}")
        if not fill or fill == "none":
            continue
        try:
            subs = parse_path(dstr)
        except Exception:  # noqa: BLE001
            continue
        for pts in subs:
            if len(pts) < 3:
                continue
            poly = [((x + ox) * scale, (y + oy) * scale) for x, y in pts]
            try:
                draw.polygon(poly, fill=fill)
            except Exception:  # noqa: BLE001
                pass

    if args.ss > 1:
        img = img.resize((
            args.size if out_w >= out_h else max(1, int(round(args.size * out_w / out_h))),
            args.size if out_h >= out_w else max(1, int(round(args.size * out_h / out_w))),
        ), Image.LANCZOS)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    elapsed = time.time() - t0
    _write(prog, running=False, paused=False, stopped=stopped, label=args.label, done=100,
           total=100, elapsed=round(elapsed, 1), eta=0, updated=time.strftime("%H:%M:%S"))
    print(json.dumps({
        "ok": not stopped, "stopped": stopped, "shapes": len(shapes),
        "width": img.size[0], "height": img.size[1],
        "seconds": round(elapsed, 1), "png": str(out), "svg": str(svg_path),
    }, ensure_ascii=False))
    return 0


def _write(prog, **kw):
    if not prog:
        return
    try:
        Path(prog).write_text(json.dumps(kw, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def flatten(p0, p1, p2, p3, n=8):
    out = []
    for i in range(1, n + 1):
        t = i / n
        mt = 1 - t
        out.append((
            mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
            mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1],
        ))
    return out


def parse_path(dstr):
    toks = re.findall(r"([MmLlHhVvCcQqZz])|(-?\d*\.?\d+(?:e-?\d+)?)", dstr)
    seq, cur = [], []
    for c, n in toks:
        if c:
            if cur:
                seq.append((cur[0], cur[1:]))
            cur = [c]
        else:
            cur.append(float(n))
    if cur:
        seq.append((cur[0], cur[1:]))

    subs, pts = [], []
    cx = cy = sx = sy = 0.0
    for cmd, a in seq:
        rel = cmd.islower()
        C = cmd.upper()
        if C == "M":
            for j in range(0, len(a) - 1, 2):
                x, y = a[j], a[j + 1]
                if rel:
                    x += cx
                    y += cy
                if j == 0:
                    if pts:
                        subs.append(pts)
                    pts = [(x, y)]
                    sx, sy = x, y
                else:
                    pts.append((x, y))
                cx, cy = x, y
        elif C == "L":
            for j in range(0, len(a) - 1, 2):
                x, y = a[j], a[j + 1]
                if rel:
                    x += cx
                    y += cy
                pts.append((x, y))
                cx, cy = x, y
        elif C == "H":
            for v in a:
                x = v + (cx if rel else 0)
                pts.append((x, cy))
                cx = x
        elif C == "V":
            for v in a:
                y = v + (cy if rel else 0)
                pts.append((cx, y))
                cy = y
        elif C == "C":
            for j in range(0, len(a) - 5, 6):
                x1, y1, x2, y2, x3, y3 = a[j:j + 6]
                if rel:
                    x1 += cx; y1 += cy; x2 += cx; y2 += cy; x3 += cx; y3 += cy
                pts.extend(flatten((cx, cy), (x1, y1), (x2, y2), (x3, y3)))
                cx, cy = x3, y3
        elif C == "Q":
            for j in range(0, len(a) - 3, 4):
                x1, y1, x2, y2 = a[j:j + 4]
                if rel:
                    x1 += cx; y1 += cy; x2 += cx; y2 += cy
                c1 = (cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy))
                c2 = (x2 + 2 / 3 * (x1 - x2), y2 + 2 / 3 * (y1 - y2))
                pts.extend(flatten((cx, cy), c1, c2, (x2, y2)))
                cx, cy = x2, y2
        elif C == "Z":
            if pts:
                pts.append((sx, sy))
                subs.append(pts)
                pts = []
            cx, cy = sx, sy
    if pts:
        subs.append(pts)
    return subs


if __name__ == "__main__":
    raise SystemExit(main())
