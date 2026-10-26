from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import os
os.makedirs('out', exist_ok=True)

# --- the mark, 64x64 grid -------------------------------------------------------------
GABLE = "M8 58V30h6v-8h6v-8h6V6h12v8h6v8h6v8h6v28z"
DOOR = "M28 58V47.5a4 4 0 0 1 8 0V58z"
WINDOW_CX, WINDOW_CY, WINDOW_R = 32, 32, 3

def mark_group(fill, holes='evenodd'):
    # One path, door and window as real holes (negative space) via even-odd fill.
    win = f"M{WINDOW_CX-WINDOW_R} {WINDOW_CY}a{WINDOW_R} {WINDOW_R} 0 1 0 {2*WINDOW_R} 0a{WINDOW_R} {WINDOW_R} 0 1 0 {-2*WINDOW_R} 0z"
    return f'<path fill="{fill}" fill-rule="{holes}" d="{GABLE}{DOOR}{win}"/>'

GRAD_LIGHT = ('#8143D7', '#4029D1')   # amethyst-500 -> indigo-600
GRAD_DARK = ("#C4A6FA", "#9A8CFF")    # lighter variants for dark backgrounds

def grad(id_, a, b):
    return f'<defs><linearGradient id="{id_}" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient></defs>'

def svg(w, h, body, vb=None, title='Gilde'):
    vb = vb or f"0 0 {w} {h}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n'

files = {}
files['gilde-mark.svg'] = svg(64, 64, grad('gilde-mark-l', *GRAD_LIGHT) + mark_group('url(#gilde-mark-l)'))
files['gilde-mark-dark.svg'] = svg(64, 64, grad('gilde-mark-d', *GRAD_DARK) + mark_group('url(#gilde-mark-d)'))
files['gilde-mark-mono.svg'] = svg(64, 64, mark_group('currentColor'))

# --- app icon / favicon: white gable on an indigo rounded square -------------------
def app_icon(size=512):
    s = size / 64
    inner = f'<g transform="translate({size*0.17:.2f} {size*0.15:.2f}) scale({s*0.66:.4f})">{mark_group("#FFFFFF")}</g>'
    bg = f'<defs><linearGradient id="gilde-icon-{size}" x1="0" y1="0" x2="{size}" y2="{size}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{GRAD_LIGHT[0]}"/><stop offset="1" stop-color="{GRAD_LIGHT[1]}"/></linearGradient></defs>'
    return svg(size, size, bg + f'<rect width="{size}" height="{size}" rx="{size*0.22:.1f}" fill="url(#gilde-icon-{size})"/>' + inner)
files['gilde-app-icon.svg'] = app_icon(512)
files['favicon.svg'] = app_icon(64)

# --- wordmark: "Gilde" in Figtree SemiBold, outlined ----------------------------------
font = TTFont('fonts/package/files/figtree-latin-600-normal.woff')
gs = font.getGlyphSet(); cmap = font.getBestCmap(); upm = font['head'].unitsPerEm
hmtx = font['hmtx']
def text_path(text, size, x0, baseline, tracking=-0.01):
    scale = size / upm; x = x0; d = []
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[gname].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        d.append(pen.getCommands())
        x += hmtx[gname][0] * scale + tracking * size
    return ' '.join(d), x

def lockup(mark_fill_defs, mark_fill, text_fill):
    # mark 64 high, text cap height aligned to the gable body
    d, end = text_path('Gilde', 40, 76, 50)
    w = int(end + 6)
    body = mark_fill_defs + mark_group(mark_fill) + f'<path fill="{text_fill}" d="{d}"/>'
    return svg(w, 64, body)
files['gilde-logo.svg'] = lockup(grad('gilde-logo-l', *GRAD_LIGHT), 'url(#gilde-logo-l)', '#171327')       # neutral-900 light
files['gilde-logo-dark.svg'] = lockup(grad('gilde-logo-d', *GRAD_DARK), 'url(#gilde-logo-d)', '#F3F2F8')   # neutral-900 dark
files['gilde-logo-mono.svg'] = lockup('', 'currentColor', 'currentColor')

for name, content in files.items():
    open(f'out/{name}', 'w').write(content)
print('\n'.join(f'{n} {len(c)}B' for n, c in files.items()))
