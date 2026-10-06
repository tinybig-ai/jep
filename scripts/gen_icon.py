from PIL import Image, ImageDraw, ImageFilter
import math

BODY = [
    ((9,5.6), (10.6,4.2), (14.2,3.9), (15.6,6.4)),
    (None,     (16.9,8.8), (16.2,12.6),(14.2,14.9)),
    (None,     (12.9,16.4),(11.4,16.9),(10.3,16.2)),
    (None,     (9.5,15.8), (8.5,15.8), (7.7,16.2)),
    (None,     (6.6,16.9), (5.1,16.4), (3.8,14.9)),
    (None,     (1.8,12.6), (1.1,8.8),  (2.4,6.4)),
    (None,     (3.8,3.9),  (7.4,4.2),  (9,5.6)),
]
def chunkify(p):
    x,y = p
    x = 9 + (x-9)*1.22
    y = 9.2 + (y-9.2)*1.04
    if abs(x-9) < 0.15 and y < 9.2:
        y += 0.55
    return (x,y)

def cubic(p0,p1,p2,p3,n=24):
    pts=[]
    for i in range(n+1):
        t=i/n
        x=(1-t)**3*p0[0]+3*(1-t)**2*t*p1[0]+3*(1-t)*t*t*p2[0]+t**3*p3[0]
        y=(1-t)**3*p0[1]+3*(1-t)**2*t*p1[1]+3*(1-t)*t*t*p2[1]+t**3*p3[1]
        pts.append((x,y))
    return pts

def _poly(segs):
    pts=[]
    cur=chunkify(segs[0][0]); start=cur
    for _,c1,c2,to in segs:
        c1,c2,to = chunkify(c1),chunkify(c2),chunkify(to)
        sp = cubic(cur,c1,c2,to)
        pts.extend(sp[:-1]); cur=to
    pts.append(start)
    return pts

LEAF = [
    ((10.2,3.8),(10.9,1.8),(12.9,1.0),(14.2,1.3)),
    (None,      (13.6,3.0),(12.0,4.1),(10.2,3.8)),
]
STEM_A = chunkify((9.15,5.5)); STEM_B = (9.55,1.9)

def draw_apple(S, apple_scale=0.54, with_shadow=True, lighter=True):
    im = Image.new('RGBA',(S,S),(0,0,0,0))
    # chunkify() pushes the shape past the 18-unit space it was drawn in, so
    # fit the glyph's real bounds inside apple_scale of the canvas instead of
    # assuming it spans 18 — anything larger than its bbox used to clip
    raw_body=_poly(BODY); raw_leaf=_poly(LEAF)
    pts_all=raw_body+raw_leaf+[STEM_A,STEM_B]
    xs=[p[0] for p in pts_all]; ys=[p[1] for p in pts_all]
    x0,x1=min(xs),max(xs); y0,y1=min(ys),max(ys)
    k=min(S*apple_scale/max(1e-6,(x1-x0)), S*apple_scale/max(1e-6,(y1-y0)))
    def tr(p):
        return (S/2 + (p[0]-(x0+x1)/2)*k, S/2 + (p[1]-(y0+y1)/2)*k)
    body=[tr(p) for p in raw_body]; leaf=[tr(p) for p in raw_leaf]
    sa,sb = tr(STEM_A), tr(STEM_B)
    if with_shadow:
        sh = Image.new('RGBA',(S,S),(0,0,0,0))
        d=ImageDraw.Draw(sh)
        d.polygon(body,fill=(0,0,0,110)); d.polygon(leaf,fill=(0,0,0,110))
        d.line([sa,sb],fill=(0,0,0,110),width=int(S*0.045))
        sh=sh.filter(ImageFilter.GaussianBlur(S*0.02))
        off=Image.new('RGBA',(S,S),(0,0,0,0)); off.alpha_composite(sh,(0,int(S*0.012)))
        im.alpha_composite(off)
    mask=Image.new('L',(S,S),0); md=ImageDraw.Draw(mask)
    md.polygon(body,fill=255); md.polygon(leaf,fill=255)
    md.line([sa,sb],fill=255,width=int(S*0.045))
    grad=Image.new('RGBA',(S,S)); gd=ImageDraw.Draw(grad)
    if lighter:
        top=(246,102,118); mid=(228,58,80); bot=(196,36,56)
    else:
        top=(232,48,72); mid=(186,22,50); bot=(110,6,26)
    ys=[p[1] for p in body]+[sb[1]]; y0,y1=min(ys),max(ys)
    for yy in range(S):
        t=(yy-y0)/max(1,(y1-y0))
        if t<0.45: u=t/0.45; c=tuple(int(top[i]+(mid[i]-top[i])*u) for i in range(3))
        else: u=(t-0.45)/0.55; c=tuple(int(mid[i]+(bot[i]-mid[i])*u) for i in range(3))
        gd.line([(0,yy),(S,yy)],fill=c+(255,))
    im.alpha_composite(Image.composite(grad,Image.new('RGBA',(S,S),(0,0,0,0)),mask))
    sh=Image.new('RGBA',(S,S),(0,0,0,0)); sd=ImageDraw.Draw(sh)
    cx,cy=S*0.40,S*0.30
    sd.ellipse([cx-S*0.22,cy-S*0.20,cx+S*0.22,cy+S*0.16],fill=(255,255,255,60))
    sh=sh.filter(ImageFilter.GaussianBlur(S*0.05))
    im.alpha_composite(Image.composite(sh,Image.new('RGBA',(S,S),(0,0,0,0)),mask))
    return im

