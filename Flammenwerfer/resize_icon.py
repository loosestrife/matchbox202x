import sys
from PIL import Image

src = "/home/user/matchbox202x/Flammenwerfer/fastlane/metadata/android/en-US/images/icon.png"
base_dest = "/home/user/matchbox202x/Flammenwerfer/app/src/main/res"

sizes = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192
}

try:
    img = Image.open(src).convert("RGBA")
    for density, size in sizes.items():
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(f"{base_dest}/mipmap-{density}/ic_launcher.png", "PNG")
        resized.save(f"{base_dest}/mipmap-{density}/ic_launcher_round.png", "PNG")
    print("Icons generated successfully.")
except Exception as e:
    print(f"Error: {e}")
