# Draws the SynthScope app icons. Run: pip install pillow && python scripts/make_icons.py
import os
from PIL import Image, ImageDraw
G=(47,191,138,255); R=(239,90,90,255); A=(217,164,65,255); BG=(14,20,24,255)
def draw(size, ring_r, transparent=False):
    img = Image.new('RGBA', (size,size), (0,0,0,0) if transparent else BG); d = ImageDraw.Draw(img)
    c=size/2; r=size*ring_r; lw=max(3,int(size/26))
    d.ellipse([c-r,c-r,c+r,c+r], outline=A, width=lw)
    inner=r*0.62; x0=c-inner; y0=c-inner; span=2*inner; w=span/7
    bars=[(0.12,0.62,0.86,0.52,0.96,G),(0.37,0.40,0.66,0.30,0.76,R),(0.62,0.24,0.50,0.14,0.60,G),(0.87,0.06,0.32,0.00,0.42,G)]
    for fx,bt,bb,wt,wb,col in bars:
        cx=x0+fx*span
        d.line([(cx,y0+wt*span),(cx,y0+wb*span)], fill=col, width=max(2,int(size/90)))
        d.rectangle([cx-w/2,y0+bt*span,cx+w/2,y0+bb*span], fill=col)
    return img
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
for sub in ('www/icons', 'assets'): os.makedirs(os.path.join(root, sub), exist_ok=True)
out = {
  'www/icons/icon-192.png': draw(192,0.42), 'www/icons/icon-512.png': draw(512,0.42),
  'www/icons/maskable-512.png': draw(512,0.32), 'assets/icon-only.png': draw(1024,0.40),
  'assets/icon-foreground.png': draw(1024,0.30,True), 'assets/icon-background.png': Image.new('RGBA',(1024,1024),BG)
}
for p, im in out.items(): im.save(os.path.join(root, p)); print('wrote', p)