def tile(S, round_ratio=None, circle=False):
    im=Image.new('RGBA',(S,S),(0,0,0,0))
    grad=Image.new('RGBA',(S,S)); gd=ImageDraw.Draw(grad)
    for yy in range(S):
        t=yy/S
        r=int(0x1F+(0x0A-0x1F)*t); g=r; b=int(0x20+(0x0B-0x20)*t)
        gd.line([(0,yy),(S,yy)],fill=(r,g,b,255))
    mask=Image.new('L',(S,S),0); md=ImageDraw.Draw(mask)
    if circle: md.ellipse([0,0,S,S],fill=255)
    elif round_ratio: md.rounded_rectangle([0,0,S-1,S-1],radius=S*round_ratio,fill=255)
    else: md.rectangle([0,0,S,S],fill=255)
    im.paste(grad,(0,0),mask)
    edge=Image.new('RGBA',(S,S),(0,0,0,0)); ed=ImageDraw.Draw(edge)
    w=max(1,S//256)
    if circle: ed.ellipse([1,1,S-2,S-2],outline=(255,255,255,26),width=w)
    elif round_ratio: ed.rounded_rectangle([1,1,S-2,S-2],radius=S*round_ratio,outline=(255,255,255,26),width=w)
    else: ed.rectangle([0,0,S-1,S-1],outline=(255,255,255,22),width=w)
    edge=edge.filter(ImageFilter.GaussianBlur(S*0.004))
    im.alpha_composite(edge)
    return im

def _fit24():
    # map the glyph's real bounds onto a 24-unit viewport at 70% fill,
    # centered — same fit the raster path uses
    pts_all=_poly(BODY)+_poly(LEAF)+[STEM_A,STEM_B]
    xs=[p[0] for p in pts_all]; ys=[p[1] for p in pts_all]
    x0,x1=min(xs),max(xs); y0,y1=min(ys),max(ys)
    k=min(24*0.70/(x1-x0), 24*0.70/(y1-y0))
    def f(p): return (12+(p[0]-(x0+x1)/2)*k, 12+(p[1]-(y0+y1)/2)*k)
    return f, (f((x0,y0))[1], f((x0,y1))[1])

def _path(segs, f):
    cur=f(chunkify(segs[0][0]))
    out=[f'M {cur[0]:.2f},{cur[1]:.2f}']
    for _,c1,c2,to in segs:
        c1,c2,to=f(chunkify(c1)),f(chunkify(c2)),f(chunkify(to))
        out.append(f'C {c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} {to[0]:.2f},{to[1]:.2f}')
    out.append('Z')
    return ' '.join(out)

def write_jep_mark_kt(path_out):
    # the same glyph as a Compose ImageVector — XML vector gradients don't
    # survive Compose's compat parser, so the mark is emitted as Kotlin
    f,(gy0,gy1) = _fit24()
    sa,sb=f(STEM_A),f(STEM_B)
    kt=f'''package dev.jep.client.presentation.theme

// GENERATED by scripts/gen_icon.py — edit the source bezier there.
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

private const val MARK_BODY = "{_path(BODY,f)}"
private const val MARK_LEAF = "{_path(LEAF,f)}"

val JepMark: ImageVector = ImageVector.Builder(
    name = "JepMark",
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {{
    val paint = Brush.linearGradient(
        0f to Color(0xFFF66676),
        0.45f to Color(0xFFE43A50),
        1f to Color(0xFFC42438),
        start = Offset(0f, {gy0:.2f}f),
        end = Offset(0f, {gy1:.2f}f),
    )
    addPath(addPathNodes(MARK_BODY), fill = paint)
    addPath(addPathNodes(MARK_LEAF), fill = paint)
    addPath(
        addPathNodes("M {sa[0]:.2f},{sa[1]:.2f} L {sb[0]:.2f},{sb[1]:.2f}"),
        stroke = SolidColor(Color(0xFFE95A6E)),
        strokeLineWidth = 1.15f,
        strokeLineCap = StrokeCap.Round,
    )
}}.build()
'''
    with open(path_out,'w') as fh: fh.write(kt)

SS=4
def render(size, mode):
    S=size*SS
    if mode=='fg':
        im=Image.new('RGBA',(S,S),(0,0,0,0))
        im.alpha_composite(draw_apple(S,apple_scale=0.62))
    elif mode=='mark':
        im=Image.new('RGBA',(S,S),(0,0,0,0))
        # the mark renders small — a soft shadow reads as dithered noise
        # at 20px, so it gets hard edges only
        im.alpha_composite(draw_apple(S,apple_scale=0.70,with_shadow=False))
    elif mode=='bg':
        im=tile(S)
    else:
        rr={'square':0.235,'round':None,'ios':None}[mode]
        circle=(mode=='round'); full=(mode=='ios')
        im=tile(S,round_ratio=None if (circle or full) else rr,circle=circle)
        im.alpha_composite(draw_apple(S,apple_scale=0.44))
    return im.resize((size,size),Image.LANCZOS)


if __name__ == '__main__':
    import os
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    res = os.path.join(here, 'android/app/src/main/res')
    # the in-app mark is a vector — a 512px raster crushed to ~24px stays jaggy
    write_jep_mark_kt(os.path.join(
        here, 'android/app/src/main/kotlin/dev/jep/client/presentation/theme/JepMark.kt'))
    for d, s in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        render(s, 'square').save(os.path.join(res, f'mipmap-{d}/ic_launcher.png'))
        render(s, 'round').save(os.path.join(res, f'mipmap-{d}/ic_launcher_round.png'))
        render(s * 108 // 48, 'fg').save(os.path.join(res, f'mipmap-{d}/ic_launcher_foreground.png'))
        render(s * 108 // 48, 'bg').save(os.path.join(res, f'mipmap-{d}/ic_launcher_background.png'))
    render(1024, 'ios').save(os.path.join(
        here, 'ios/Jep/Jep/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png'))
    print('icon assets written')
