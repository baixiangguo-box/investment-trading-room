from pathlib import Path
from PIL import Image, ImageDraw

root=Path(__file__).resolve().parents[1]
image=Image.new('RGBA',(1024,1024),(0,0,0,0))
d=ImageDraw.Draw(image)
d.rounded_rectangle((32,32,992,992),radius=230,fill='#246b58')
d.line([(237,745),(237,660),(420,535),(574,598),(801,319)],fill='#fff',width=45,joint='curve')
d.line([(801,319),(687,319)],fill='#fff',width=45)
d.line([(801,319),(801,433)],fill='#fff',width=45)
for x,y0,y1 in [(345,645,801),(519,686,801),(692,558,801)]:
    d.rounded_rectangle((x-34,y0,x+34,y1),radius=14,fill='#fff')
image.save(root/'assets/app.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.save(root/'assets/app.png')
image.save(root/'assets/app.icns', sizes=[(16,16),(32,32),(64,64),(128,128),(256,256),(512,512),(1024,1024)])
print('Application icon created.')
